#!/usr/bin/env python3
"""Simulator native record/crypto/actor suite with explicit in-memory storage ports; no hardware storage claim."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('native_signer_runner', HERE / 'run.py')
native = importlib.util.module_from_spec(spec); spec.loader.exec_module(native)
EXTRA = [
    'tests/native/signer-core/ios/App/NativeHandoffProbeController.swift',
    'modules/identity-owner/ios/IdentityOwnerContextRegistry.swift',
    'modules/napplet-host/ios/FixtureReleaseAuthority.swift',
    'tests/native/signer-core/ios/App/NativeHostTestPorts.swift',
    'modules/signer-core/ios/NativeVaultKey.swift',
    'modules/signer-core/ios/NativeNip46Protocol.swift',
    'modules/signer-core/ios/NativeNip46Client.swift',
    'modules/signer-core/ios/NativeVaultRemotePanel.swift',
    'modules/napplet-host/ios/NativeSignerRelayTransport.swift',
    'modules/napplet-host/ios/PublishedRelayWebSocketQuery.swift',
    'modules/napplet-host/ios/PublishedRelayWebSocketFrames.swift',
    'modules/napplet-host/ios/PublishedRelayWebSocketHandshake.swift',
    'modules/napplet-host/ios/PublishedRelayEnvelope.swift',
    'modules/napplet-host/ios/PublishedPinnedHTTPS.swift',
    'modules/napplet-host/ios/PublishedHTTPResponse.swift',
    'modules/napplet-host/ios/PublicAddressPolicy.swift',
    'modules/napplet-host/ios/NativeUploadAuthority.swift',
    'modules/napplet-host/ios/UploadFileProfile.swift',
    'modules/napplet-host/ios/UploadPngMetadata.swift',
    'modules/napplet-host/ios/UploadPngProfile.swift',
    'modules/signer-core/ios/NativeVaultMutationGate.swift',
    'modules/signer-core/ios/NativeVaultRecord.swift',
    'modules/signer-core/ios/NativeVaultCore.swift',
    'modules/signer-core/ios/NativeVaultImportPanel.swift',
    'modules/napplet-host/ios/NativeSignerRelayPolicy.swift',
    'modules/napplet-host/ios/NativeApprovalAuthority.swift',
    'modules/napplet-host/ios/CapabilityLeaseRegistry.swift',
    'modules/napplet-host/ios/CapabilityTransport.swift',
    'modules/napplet-host/ios/ApprovalTransport.swift',
    'modules/napplet-host/ios/NativeOutboxPlan.swift',
    'modules/napplet-host/ios/PublishedRelayWebSocketClientFrames.swift',
    'modules/identity-store/ios/Contracts.swift',
    'modules/identity-store/ios/SystemKeychain.swift',
    'modules/identity-store/ios/ExcludedAtomicFiles.swift',
    'modules/identity-store/ios/IdentityStoreAvailability.swift',
    'modules/identity-store/ios/NativeSignerVaultStorage.swift',
    'modules/identity-store/ios/NostrSecretBech32.swift',
]
native.SOURCES += EXTRA
native.BUNDLE = 'org.nostrocket.hypergolic.vaultprobe'

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True); parser.add_argument('--udid')
    args = parser.parse_args(); output = args.output.resolve(); output.mkdir(parents=True, exist_ok=False)
    env = dict(os.environ, DEVELOPER_DIR=os.environ.get('DEVELOPER_DIR', '/Applications/Xcode.app/Contents/Developer'))
    devices = json.loads(subprocess.check_output(['xcrun', 'simctl', 'list', 'devices', 'booted', '-j'], env=env))
    booted = [x['udid'] for xs in devices['devices'].values() for x in xs if x['state'] == 'Booted']
    args.udid = args.udid or (booted[0] if len(booted) == 1 else None)
    if not args.udid or args.udid not in booted: raise RuntimeError('One explicit booted Simulator required')
    inventory = set(native.apps(env, args.udid)); owned = [native.BUNDLE, native.BUNDLE + '.ui.xctrunner']
    if any(x in inventory for x in owned): raise RuntimeError('Reconcile existing owned probe IDs first')
    before = native.inputs(); project = native.project(output)
    path = project / 'project.pbxproj'
    path.write_text(path.read_text().replace(str(HERE / 'Tests/SignerCoreTests.swift'), str(HERE / 'Tests/VaultPersistenceTests.swift')))
    common = ['-project', str(project), '-scheme', 'SignerProbe', '-configuration', 'Debug', '-destination',
        'platform=iOS Simulator,id=' + args.udid, '-derivedDataPath', str(output / 'derived'), 'CODE_SIGNING_ALLOWED=NO']
    report = {'passed': False, 'environment': 'iOS Simulator', 'udid': args.udid, 'owningSources': before,
        'storageProof': 'Real native encrypted record and crypto with explicit in-memory Keychain/files and unused fail-closed external host service ports; production authority mutation gate is exact; production availability remains false on Simulator.'}
    try:
        build = ['xcodebuild', 'build-for-testing'] + common
        native.run(build, env, output / 'build.log'); report['buildCommand'] = build
        products = output / 'derived/Build/Products/Debug-iphonesimulator'
        subprocess.run(['xcrun', 'simctl', 'install', args.udid, str(products / 'SignerProbe.app')], env=env, check=True, capture_output=True)
        subprocess.run(['xcrun', 'simctl', 'launch', args.udid, native.BUNDLE], env=env, check=True, capture_output=True)
        subprocess.run(['xcrun', 'simctl', 'terminate', args.udid, native.BUNDLE], env=env, check=True, capture_output=True)
        command = ['xcodebuild', 'test-without-building'] + common + ['-only-testing:SignerCoreTests',
            '-parallel-testing-enabled', 'NO', '-resultBundlePath', str(output / 'Tests.xcresult')]
        report['command'] = command; native.run(command, env, output / 'test.log')
        summary = json.loads(subprocess.check_output(['xcrun', 'xcresulttool', 'get', 'test-results', 'summary', '--path', str(output / 'Tests.xcresult')], env=env))
        (output / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
        expected = len(re.findall(r'func test\w+\(', (HERE / 'Tests/VaultPersistenceTests.swift').read_text()))
        if expected <= 0 or summary.get('totalTestCount') != expected or summary.get('passedTests') != expected or summary.get('failedTests') != 0 or summary.get('skippedTests') != 0:
            raise RuntimeError('Every source-owned persistence case must execute and pass')
        counts = re.findall(r'VAULT_PERSISTENCE_ASSERTIONS=(\d+)', (output / 'test.log').read_text())
        assertions = sum(int(value) for value in counts)
        if len(counts) != expected or assertions <= 0: raise RuntimeError('Actual native assertion counts missing')
        container = Path(subprocess.check_output(['xcrun', 'simctl', 'get_app_container', args.udid, native.BUNDLE, 'data'], env=env, text=True).strip())
        public = output / 'signature.json'; shutil.copyfile(container / 'Documents/vault-signature.json', public)
        independent = json.loads(subprocess.check_output(['node', str(HERE / 'verify-public.mjs'), str(native.REPO), str(public)], env=env))
        report['independent'] = independent
        if native.inputs() != before: raise RuntimeError('Owning sources changed during proof')
        report.update(passed=True, cases=expected, assertions=assertions, sourceUnchanged=True)
    finally:
        for bundle in owned:
            subprocess.run(['xcrun', 'simctl', 'terminate', args.udid, bundle], env=env, capture_output=True)
            subprocess.run(['xcrun', 'simctl', 'uninstall', args.udid, bundle], env=env, check=True, capture_output=True)
        remaining = set(native.apps(env, args.udid))
        report['retainedInventoryUnchanged'] = remaining == inventory
        report['ownedAppsRemoved'] = all(x not in remaining for x in owned)
        (output / 'receipt.json').write_text(json.dumps(report, indent=2) + '\n')
    if not report['retainedInventoryUnchanged'] or not report['ownedAppsRemoved']: raise RuntimeError('Disposable cleanup/inventory mismatch')
    print(json.dumps({'passed': report['passed'], 'cases': report['cases'], 'assertions': report['assertions'], 'receipt': str(output / 'receipt.json')}))

if __name__ == '__main__': main()
