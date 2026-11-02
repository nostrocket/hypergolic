#!/usr/bin/env python3
"""Disposable native Safari consent/lifecycle trace with actual native client and controlled WSS peer; no Expo/protected-store/physical claim."""
import argparse
import base64
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('native_persistence', HERE / 'run-persistence.py')
persistence = importlib.util.module_from_spec(spec); spec.loader.exec_module(persistence)
native = persistence.native
native.BUNDLE = 'org.nostrocket.hypergolic.handoffprobe'

def inputs():
    result = native.inputs()
    for path in sorted((native.REPO / 'tests/native/signer-core/nip46').glob('*')):
        if path.is_file(): result[str(path.relative_to(native.REPO))] = native.digest(path)
    result['pnpm-lock.yaml'] = native.digest(native.REPO / 'pnpm-lock.yaml')
    return result

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True); parser.add_argument('--udid'); parser.add_argument('--modern-scene', action='store_true'); parser.add_argument('--case', choices=['testMinimalSafariCloseDelegateDelivery', 'testActualSafariNativeResumeReturnsOneVerifiedSignature', 'testNativeResumeCancellationReturnsNoSignature', 'testOrdinaryBackgroundCancelsSafariAndCannotResumeOldSource'])
    args = parser.parse_args(); output = args.output.resolve(); output.mkdir(parents=True, exist_ok=False)
    env = dict(os.environ, DEVELOPER_DIR=os.environ.get('DEVELOPER_DIR', '/Applications/Xcode.app/Contents/Developer'))
    devices = json.loads(subprocess.check_output(['xcrun', 'simctl', 'list', 'devices', 'booted', '-j'], env=env))
    booted = [x['udid'] for xs in devices['devices'].values() for x in xs if x['state'] == 'Booted']
    args.udid = args.udid or (booted[0] if len(booted) == 1 else None)
    if not args.udid or args.udid not in booted: raise RuntimeError('One explicit booted Simulator required')
    inventory = set(native.apps(env, args.udid)); owned = [native.BUNDLE, native.BUNDLE + '.ui.xctrunner']
    if any(x in inventory for x in owned): raise RuntimeError('Reconcile existing owned probe IDs first')
    before = inputs()
    report = {'passed': False, 'environment': 'iOS Simulator', 'udid': args.udid, 'owningSources': before,
        'proofScope': 'Actual isolated native exact-event review, SFSafariViewController, native Resume, same-ID NIP46/NIP44 over controlled WSS/TLS. HYPERGOLIC_NETWORK_PROOF uses loopback/trust anchor only for relay; Safari uses ordinary public HTTPS, OS trust, and actual foreground/background notifications. Ephemeral C client and isolated actual native source/effect registry. No production vault, Expo owner/route, provider-login or physical acceptance claim.'}
    server = None
    try:
        fixture = output / 'fixture'
        server_command = ['node', str(native.REPO / 'tests/native/signer-core/nip46/server.mjs'), '--output', str(fixture), '--fixture-keys', 'public-vectors']
        server_log = (output / 'fixture.log').open('w'); server = subprocess.Popen(server_command, cwd=native.REPO, env=env, stdout=server_log, stderr=subprocess.STDOUT)
        end = time.monotonic() + 15
        while not (fixture / 'ready.json').exists():
            if server.poll() is not None or time.monotonic() > end: raise RuntimeError('Controlled WSS fixture failed to start')
            time.sleep(0.05)
        ready = json.loads((fixture / 'ready.json').read_text())
        private_config = {key: ready[key] for key in ['relayURL', 'changedRelayURL', 'peerPubkey', 'userPubkey', 'bunkerURL', 'controlURL', 'nonce']}
        private_config['anchor'] = base64.b64encode(Path(ready['der']).read_bytes()).decode()
        resource = output / 'Nip46Fixture.json'; resource.write_text(json.dumps(private_config)); resource.chmod(0o600)
        report['fixtureConfigurationHash'] = native.digest(resource)
        report['peerPubkey'] = ready['peerPubkey']; report['userPubkey'] = ready['userPubkey']; report['proofFlag'] = 'HYPERGOLIC_NETWORK_PROOF'
        project = native.project(output); pbx = project / 'project.pbxproj'
        data = json.loads(subprocess.check_output(['plutil', '-convert', 'json', '-o', '-', str(pbx)]))
        objects = data['objects']
        report['hostWindowModel'] = 'Modern UIWindowScene disposable probe; generated production Expo AppDelegate currently uses legacy UIWindow' if args.modern_scene else 'Legacy UIWindow disposable probe; no Expo host'
        if args.modern_scene:
            for obj in objects.values():
                if obj.get('isa') == 'XCBuildConfiguration' and obj['buildSettings'].get('PRODUCT_BUNDLE_IDENTIFIER') == native.BUNDLE:
                    obj['buildSettings']['INFOPLIST_KEY_UIApplicationSceneManifest_Generation'] = 'YES'
        for obj in objects.values():
            if obj.get('isa') == 'PBXFileReference' and obj.get('path') == str(HERE / 'Tests/SignerUITests.swift'): obj['path'] = str(HERE / 'Tests/HandoffUITests.swift')
            if obj.get('isa') == 'XCBuildConfiguration': obj['buildSettings']['SWIFT_ACTIVE_COMPILATION_CONDITIONS'] = '$(inherited) HYPERGOLIC_NETWORK_PROOF'
        reference, build = 'F00000000000000000000001', 'F00000000000000000000002'
        objects[reference] = {'isa': 'PBXFileReference', 'path': str(resource), 'sourceTree': '<absolute>', 'lastKnownFileType': 'text.json'}
        objects[build] = {'isa': 'PBXBuildFile', 'fileRef': reference}
        app = next(obj for obj in objects.values() if obj.get('isa') == 'PBXNativeTarget' and obj.get('name') == 'SignerProbe')
        phase = next(objects[key] for key in app['buildPhases'] if objects[key]['isa'] == 'PBXResourcesBuildPhase'); phase['files'].append(build)
        pbx.write_text('// !$*UTF8*$!\n' + native.pbx(data) + '\n')
        common = ['-project', str(project), '-scheme', 'SignerProbe', '-configuration', 'Debug', '-destination', 'platform=iOS Simulator,id=' + args.udid,
            '-derivedDataPath', str(output / 'derived'), 'CODE_SIGNING_ALLOWED=NO']
        command = ['xcodebuild', 'build-for-testing'] + common; report['buildCommand'] = command; native.run(command, env, output / 'build.log')
        product = output / 'derived/Build/Products/Debug-iphonesimulator/SignerProbe.app'
        report['appHashes'] = {str(p.relative_to(product)): native.digest(p) for p in sorted(product.rglob('*')) if p.is_file()}
        command = ['xcodebuild', 'test-without-building'] + common + ['-only-testing:SignerUITests' + ('/SignerUITests/' + args.case if args.case else ''), '-parallel-testing-enabled', 'NO', '-resultBundlePath', str(output / 'Tests.xcresult')]
        report['command'] = command; native.run(command, env, output / 'test.log')
        summary = json.loads(subprocess.check_output(['xcrun', 'xcresulttool', 'get', 'test-results', 'summary', '--path', str(output / 'Tests.xcresult')], env=env))
        (output / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
        expected = 1 if args.case else len(re.findall(r'func test\w+\(', (HERE / 'Tests/HandoffUITests.swift').read_text()))
        report['selectedCase'] = args.case
        if expected <= 0 or summary.get('totalTestCount') != expected or summary.get('passedTests') != expected or summary.get('failedTests') != 0 or summary.get('skippedTests') != 0: raise RuntimeError('Every source-owned Safari UI case must execute and pass')
        counts = re.findall(r'HANDOFF_UI_ASSERTIONS=(\d+)', (output / 'test.log').read_text()); assertions = sum(map(int, counts))
        if len(counts) != expected or assertions <= 0: raise RuntimeError('Actual native UI assertion counts missing')
        container = Path(subprocess.check_output(['xcrun', 'simctl', 'get_app_container', args.udid, native.BUNDLE, 'data'], env=env, text=True).strip())
        for name in ['handoff-ui-signature.json', 'handoff-ui-approve.json', 'handoff-ui-cancel.json', 'handoff-ui-background.json', 'native-safari-callbacks.json', 'minimal-safari-callbacks.json']:
            path = container / 'Documents' / name
            if path.is_file(): shutil.copyfile(path, output / name)
        server.terminate(); server.wait(timeout=10); server = None; server_log.close()
        peer = json.loads((fixture / 'receipt.json').read_text()); report['independentPeerReceipt'] = peer
        if args.case:
            report['diagnosticPassed'] = True
            report['diagnosticScope'] = 'One selected native UI case; no all-journey signature acceptance claim'
        else:
            independent = json.loads(subprocess.check_output(['node', str(HERE / 'verify-handoff.mjs'), str(native.REPO), str(output)], env=env))
            report['independent'] = independent
        attachments = output / 'attachments'
        subprocess.run(['xcrun', 'xcresulttool', 'export', 'attachments', '--path', str(output / 'Tests.xcresult'), '--output-path', str(attachments)], env=env, check=True, capture_output=True)
        report['attachments'] = {str(p.relative_to(attachments)): native.digest(p) for p in sorted(attachments.rglob('*')) if p.is_file()}
        if inputs() != before: raise RuntimeError('Owning sources changed during proof')
        report.update(passed=args.case is None, cases=expected, assertions=assertions, sourceUnchanged=True)
    finally:
        observed = subprocess.run(['xcrun', 'simctl', 'get_app_container', args.udid, native.BUNDLE, 'data'], env=env, capture_output=True, text=True)
        if observed.returncode == 0:
            documents = Path(observed.stdout.strip()) / 'Documents'
            for name in ['handoff-ui-signature.json', 'handoff-ui-approve.json', 'handoff-ui-cancel.json', 'handoff-ui-background.json', 'native-safari-callbacks.json', 'minimal-safari-callbacks.json']:
                artifact = documents / name
                if artifact.is_file(): shutil.copyfile(artifact, output / name)
        report['sourceUnchanged'] = inputs() == before
        if server is not None: server.terminate(); server.wait(timeout=10)
        for bundle in owned:
            subprocess.run(['xcrun', 'simctl', 'terminate', args.udid, bundle], env=env, capture_output=True)
            subprocess.run(['xcrun', 'simctl', 'uninstall', args.udid, bundle], env=env, check=True, capture_output=True)
        remaining = set(native.apps(env, args.udid)); report['retainedInventoryUnchanged'] = remaining == inventory; report['ownedAppsRemoved'] = all(x not in remaining for x in owned)
        (output / 'receipt.json').write_text(json.dumps(report, indent=2) + '\n')
    if not report['retainedInventoryUnchanged'] or not report['ownedAppsRemoved']: raise RuntimeError('Disposable cleanup/inventory mismatch')
    print(json.dumps({'passed': report['passed'], 'cases': report.get('cases'), 'assertions': report.get('assertions'), 'receipt': str(output / 'receipt.json')}))

if __name__ == '__main__': main()
