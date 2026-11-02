#!/usr/bin/env python3
"""Owning source-authority and pure ticket proof; no external browser, RPC or OS-auth claim."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import zipfile

ROOT = Path(__file__).resolve().parents[4]
PACKAGE = 'org.nostrocket.hypergolic.signercore.holdproof'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', required=True, type=Path)
parser.add_argument('--serial', required=True)
args = parser.parse_args()
if not args.serial.startswith('emulator-'):
    raise SystemExit('Disposable emulator required')
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
def run(command, timeout=120):
    result = subprocess.run([str(value) for value in command], env=env, check=True, capture_output=True, text=True, timeout=timeout)
    commands.append(result.stdout + result.stderr)
    return result.stdout

def adb(*command):
    return run([sdk / 'platform-tools/adb', '-s', args.serial, *command], timeout=60)

host = ROOT / 'modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host'
signer = ROOT / 'modules/signer-core/android/src/main/java/org/nostrocket/hypergolic/signercore'
sources = [host / (name + '.java') for name in ['NativeSigningHold', 'NativeApprovalAuthority', 'ApprovalLeaseRegistry',
    'NativeUploadAuthority', 'UploadFileProfile', 'UploadPngMetadata', 'UploadPngProfile', 'FixtureReleaseAuthority']]
sources += [signer / 'NativeHandoffTicket.java']
sources += [Path(__file__).with_name(name) for name in ['NativeSourceHoldProof.java', 'NativeHandoffTicketProof.java', 'NativeHandoffProofActivity.java']]
bound = sources + [Path(__file__).resolve()]
before = {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in bound}
def verify():
    after = {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in bound}
    if after != before:
        raise RuntimeError('Owning sources changed during proof')
    return after

classes = out / 'classes'
run([java / 'javac', '-Xlint:all', '-Werror', '--release', '17', '-cp', platform, '-d', classes, *sources])
host_result = json.loads(run([java / 'java', '-cp', classes, 'org.nostrocket.hypergolic.host.NativeSourceHoldProof']))
ticket_result = json.loads(run([java / 'java', '-cp', classes, 'org.nostrocket.hypergolic.signercore.NativeHandoffTicketProof']))
if host_result.get('status') != 'passed' or host_result.get('assertions', 0) < 137 or ticket_result.get('assertions', 0) < 19:
    raise RuntimeError('Incomplete native source proof')
jar = out / 'classes.jar'
run([java / 'jar', 'cf', jar, '-C', classes, '.'])
dex = out / 'dex'
dex.mkdir()
run([build / 'd8', '--min-api', '26', '--lib', platform, '--output', dex, jar])
manifest = out / 'AndroidManifest.xml'
manifest.write_text(f'''<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="{PACKAGE}">
<uses-sdk android:minSdkVersion="26" android:targetSdkVersion="36" />
<application android:label="Disposable native hold proof" android:debuggable="true" android:allowBackup="false" android:theme="@android:style/Theme.Material.Light.NoActionBar">
<activity android:name="org.nostrocket.hypergolic.signercore.NativeHandoffProofActivity" android:exported="true"><intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter></activity>
</application></manifest>''')
unsigned = out / 'unsigned.apk'
run([build / 'aapt2', 'link', '-I', platform, '--manifest', manifest, '-o', unsigned])
with zipfile.ZipFile(unsigned, 'a', zipfile.ZIP_DEFLATED) as archive:
    archive.write(dex / 'classes.dex', 'classes.dex')
aligned = out / 'aligned.apk'
run([build / 'zipalign', '-f', '4', unsigned, aligned])
keystore = out / 'disposable.jks'
run([java / 'keytool', '-genkeypair', '-keystore', keystore, '-storepass', 'disposable-test', '-keypass', 'disposable-test',
    '-alias', 'proof', '-dname', 'CN=Disposable native hold proof', '-keyalg', 'RSA', '-validity', '2', '-noprompt'])
apk = out / 'proof.apk'
run([build / 'apksigner', 'sign', '--ks', keystore, '--ks-pass', 'pass:disposable-test', '--key-pass', 'pass:disposable-test', '--out', apk, aligned])
run([build / 'apksigner', 'verify', apk])
verify()
inventory_before = sorted(adb('shell', 'pm', 'list', 'packages').splitlines())
if 'package:' + PACKAGE in inventory_before:
    raise RuntimeError('Owned proof package already exists')
installed = False
try:
    adb('install', apk)
    installed = True
    adb('shell', 'am', 'start', '-W', '-n', PACKAGE + '/org.nostrocket.hypergolic.signercore.NativeHandoffProofActivity')
    deadline = time.monotonic() + 30
    result = None
    while time.monotonic() < deadline:
        process = subprocess.run([str(sdk / 'platform-tools/adb'), '-s', args.serial, 'exec-out', 'run-as', PACKAGE, 'cat', 'files/result.json'], capture_output=True, timeout=10)
        if process.returncode == 0 and process.stdout.strip():
            result = json.loads(process.stdout)
            break
        time.sleep(0.2)
    if not result or result.get('status') != 'passed' or result.get('sourceAssertions') != host_result['assertions'] or result.get('ticketAssertions') != ticket_result['assertions']:
        raise RuntimeError('Incomplete actual Android ART result')
    after = verify()
    result.update(environment={'platform': 'Android ART', 'serial': args.serial, 'api': adb('shell', 'getprop', 'ro.build.version.sdk').strip()},
        scope='Owning approval/upload/one-fixture-stage holds and pure owner/operation/deadline ticket. Explicit clock/public-body fixture; no browser, RPC continuation, Expo or OS-auth proof.',
        hostAssertions=host_result['assertions'] + ticket_result['assertions'], sourceBefore=before, sourceAfter=after,
        apkSha256=hashlib.sha256(apk.read_bytes()).hexdigest())
finally:
    if installed:
        adb('uninstall', PACKAGE)
    inventory_after = sorted(adb('shell', 'pm', 'list', 'packages').splitlines())
    if inventory_after != inventory_before:
        raise RuntimeError('Package inventory did not restore exactly')
    (out / 'commands.log').write_text('\n'.join(commands))
    (out / 'inventory-before.json').write_text(json.dumps(inventory_before))
    (out / 'inventory-after.json').write_text(json.dumps(inventory_after))
result['cleanup'] = 'Proof package absent; exact package inventory restored.'
(out / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'status': result['status'], 'nativeAssertions': result['sourceAssertions'] + result['ticketAssertions'], 'hostAssertions': result['hostAssertions'], 'output': str(out)}))
