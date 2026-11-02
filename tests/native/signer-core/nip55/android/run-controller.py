#!/usr/bin/env python3
"""Focused native NIP55 controller/picker proof; no vault, Expo or source-resumption integration."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[5]
HERE = Path(__file__).resolve().parent
CLIENT = 'org.nostrocket.hypergolic.signercore.nip55proof'
PROVIDER = 'org.nostrocket.hypergolic.signercore.nip55fixture'
ACTIVITY = 'org.nostrocket.hypergolic.signercore.NativeAndroidSignerControllerProof'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--provider', required=True, type=Path, help='Reviewed disposable provider build directory')
    args = parser.parse_args()
    if not re.fullmatch(r'emulator-[0-9]+', args.serial):
        parser.error('Disposable emulator required')
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    sdk = ROOT / '.tools/android-sdk'
    java = ROOT / '.tools/jdk/Contents/Home/bin'
    build = sdk / 'build-tools/36.0.0'
    platform = sdk / 'platforms/android-36/android.jar'
    env = os.environ.copy()
    env['JAVA_HOME'] = str(java.parent)
    env['PATH'] = str(java) + os.pathsep + env['PATH']
    commands = []

    def run(command, timeout=120, allow_failure=False, binary=False):
        result = subprocess.run([str(x) for x in command], env=env, capture_output=True, timeout=timeout)
        commands.append({'command': [str(x) for x in command], 'exitCode': result.returncode,
                         'output': None if binary else (result.stdout + result.stderr).decode(errors='replace')})
        (out / 'commands.json').write_text(json.dumps(commands, indent=2) + '\n')
        if result.returncode and not allow_failure:
            raise RuntimeError('Command failed; inspect commands.json')
        return result.stdout if binary else result.stdout.decode(errors='replace')

    def adb(*command, **options):
        return run([sdk / 'platform-tools/adb', '-s', args.serial, *command], timeout=30, **options)

    def inventory():
        return sorted(adb('shell', 'pm', 'list', 'packages').splitlines())

    signer = ROOT / 'modules/signer-core/android/src/main/java/org/nostrocket/hypergolic/signercore'
    host = ROOT / 'modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host'
    signer_names = ['NativeSigningKey', 'NativeEvent', 'NativeSignerCore', 'NativeSecretBuffer', 'NativeVaultFile',
                    'NativeVault', 'NativeVaultRecordCodec', 'NativeVaultMetadata', 'NativeVaultMethods', 'NativeAndroidSignerCandidates', 'NativeTransportCrypto',
                    'NativeRemoteBinding', 'NativeConnectionCandidate', 'NativeRpcJson', 'NativeSignedEvent',
                    'NativeAndroidSignerBinding', 'NativeAndroidSignerInventory', 'NativeAndroidSignerParcel',
                    'NativeAndroidSignerResult', 'NativeAndroidSignerActivityController', 'NativeAndroidSignerPicker']
    host_names = ['PublicAddressPolicy', 'PublishedHttpsResponseReader', 'PublishedHttpsTransport',
                  'PublishedHttpsRequestOwner', 'PublishedRelayWebSocketHandshake', 'PublishedRelayWebSocketFrames',
                  'PublishedRelayWebSocketClientFrames', 'PublishedRelayWssQuery', 'PublishedRelayWssIo',
                  'PublishedRelayResponseClassifier', 'NativeSignerRelayOpening', 'NativeSignerRelay']
    sources = [signer / (name + '.java') for name in signer_names]
    sources += [host / (name + '.java') for name in host_names]
    sources += [HERE / 'NativeAndroidSignerControllerProof.java', HERE.parent / 'SignerFixtureResponse.java']
    bound = set(sources + [Path(__file__).resolve(), HERE.parent / 'build-provider.py', HERE.parent / 'SignerFixtureActivity.java',
                           ROOT / 'modules/signer-core/android/src/main/AndroidManifest.xml'])
    for folder in ['modules/signer-core/shared', 'modules/signer-core/vendor', 'modules/signer-core/android/src/main/cpp',
                   'modules/signer-core/android/src/main/assets/notices']:
        bound.update(path for path in (ROOT / folder).rglob('*') if path.is_file())
    before = {str(path.relative_to(ROOT)): digest(path) for path in sorted(bound)}
    (out / 'source-before.json').write_text(json.dumps(before, indent=2) + '\n')
    for relative, expected in before.items():
        target = out / 'source-snapshot' / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / relative, target)
        if digest(target) != expected:
            raise RuntimeError('Source changed during snapshot')
    for name in ['secp256k1', 'monocypher']:
        pin = json.loads((ROOT / f'modules/signer-core/vendor/{name}-manifest.json').read_text())
        for relative, expected in pin['files'].items():
            if digest(ROOT / 'modules/signer-core/vendor' / name / relative) != expected:
                raise RuntimeError('Pinned crypto differs')
    provider = args.provider.resolve()
    provider_receipt = json.loads((provider / 'build.json').read_text())
    if provider_receipt['status'] != 'passed' or CLIENT not in provider_receipt['clients'] or digest(provider / 'provider.apk') != provider_receipt['apkSha256']:
        raise RuntimeError('Invalid disposable provider build')
    for relative, expected in provider_receipt['sourceBefore'].items():
        if digest(ROOT / relative) != expected:
            raise RuntimeError('Reviewed provider source differs')
    receipt = {'status': 'failed', 'sourceBefore': before, 'cases': [], 'providerApkSha256': provider_receipt['apkSha256'],
               'providerCertificateSha256': provider_receipt['certificateSha256'],
               'scope': 'Actual controller and picker on Android ART; explicit native liveness/launch doubles for accepted results. Real provider hop cancels on background. Actual PackageManager visibility/certificate rotation. No Expo, vault, selected-method, source-resumption, browser, publication or Amber acceptance.'}
    installed = []
    original = None
    remote = '/sdcard/hypergolic-nip55-controller.xml'
    try:
        native = out / 'native'
        cmake = sdk / 'cmake/3.22.1/bin/cmake'
        run([cmake, '-S', ROOT / 'modules/signer-core/android/src/main/cpp', '-B', native, '-G', 'Ninja',
             '-DCMAKE_TOOLCHAIN_FILE=' + str(sdk / 'ndk/27.1.12297006/build/cmake/android.toolchain.cmake'),
             '-DCMAKE_MAKE_PROGRAM=' + str(sdk / 'cmake/3.22.1/bin/ninja'), '-DANDROID_ABI=arm64-v8a',
             '-DANDROID_PLATFORM=android-26', '-DANDROID_STL=c++_static', '-DCMAKE_BUILD_TYPE=Release'])
        run([cmake, '--build', native])
        classes = out / 'classes'
        run([java / 'javac', '--release', '17', '-cp', platform, '-d', classes, *sources])
        jar = out / 'classes.jar'
        run([java / 'jar', 'cf', jar, '-C', classes, '.'])
        dex = out / 'dex'
        dex.mkdir()
        run([build / 'd8', '--min-api', '36', '--lib', platform, '--output', dex, jar])
        fragment = ET.parse(ROOT / 'modules/signer-core/android/src/main/AndroidManifest.xml').getroot()
        query = ET.tostring(fragment.find('queries'), encoding='unicode')
        manifest = out / 'AndroidManifest.xml'
        manifest.write_text(f'''<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="{CLIENT}">
<uses-sdk android:minSdkVersion="36" android:targetSdkVersion="36"/>{query}
<application android:label="Disposable native controller proof" android:debuggable="true" android:allowBackup="false" android:theme="@android:style/Theme.Material.Light.NoActionBar" android:extractNativeLibs="true">
<activity android:name="{ACTIVITY}" android:exported="true"><intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter></activity>
</application></manifest>''')
        unsigned = out / 'unsigned.apk'
        run([build / 'aapt2', 'link', '-I', platform, '--manifest', manifest, '-o', unsigned])
        with zipfile.ZipFile(unsigned, 'a', zipfile.ZIP_DEFLATED) as apk:
            apk.write(dex / 'classes.dex', 'classes.dex')
            apk.write(native / 'libhypergolic_signer_jni.so', 'lib/arm64-v8a/libhypergolic_signer_jni.so')
            for path in (ROOT / 'modules/signer-core/android/src/main/assets/notices').glob('*.txt'):
                apk.write(path, 'assets/notices/' + path.name)
        aligned = out / 'aligned.apk'
        run([build / 'zipalign', '-f', '4', unsigned, aligned])
        keystore = out / 'disposable.jks'
        run([java / 'keytool', '-genkeypair', '-keystore', keystore, '-storepass', 'disposable-test', '-keypass', 'disposable-test',
             '-alias', 'proof', '-dname', 'CN=Disposable native controller proof', '-keyalg', 'RSA', '-validity', '2', '-noprompt'])
        apk = out / 'client.apk'
        run([build / 'apksigner', 'sign', '--ks', keystore, '--ks-pass', 'pass:disposable-test', '--key-pass', 'pass:disposable-test', '--out', apk, aligned])
        run([build / 'apksigner', 'verify', apk])
        run(['python3', HERE.parent / 'build-provider.py', '--output', out / 'rotated-provider', '--client-package', CLIENT])
        rotated = json.loads((out / 'rotated-provider/build.json').read_text())
        if rotated['certificateSha256'] == provider_receipt['certificateSha256']:
            raise RuntimeError('Rotation fixture did not change certificate')
        original = inventory()
        (out / 'inventory-before.json').write_text(json.dumps(original, indent=2) + '\n')
        if any('package:' + name in original for name in [CLIENT, PROVIDER]):
            raise RuntimeError('Owned proof packages already installed; refusing replacement')
        receipt['api'] = adb('shell', 'getprop', 'ro.build.version.sdk').strip()
        if receipt['api'] != '36':
            raise RuntimeError('API36 fixture required')
        for name, path in [(PROVIDER, provider / 'provider.apk'), (CLIENT, apk)]:
            installed.append(name)
            adb('install', path)

        def read_result(expected='passed'):
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                raw = adb('exec-out', 'run-as', CLIENT, 'cat', 'files/result.json', allow_failure=True)
                if raw.strip().startswith('{'):
                    result = json.loads(raw)
                    if result.get('mode') == mode and result['status'] == expected:
                        return result
                    if result.get('mode') == mode and result['status'] == 'failed':
                        raise RuntimeError('Owning controller failed: ' + raw)
                time.sleep(.2)
            raise RuntimeError('Controller receipt missing')

        def tap_matching(predicate, label):
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                adb('shell', 'uiautomator', 'dump', remote)
                raw = adb('exec-out', 'cat', remote)
                (out / (label + '.xml')).write_text(raw)
                tree = ET.fromstring(raw)
                match = next((node for node in tree.iter('node') if predicate(node.attrib.get('text', ''))), None)
                if match is not None:
                    numbers = list(map(int, re.findall(r'\d+', match.attrib['bounds'])))
                    (out / (label + '.png')).write_bytes(adb('exec-out', 'screencap', '-p', binary=True))
                    adb('shell', 'input', 'tap', (numbers[0] + numbers[2]) // 2, (numbers[1] + numbers[3]) // 2)
                    return
                time.sleep(.2)
            raise RuntimeError('Expected native control missing: ' + label)

        for mode in ['model', 'hook', 'picker', 'picker-denied', 'hop', 'rotation']:
            adb('shell', 'am', 'force-stop', CLIENT)
            adb('shell', 'am', 'start', '-W', '-n', CLIENT + '/' + ACTIVITY, '--es', 'mode', mode)
            if mode in ['picker', 'picker-denied', 'hop']:
                tap_matching(lambda text: text.startswith(PROVIDER), mode + '-native-picker')
            if mode == 'hop':
                tap_matching(lambda text: text.casefold() == 'return fixture result', mode + '-provider')
            if mode == 'rotation':
                read_result('pending')
                adb('uninstall', PROVIDER)
                adb('install', out / 'rotated-provider/provider.apk')
                tap_matching(lambda text: text.casefold() == 'complete rotation probe', mode + '-changed-certificate')
            result = read_result()
            (out / (mode + '-result.json')).write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
            if result['assertions'] < 1 or result['mode'] != mode:
                raise RuntimeError('Invalid owning case')
            receipt['cases'].append(result)
        verify = out / 'verify.mjs'
        verify.write_text('''import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(process.argv[3]+'/package.json');
const {verifyEvent,getEventHash}=require('nostr-tools');
const result=JSON.parse(fs.readFileSync(process.argv[2]));
let assertions=0;const check=x=>{assertions++;if(!x)throw Error('Independent exact-event check failed');};
for(const [u,s] of [[result.unsignedEvent,result.signedEvent],[result.oversizeUnsignedEvent,result.oversizeSignedEvent]]) {
check(verifyEvent(s));check(getEventHash(s)===s.id);
for(const key of ['pubkey','kind','created_at','tags','content'])check(JSON.stringify(u[key])===JSON.stringify(s[key]));
}
console.log(JSON.stringify({status:'passed',assertions}));
''')
        independent = json.loads(run([ROOT / '.tools/node/bin/node', verify, out / 'model-result.json', ROOT]))
        after = {relative: digest(ROOT / relative) for relative in before}
        if before != after:
            raise RuntimeError('Source changed during focused proof')
        receipt.update(status='passed', sourceAfter=after, nativeAssertions=sum(case['assertions'] for case in receipt['cases']),
                       independentAssertions=independent['assertions'], apkSha256=digest(apk),
                       rotatedCertificateSha256=rotated['certificateSha256'])
    finally:
        if installed:
            adb('shell', 'rm', '-f', remote, allow_failure=True)
        for name in reversed(installed):
            adb('uninstall', name, allow_failure=True)
        if installed and original is not None:
            final = inventory()
            (out / 'inventory-after.json').write_text(json.dumps(final, indent=2) + '\n')
            if final != original:
                receipt['status'] = 'failed'
                receipt['cleanup'] = 'Inventory mismatch'
            else:
                receipt['cleanup'] = 'Both owned packages absent; exact package inventory restored.'
        (out / 'receipt.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n')
    if receipt['status'] != 'passed':
        raise RuntimeError('Focused controller proof failed')
    print(json.dumps({'status': receipt['status'], 'nativeAssertions': receipt['nativeAssertions'],
                      'independentAssertions': receipt['independentAssertions'], 'output': str(out)}))


if __name__ == '__main__':
    main()
