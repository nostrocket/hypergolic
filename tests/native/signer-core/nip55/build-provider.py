#!/usr/bin/env python3
"""Build an isolated adversarial signer APK; never install or touch retained apps."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[4]
HERE = Path(__file__).resolve().parent
PACKAGE = 'org.nostrocket.hypergolic.signercore.nip55fixture'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--client-package', action='append', required=True,
                        help='Exact disposable client package permitted to request fixture results')
    args = parser.parse_args()
    if any(not re.fullmatch(r'org\.nostrocket\.hypergolic\.signercore\.[a-zA-Z][a-zA-Z0-9]*proof', value)
           for value in args.client_package):
        parser.error('Only explicitly named disposable signer proof clients are supported')
    out = args.output.resolve()
    if out.is_relative_to(ROOT) and not out.is_relative_to(ROOT / '.tools'):
        parser.error('Build outside source or in ignored .tools')
    out.mkdir(parents=True, exist_ok=False)
    sdk = ROOT / '.tools/android-sdk'
    java = ROOT / '.tools/jdk/Contents/Home/bin'
    build = sdk / 'build-tools/36.0.0'
    platform = sdk / 'platforms/android-36/android.jar'
    env = os.environ.copy()
    env['JAVA_HOME'] = str(java.parent)
    env['PATH'] = str(java) + os.pathsep + env['PATH']
    commands = []

    def run(command):
        result = subprocess.run([str(value) for value in command], env=env, capture_output=True, text=True, timeout=120)
        commands.append({'command': [str(value) for value in command], 'exitCode': result.returncode,
                         'output': result.stdout + result.stderr})
        (out / 'commands.json').write_text(json.dumps(commands, indent=2) + '\n')
        if result.returncode:
            raise RuntimeError('Fixture build failed; inspect commands.json')
        return result.stdout

    signer = ROOT / 'modules/signer-core/android/src/main/java/org/nostrocket/hypergolic/signercore'
    sources = [signer / (name + '.java') for name in ['NativeSigningKey', 'NativeSecretBuffer', 'NativeEvent', 'NativeSignerCore']]
    sources += [HERE / 'SignerFixtureActivity.java', HERE / 'SignerFixtureResponse.java']
    bound = set(sources + [Path(__file__).resolve()])
    for folder in ['modules/signer-core/shared', 'modules/signer-core/vendor', 'modules/signer-core/android/src/main/cpp',
                   'modules/signer-core/android/src/main/assets/notices']:
        bound.update(path for path in (ROOT / folder).rglob('*') if path.is_file())
    before = {str(path.relative_to(ROOT)): digest(path) for path in sorted(bound)}
    for name in ['secp256k1', 'monocypher']:
        pin = json.loads((ROOT / f'modules/signer-core/vendor/{name}-manifest.json').read_text())
        for relative, expected in pin['files'].items():
            if digest(ROOT / 'modules/signer-core/vendor' / name / relative) != expected:
                raise RuntimeError('Pinned crypto source differs: ' + name + '/' + relative)
    receipt = {'status': 'failed', 'package': PACKAGE, 'clients': sorted(set(args.client_package)),
               'sourceBefore': before, 'scope': 'Disposable native NIP-55 adversarial provider build; public-vector scalar 9. No installation, client integration, Amber or publication proof.'}
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
        jar = out / 'classes.jar'; run([java / 'jar', 'cf', jar, '-C', classes, '.'])
        dex = out / 'dex'; dex.mkdir()
        run([build / 'd8', '--min-api', '36', '--lib', platform, '--output', dex, jar])
        manifest = out / 'AndroidManifest.xml'
        manifest.write_text(f'''<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="{PACKAGE}">
<uses-sdk android:minSdkVersion="36" android:targetSdkVersion="36"/>
<application android:label="Disposable NIP-55 signer" android:debuggable="true" android:allowBackup="false" android:theme="@android:style/Theme.Material.Light.NoActionBar" android:extractNativeLibs="true">
<activity android:name="org.nostrocket.hypergolic.signercore.SignerFixtureActivity" android:exported="true">
<intent-filter><action android:name="android.intent.action.VIEW"/><category android:name="android.intent.category.DEFAULT"/><category android:name="android.intent.category.BROWSABLE"/><data android:scheme="nostrsigner"/></intent-filter>
</activity></application></manifest>''')
        unsigned = out / 'unsigned.apk'
        run([build / 'aapt2', 'link', '-I', platform, '--manifest', manifest, '-o', unsigned])
        with zipfile.ZipFile(unsigned, 'a', zipfile.ZIP_DEFLATED) as archive:
            archive.write(dex / 'classes.dex', 'classes.dex')
            archive.write(native / 'libhypergolic_signer_jni.so', 'lib/arm64-v8a/libhypergolic_signer_jni.so')
            archive.writestr('assets/clients.txt', '\n'.join(receipt['clients']) + '\n')
            for path in (ROOT / 'modules/signer-core/android/src/main/assets/notices').glob('*.txt'):
                archive.write(path, 'assets/notices/' + path.name)
        aligned = out / 'aligned.apk'; run([build / 'zipalign', '-f', '4', unsigned, aligned])
        keystore = out / 'disposable.jks'
        run([java / 'keytool', '-genkeypair', '-keystore', keystore, '-storepass', 'disposable-test', '-keypass', 'disposable-test',
             '-alias', 'fixture', '-dname', 'CN=Disposable NIP55 fixture', '-keyalg', 'RSA', '-validity', '2', '-noprompt'])
        apk = out / 'provider.apk'
        run([build / 'apksigner', 'sign', '--ks', keystore, '--ks-pass', 'pass:disposable-test', '--key-pass', 'pass:disposable-test', '--out', apk, aligned])
        certificates = run([build / 'apksigner', 'verify', '--print-certs', apk])
        match = re.search(r'Signer #1 certificate SHA-256 digest: ([0-9a-f]{64})', certificates)
        if not match:
            raise RuntimeError('Verified signer certificate missing')
        after = {str(path.relative_to(ROOT)): digest(path) for path in sorted(bound)}
        if after != before:
            raise RuntimeError('Fixture source changed during build')
        snapshot = out / 'source-snapshot'
        for relative, expected in before.items():
            destination = snapshot / relative; destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes((ROOT / relative).read_bytes())
            if digest(destination) != expected:
                raise RuntimeError('Source snapshot changed')
        receipt.update(status='passed', sourceAfter=after, apkSha256=digest(apk),
                       certificateSha256=match.group(1), protocolRevision='a79e21d90fce5465b50ef385dd368bba99ec4a0b')
    finally:
        (out / 'build.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({key: receipt[key] for key in ['status', 'package', 'apkSha256', 'certificateSha256']}))


if __name__ == '__main__':
    main()
