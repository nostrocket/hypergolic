#!/usr/bin/env python3
"""Compile owning Android signer sources and exercise a disposable emulator package."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[4]
PACKAGE = 'org.nostrocket.hypergolic.signercore.proof'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--serial')
parser.add_argument('--output', type=Path)
parser.add_argument('--build-only', action='store_true')
args = parser.parse_args()
out = args.output or Path(tempfile.mkdtemp(prefix='hypergolic-signer-android-'))
out.mkdir(parents=True, exist_ok=True)
sdk = ROOT / '.tools/android-sdk'
java = ROOT / '.tools/jdk/Contents/Home/bin'
build = sdk / 'build-tools/36.0.0'
platform = sdk / 'platforms/android-36/android.jar'
env = os.environ.copy()
env['JAVA_HOME'] = str(java.parent)
env['PATH'] = str(java) + os.pathsep + env['PATH']
log = []
def run(command, *, capture=True, timeout=120):
    result = subprocess.run([str(x) for x in command], env=env, check=True, capture_output=capture, text=capture, timeout=timeout)
    if capture: log.append(result.stdout + result.stderr)
    return result.stdout if capture else ''
def artifact(command, path):
    result = subprocess.run([str(x) for x in command], env=env, check=True, capture_output=True)
    path.write_bytes(result.stdout)

manifest_path = ROOT / 'modules/signer-core/vendor/secp256k1-manifest.json'
manifest_pin = json.loads(manifest_path.read_text())
if manifest_pin['commit'] != '6e2c8bc4ecdc6e71dbe7a368f360d8d453ce435d':
    raise SystemExit('Unexpected pinned secp256k1 commit')
vendor = ROOT / 'modules/signer-core/vendor/secp256k1'
for relative, expected in manifest_pin['files'].items():
    if hashlib.sha256((vendor / relative).read_bytes()).hexdigest() != expected:
        raise SystemExit('Pinned secp256k1 source changed: ' + relative)
bound_sources = [Path(__file__).resolve(), Path(__file__).with_name('SignerProofActivity.java'), manifest_path]
bound_sources += [vendor / relative for relative in manifest_pin['files']]
bound_sources += [path for path in (ROOT / 'modules/signer-core/vendor/monocypher').rglob('*') if path.is_file()]
bound_sources += [ROOT / 'modules/signer-core/vendor/monocypher-manifest.json']
monocypher_pin = json.loads((ROOT / 'modules/signer-core/vendor/monocypher-manifest.json').read_text())
for relative, expected in monocypher_pin['files'].items():
    if hashlib.sha256((ROOT / 'modules/signer-core/vendor/monocypher' / relative).read_bytes()).hexdigest() != expected:
        raise SystemExit('Pinned Monocypher source changed: ' + relative)
if hashlib.sha256((ROOT / 'modules/signer-core/android/src/main/assets/notices/monocypher-LICENCE.txt').read_bytes()).hexdigest() != monocypher_pin['files']['LICENCE.md']:
    raise SystemExit('Packaged Monocypher license differs from original')
for folder in ['modules/signer-core/android/src/main', 'modules/signer-core/shared']:
    bound_sources += [path for path in (ROOT / folder).rglob('*') if path.is_file()]
source_hashes = {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in bound_sources}
def verify_sources():
    for relative, expected in source_hashes.items():
        if hashlib.sha256((ROOT / relative).read_bytes()).hexdigest() != expected:
            raise RuntimeError('Signer source changed during proof: ' + relative)

native = out / 'native'
cmake = sdk / 'cmake/3.22.1/bin/cmake'
run([cmake, '-S', ROOT / 'modules/signer-core/android/src/main/cpp', '-B', native, '-G', 'Ninja',
     '-DCMAKE_TOOLCHAIN_FILE=' + str(sdk / 'ndk/27.1.12297006/build/cmake/android.toolchain.cmake'),
     '-DCMAKE_MAKE_PROGRAM=' + str(sdk / 'cmake/3.22.1/bin/ninja'), '-DANDROID_ABI=arm64-v8a',
     '-DANDROID_PLATFORM=android-26', '-DANDROID_STL=c++_static', '-DCMAKE_BUILD_TYPE=Release'])
run([cmake, '--build', native])
src = ROOT / 'modules/signer-core/android/src/main/java/org/nostrocket/hypergolic/signercore'
sources = [src / name for name in ['NativeSigningKey.java', 'NativeEvent.java', 'NativeSignerCore.java', 'NativeReviewPanel.java', 'NativeSecretBuffer.java', 'NativeTransportCrypto.java']]
sources.append(Path(__file__).with_name('SignerProofActivity.java'))
classes = out / 'classes'; classes.mkdir(exist_ok=True)
run([java / 'javac', '--release', '11', '-cp', platform, '-d', classes, *sources])
jar = out / 'classes.jar'; run([java / 'jar', 'cf', jar, '-C', classes, '.'])
dex = out / 'dex'; dex.mkdir(exist_ok=True)
run([build / 'd8', '--min-api', '26', '--lib', platform, '--output', dex, jar])
manifest = out / 'AndroidManifest.xml'
manifest.write_text(f'''<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="{PACKAGE}">
<uses-sdk android:minSdkVersion="26" android:targetSdkVersion="36" />
<application android:label="Disposable signer proof" android:debuggable="true" android:allowBackup="false" android:theme="@android:style/Theme.Material.Light.NoActionBar" android:extractNativeLibs="true">
<activity android:name="org.nostrocket.hypergolic.signercore.SignerProofActivity" android:exported="true"><intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter></activity>
</application></manifest>''')
unsigned = out / 'unsigned.apk'; run([build / 'aapt2', 'link', '-I', platform, '--manifest', manifest, '-o', unsigned])
with zipfile.ZipFile(unsigned, 'a', zipfile.ZIP_DEFLATED) as archive:
    archive.write(dex / 'classes.dex', 'classes.dex')
    archive.write(native / 'libhypergolic_signer_jni.so', 'lib/arm64-v8a/libhypergolic_signer_jni.so')
    archive.write(ROOT / 'modules/signer-core/android/src/main/assets/notices/secp256k1-COPYING.txt', 'assets/notices/secp256k1-COPYING.txt')
    archive.write(ROOT / 'modules/signer-core/android/src/main/assets/notices/monocypher-LICENCE.txt', 'assets/notices/monocypher-LICENCE.txt')
aligned = out / 'aligned.apk'; run([build / 'zipalign', '-f', '4', unsigned, aligned])
keystore = out / 'disposable.jks'
if not keystore.exists():
    run([java / 'keytool', '-genkeypair', '-keystore', keystore, '-storepass', 'disposable-test', '-keypass', 'disposable-test', '-alias', 'proof', '-dname', 'CN=Disposable native proof', '-keyalg', 'RSA', '-validity', '2', '-noprompt'])
apk = out / 'proof.apk'
run([build / 'apksigner', 'sign', '--ks', keystore, '--ks-pass', 'pass:disposable-test', '--key-pass', 'pass:disposable-test', '--out', apk, aligned])
run([build / 'apksigner', 'verify', apk])
(out / 'build.log').write_text('\n'.join(log))
if args.build_only:
    verify_sources()
    print(json.dumps({'status': 'built', 'assertions': 0, 'runtime': 'not run', 'apk': str(apk)})); raise SystemExit(0)
adb_tool = sdk / 'platform-tools/adb'
devices = run([adb_tool, 'devices'])
serial = args.serial or next((line.split()[0] for line in devices.splitlines() if line.startswith('emulator-') and line.endswith('\tdevice')), None)
if not serial or not re.fullmatch(r'emulator-[0-9]+', serial):
    raise SystemExit('Signer proof requires an online emulator; never targets a retained device.')
adb = [adb_tool, '-s', serial]
if 'package:' + PACKAGE in run(adb + ['shell', 'pm', 'list', 'packages', PACKAGE]).splitlines():
    raise SystemExit('Disposable proof package already exists; inspect previous run instead of replacing it.')
before = run(adb + ['shell', 'pm', 'list', 'packages'])
(out / 'packages-before.txt').write_text(before)
installed = False
try:
    run(adb + ['install', apk]); installed = True
    run(adb + ['shell', 'am', 'start', '-W', '-n', PACKAGE + '/org.nostrocket.hypergolic.signercore.SignerProofActivity'])
    def tap(label, name):
        deadline = time.monotonic() + 35
        while time.monotonic() < deadline:
            failure = subprocess.run([str(x) for x in adb + ['exec-out', 'run-as', PACKAGE, 'cat', 'files/result.json']], capture_output=True, text=True, timeout=10)
            if failure.returncode == 0 and failure.stdout.strip():
                try: native_status = json.loads(failure.stdout)
                except json.JSONDecodeError: native_status = {}
                if native_status.get('status') == 'failed':
                    (out / 'native-result.json').write_text(failure.stdout)
                    raise RuntimeError('Owning native core failed: ' + failure.stdout)
            run(adb + ['shell', 'uiautomator', 'dump', '/data/local/tmp/hg-signer.xml'], timeout=15)
            xml = run(adb + ['exec-out', 'cat', '/data/local/tmp/hg-signer.xml'])
            (out / (name + '.xml')).write_text(xml)
            tree = ET.fromstring(xml)
            for node in tree.iter('node'):
                if node.get('text', '').casefold() == label.casefold():
                    bounds = re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', node.get('bounds', ''))
                    if bounds:
                        artifact(adb + ['exec-out', 'screencap', '-p'], out / (name + '.png'))
                        left, top, right, bottom = map(int, bounds.groups())
                        run(adb + ['shell', 'input', 'tap', str((left+right)//2), str((top+bottom)//2)])
                        return
            time.sleep(0.2)
        raise RuntimeError('Native UI action absent: ' + label)
    tap('Approve once', 'approve-review'); tap('Reject', 'reject-review')
    deadline = time.monotonic() + 15
    receipt = None
    while time.monotonic() < deadline:
        process = subprocess.run([str(x) for x in adb + ['exec-out', 'run-as', PACKAGE, 'cat', 'files/result.json']], capture_output=True, text=True)
        if process.returncode == 0:
            try: receipt = json.loads(process.stdout)
            except json.JSONDecodeError: time.sleep(0.1); continue
            break
        time.sleep(0.2)
    if not receipt or receipt.get('status') != 'passed' or receipt.get('assertions', 0) < 1:
        raise RuntimeError('Native proof failed: ' + json.dumps(receipt))
    (out / 'native-result.json').write_text(json.dumps(receipt, indent=2) + '\n')
    verifier = '''import { verifyEvent, getEventHash } from 'nostr-tools';import { readFileSync } from 'node:fs';const r=JSON.parse(readFileSync(process.argv[1],'utf8'));if(!verifyEvent(r.signedEvent)||getEventHash(r.unsignedEvent)!==r.signedEvent.id)throw Error('Independent event verification failed');for(const k of ['pubkey','created_at','kind','tags','content'])if(JSON.stringify(r.unsignedEvent[k])!==JSON.stringify(r.signedEvent[k]))throw Error('Event substitution'); console.log('Independent nostr-tools signature/hash/exact-fields checks: 7 assertions');'''
    # Resolve the pinned application dependency; this verifier does not call the JNI library.
    verification = subprocess.run([str(ROOT / '.tools/node/bin/node'), '--input-type=module', '-e', verifier, str(out / 'native-result.json')], cwd=ROOT, env=env, check=True, capture_output=True, text=True)
    receipt['independentAssertions'] = 7
    receipt['independentVerifier'] = verification.stdout.strip()
    receipt['serial'] = serial
    verify_sources()
    receipt['sources'] = source_hashes
    receipt['sourcesUnchanged'] = True
    receipt['platform'] = 'android'
    receipt['suite'] = 'core'
    receipt['apkSha256'] = hashlib.sha256(apk.read_bytes()).hexdigest()
    artifact(adb + ['exec-out', 'screencap', '-p'], out / 'completed.png')
finally:
    if installed:
        run(adb + ['uninstall', PACKAGE])
        packages_after = run(adb + ['shell', 'pm', 'list', 'packages'])
        (out / 'packages-after.txt').write_text(packages_after)
        if PACKAGE in packages_after or set(before.splitlines()) != set(packages_after.splitlines()):
            raise RuntimeError('Disposable cleanup inventory mismatch')
        run(adb + ['shell', 'rm', '-f', '/data/local/tmp/hg-signer.xml'])
if receipt:
    verify_sources()
    receipt['cleanup'] = 'Disposable proof removed; before/after package sets equal.'
    (out / 'result.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'status': receipt['status'], 'assertions': receipt['assertions'], 'independentAssertions': 7, 'output': str(out)}))
