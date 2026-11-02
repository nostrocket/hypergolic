#!/usr/bin/env python3
"""Exercise real Expo signer-owner bridge through an explicitly supplied disposable product."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import subprocess
import run as native

BUNDLE = 'org.nostrocket.hypergolic.signercore.bridgeproof'

def product(app):
    return {str(p.relative_to(app)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(app.rglob('*')) if p.is_file()}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, required=True)
    parser.add_argument('--build-receipt', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--udid', required=True)
    parser.add_argument('--boundary-only', action='store_true', help='Diagnostic run of the public configuration/preflight case only')
    args = parser.parse_args()
    app, output = args.app.resolve(), args.output.resolve()
    expected_cases = 1 if args.boundary_only else 4
    if plistlib.loads((app / 'Info.plist').read_bytes()).get('CFBundleIdentifier') != BUNDLE:
        raise RuntimeError('Only the agreed disposable Expo bundle may be installed')
    seal = json.loads(args.build_receipt.read_text())
    source_before, source_after = seal['sourceHashesBefore'], seal['sourceHashesAfter']
    required = {'index.signer.fixture.tsx', 'src/security/native-signer-core.ts', 'src/shell/NativeSignerCheck.tsx',
        'modules/signer-core/ios/HypergolicSignerCoreModule.swift', 'modules/signer-core/ios/NativeSignerCore.swift',
        'modules/identity-owner/ios/NativeIdentityOwnerContext.swift', 'ios/Podfile.lock', 'tests/native/securestore-config/NativeBoundaryCheck.tsx',
        'modules/signer-core/ios/NativeVaultSession.swift', 'modules/identity-store/ios/NativeSignerVaultStorage.swift',
        'node_modules/expo-secure-store/ios/SecureStoreModule.swift'}
    if seal.get('buildExitCode') != 0 or seal.get('sourceHashesUnchanged') is not True or source_before != source_after or not required.issubset(source_before):
        raise RuntimeError('Need a successful exact integration source/product build seal')
    for name, expected in source_before.items():
        path = native.REPO / name
        if not path.resolve().is_relative_to(native.REPO) or not path.is_file() or native.digest(path) != expected:
            raise RuntimeError('Sealed build input changed: ' + name)
    if product(app) != seal['appHashes']: raise RuntimeError('Supplied Expo product does not match its source-sealed build')
    signing = seal.get('simulatorSigning')
    if signing:
        expected = {'application-identifier': BUNDLE, 'keychain-access-groups': [BUNDLE], 'get-task-allow': True}
        actual = plistlib.loads(subprocess.check_output(['codesign', '-d', '--entitlements', '-', '--xml', str(app)], stderr=subprocess.DEVNULL))
        if signing.get('entitlements') != expected or actual != expected:
            raise RuntimeError('Only the disposable Simulator app may receive its own exact Keychain group')
        subprocess.run(['codesign', '--verify', '--strict', str(app)], check=True, capture_output=True)
        if not seal.get('appHashesBeforeSigning'): raise RuntimeError('Need actual pre-sign compiled product binding')
    output.mkdir(parents=True, exist_ok=False)
    environment = dict(os.environ, DEVELOPER_DIR=os.environ.get('DEVELOPER_DIR', '/Applications/Xcode.app/Contents/Developer'))
    inventory = set(native.apps(environment, args.udid))
    owned = [BUNDLE, native.BUNDLE, native.BUNDLE + '.ui.xctrunner']
    if any(bundle in inventory for bundle in owned): raise RuntimeError('Existing owned app IDs require reconciliation before this batch')
    source = native.inputs(); built = product(app)
    proj = native.project(output, bridge=True)
    report = {'passed': False, 'environment': 'iOS Simulator actual Expo AppContext/Module/UIKit', 'sources': source,
        'appInputs': built, 'buildReceiptSha256': native.digest(args.build_receipt), 'buildSourceHashes': source_before, 'bundleId': BUNDLE, 'udid': args.udid}
    try:
        subprocess.run(['xcrun', 'simctl', 'install', args.udid, str(app)], env=environment, check=True, capture_output=True)
        command = ['xcodebuild', 'test', '-project', str(proj), '-scheme', 'SignerProbe', '-configuration', 'Debug',
            '-destination', 'platform=iOS Simulator,id=' + args.udid, '-derivedDataPath', str(output / 'derived'),
            '-parallel-testing-enabled', 'NO', '-resultBundlePath', str(output / 'Tests.xcresult'), 'CODE_SIGNING_ALLOWED=NO']
        if args.boundary_only: command.append('-only-testing:SignerUITests/BridgeSignerUITests/testActualVaultPreflightAndRetiredSecureStoreBoundary')
        report['command'] = command
        native.run(command, environment, output / 'test.log')
        summary = json.loads(subprocess.check_output(['xcrun', 'xcresulttool', 'get', 'test-results', 'summary', '--path', str(output / 'Tests.xcresult')], env=environment, text=True))
        (output / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
        if summary.get('totalTestCount') != expected_cases or summary.get('passedTests') != expected_cases or summary.get('failedTests') != 0 or summary.get('skippedTests') != 0:
            raise RuntimeError('Expected all4 actual bridge touch cases; skipped/empty coverage fails')
        if native.inputs() != source or product(app) != built or any(native.digest(native.REPO / name) != expected for name, expected in source_before.items()): raise RuntimeError('Owning sources or supplied product changed during trace')
        report.update(passed=True, cases=expected_cases, sourceUnchanged=True, appUnchanged=True,
            independentVerifier=('Actual native configuration/preflight public APIs' if args.boundary_only else 'Actual shared runNativeSignerCheck/validateSignedEvent using nostr-tools'),
            diagnosticBoundaryOnly=args.boundary_only,
            journeys=['approval + repeat activation/review', 'reject + unmount/remount + approve', 'background cancellation + explicit reactivation + approve', 'native availability false +25 retired export denials +config roundtrips'])
        subprocess.run(['xcrun', 'xcresulttool', 'export', 'attachments', '--path', str(output / 'Tests.xcresult'),
            '--output-path', str(output / 'attachments')], env=environment, check=True, capture_output=True)
    finally:
        for bundle in owned:
            subprocess.run(['xcrun', 'simctl', 'terminate', args.udid, bundle], env=environment, capture_output=True)
            subprocess.run(['xcrun', 'simctl', 'uninstall', args.udid, bundle], env=environment, check=True, capture_output=True)
        final = set(native.apps(environment, args.udid))
        report['ownedAppsRemoved'] = all(bundle not in final for bundle in owned)
        report['retainedInventoryUnchanged'] = final == inventory
        (output / 'receipt.json').write_text(json.dumps(report, indent=2) + '\n')
    if not report['ownedAppsRemoved'] or not report['retainedInventoryUnchanged']: raise RuntimeError('App inventory reconciliation failed')
    print(json.dumps({'passed': True, 'cases': expected_cases, 'receipt': str(output / 'receipt.json')}))

if __name__ == '__main__': main()
