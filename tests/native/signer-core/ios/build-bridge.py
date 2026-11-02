#!/usr/bin/env python3
"""Build and seal the disposable Expo signer fixture; never install or alter a retained app."""
import argparse
import hashlib
import json
import os
import plistlib
from pathlib import Path
import subprocess
import sys

REPO = Path(__file__).resolve().parents[4]
BUNDLE = 'org.nostrocket.hypergolic.signercore.bridgeproof'

def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()

def sources():
    names = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z',
        '--', 'src', 'modules', 'runtime', 'assets', 'scripts', 'plugins', 'patches', 'index*',
        'package.json', 'pnpm-lock.yaml', 'app.json', 'app.config.*', 'tsconfig*.json',
        'babel.config.*', 'metro.config.*'], cwd=REPO).decode().split('\0')
    paths = {REPO / name for name in names if name and '/android/' not in name and (REPO / name).is_file()}
    paths.add(REPO / 'tests/native/securestore-config/NativeBoundaryCheck.tsx')
    for name in ['modules/napplet-host/ios/Resources', 'ios/Hypergolic', 'ios/Hypergolic.xcodeproj', 'ios/Pods/Target Support Files']:
        paths.update(p for p in (REPO / name).rglob('*') if p.is_file())
    # Source-built native SecureStore must be bound to the patched file bytes actually compiled.
    secure = REPO / 'node_modules/expo-secure-store'
    paths.update(p for p in (secure / 'ios').rglob('*') if p.is_file())
    if (secure / 'package.json').is_file(): paths.add(secure / 'package.json')
    for name in ['ios/Podfile', 'ios/Podfile.lock', 'ios/Podfile.properties.json', 'ios/Pods/Manifest.lock']:
        path = REPO / name
        if path.is_file(): paths.add(path)
    return {str(p.relative_to(REPO)): digest(p) for p in sorted(paths)}

def product(app):
    hashes = {}
    for path in sorted(app.rglob('*')):
        if path.is_symlink() and not path.resolve().is_relative_to(app.resolve()):
            raise RuntimeError('Product symlink escapes the disposable app')
        if path.is_file(): hashes[str(path.relative_to(app))] = digest(path)
    if not {'Info.plist', 'main.jsbundle'}.issubset(hashes): raise RuntimeError('Incomplete bundled Expo product')
    return hashes

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--udid', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--derived-data', type=Path, help='Reuse a dedicated disposable build cache for an incremental sealed build')
    parser.add_argument('--simulator-keychain', action='store_true', help='Adhoc-sign only the disposable Simulator app with its own Keychain group')
    args = parser.parse_args()
    output = args.output.resolve(); output.mkdir(parents=True, exist_ok=False)
    if not (REPO / 'ios/Hypergolic.xcworkspace').is_dir(): raise RuntimeError('Run the normal Expo prebuild and pod install first')
    environment = dict(os.environ, DEVELOPER_DIR=os.environ.get('DEVELOPER_DIR', '/Applications/Xcode.app/Contents/Developer'))
    derived = args.derived_data.resolve() if args.derived_data else output / 'derived'
    app = derived / 'Build/Products/Release-iphonesimulator/Hypergolic.app'
    command = ['xcodebuild', '-workspace', 'ios/Hypergolic.xcworkspace', '-scheme', 'Hypergolic',
        '-configuration', 'Release', '-sdk', 'iphonesimulator', '-destination', 'platform=iOS Simulator,id=' + args.udid,
        '-derivedDataPath', str(derived), 'CODE_SIGNING_ALLOWED=NO', 'PRODUCT_BUNDLE_IDENTIFIER=' + BUNDLE,
        'ENTRY_FILE=index.signer.fixture.tsx', 'build']
    before = sources()
    with (output / 'build.log').open('w') as log:
        result = subprocess.run(command, cwd=REPO, env=environment, stdout=log, stderr=subprocess.STDOUT, timeout=1800)
    signing = None
    compile_product = product(app) if result.returncode == 0 else {}
    if result.returncode == 0 and args.simulator_keychain:
        entitlements = {'application-identifier': BUNDLE, 'keychain-access-groups': [BUNDLE], 'get-task-allow': True}
        entitlement_path = output / 'simulator-entitlements.plist'
        entitlement_path.write_bytes(plistlib.dumps(entitlements, sort_keys=True))
        sign_command = ['codesign', '--force', '--sign', '-', '--timestamp=none', '--identifier', BUNDLE,
            '--entitlements', str(entitlement_path), str(app)]
        with (output / 'sign.log').open('w') as log:
            subprocess.run(sign_command, stdout=log, stderr=subprocess.STDOUT, check=True)
        signing = {'purpose': 'Simulator public configuration fixture only; production vault remains unavailable',
            'command': sign_command, 'entitlements': entitlements, 'entitlementsSha256': digest(entitlement_path)}
    after = sources()
    receipt = {'sourceHashesBefore': before, 'sourceHashesAfter': after, 'sourceHashesUnchanged': before == after,
        'appHashes': product(app) if result.returncode == 0 else {}, 'appHashesBeforeSigning': compile_product, 'command': command,
        'buildExitCode': result.returncode, 'sourceCount': len(before), 'app': str(app),
        'scope': 'Disposable Expo fixture; no retained app install or protected storage.', 'simulatorSigning': signing}
    (output / 'build.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'receipt': str(output / 'build.json'), 'buildExitCode': result.returncode,
        'sourceHashesUnchanged': before == after, 'sourceCount': len(before), 'appFileCount': len(receipt['appHashes'])}))
    sys.exit(0 if result.returncode == 0 and before == after else 1)

if __name__ == '__main__': main()
