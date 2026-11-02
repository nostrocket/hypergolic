#!/usr/bin/env python3
"""Owning Android JNI/vault/RPC/native-review proof against real controlled WSS/TLS; not Expo/publication proof."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
from urllib.parse import urlparse
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[5]
HERE = Path(__file__).resolve().parent
PACKAGE = 'org.nostrocket.hypergolic.signercore.nip46proof'
parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path)
parser.add_argument('--serial')
args = parser.parse_args()
out = args.output or Path(tempfile.mkdtemp(prefix='hypergolic-nip46-android-'))
out.mkdir(parents=True, exist_ok=True)
if any(out.iterdir()): raise SystemExit('A fresh output directory is required.')
sdk = ROOT / '.tools/android-sdk'
java = ROOT / '.tools/jdk/Contents/Home/bin'
node = ROOT / '.tools/node/bin/node'
build = sdk / 'build-tools/36.0.0'
platform = sdk / 'platforms/android-36/android.jar'
env = os.environ.copy(); env['JAVA_HOME'] = str(java.parent)
env['PATH'] = str(node.parent) + os.pathsep + str(java) + os.pathsep + env['PATH']
log = []
def run(command, timeout=120):
    result = subprocess.run([str(x) for x in command], env=env, check=True, capture_output=True, text=True, timeout=timeout)
    log.append(result.stdout + result.stderr)
    return result.stdout
host = ROOT / 'modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host'
signer = ROOT / 'modules/signer-core/android/src/main/java/org/nostrocket/hypergolic/signercore'
host_names = ['PublicAddressPolicy', 'PublishedHttpsResponseReader', 'PublishedHttpsTransport', 'PublishedHttpsRequestOwner',
    'PublishedRelayWebSocketHandshake', 'PublishedRelayWebSocketFrames', 'PublishedRelayWebSocketClientFrames',
    'PublishedRelayWssQuery', 'NativeSignerRelayOpening', 'NativeSigningHold', 'PublishedRelayWssIo', 'PublishedRelayResponseClassifier', 'NativeSignerRelay']
signer_names = ['NativeSigningKey', 'NativeEvent', 'NativeSignerCore', 'NativeReviewPanel', 'NativeSecretBuffer',
    'NativeVaultFile', 'NativeVault', 'NativeVaultRecordCodec', 'NativeVaultMetadata', 'NativeVaultMethods', 'NativeAndroidSignerBinding', 'NativeAndroidSignerCandidates', 'NativeTransportCrypto', 'NativeRemoteBinding', 'NativeConnectionCandidate', 'NativeBunker',
    'NativeRpcJson', 'NativeSignedEvent', 'NativeRemoteOperation', 'NativeNip46Client']
sources = [host / (name + '.java') for name in host_names] + [signer / (name + '.java') for name in signer_names]
sources += [HERE / 'NativeSignerRelayFixture.java', HERE / 'Nip46ProofActivity.java']
bound = set(sources + [Path(__file__).resolve(), ROOT / 'pnpm-lock.yaml', ROOT / 'package.json',
    ROOT / 'tests/native/signer-core/nip46/peer.mjs', ROOT / 'tests/native/signer-core/nip46/server.mjs'])
for folder in ['modules/signer-core/android/src/main', 'modules/signer-core/shared', 'modules/signer-core/vendor']:
    bound.update(path for path in (ROOT / folder).rglob('*') if path.is_file())
for name, commit in [('secp256k1', '6e2c8bc4ecdc6e71dbe7a368f360d8d453ce435d'), ('monocypher', None)]:
    pin = json.loads((ROOT / f'modules/signer-core/vendor/{name}-manifest.json').read_text())
    if commit and pin['commit'] != commit: raise RuntimeError('Unexpected crypto revision')
    for relative, expected in pin['files'].items():
        if hashlib.sha256((ROOT / 'modules/signer-core/vendor' / name / relative).read_bytes()).hexdigest() != expected:
            raise RuntimeError('Pinned crypto source differs: ' + name + '/' + relative)
source_hashes = {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(bound)}
def verify_sources():
    for relative, expected in source_hashes.items():
        if hashlib.sha256((ROOT / relative).read_bytes()).hexdigest() != expected: raise RuntimeError('Source changed during proof: ' + relative)
server_log = (out / 'peer.log').open('w')
server = subprocess.Popen([str(node), str(ROOT / 'tests/native/signer-core/nip46/server.mjs'), '--output', str(out / 'peer'), '--fixture-keys', 'public-vectors'], cwd=ROOT, env=env, stdout=server_log, stderr=server_log)
installed = False; adb = None; reversed_ports = []; before = None
try:
    deadline = time.monotonic() + 15
    while not (out / 'peer/ready.json').exists():
        if server.poll() is not None or time.monotonic() > deadline: raise RuntimeError('Controlled peer did not start')
        time.sleep(.1)
    ready = json.loads((out / 'peer/ready.json').read_text())
    native = out / 'native'; cmake = sdk / 'cmake/3.22.1/bin/cmake'
    run([cmake, '-S', ROOT / 'modules/signer-core/android/src/main/cpp', '-B', native, '-G', 'Ninja',
        '-DCMAKE_TOOLCHAIN_FILE=' + str(sdk / 'ndk/27.1.12297006/build/cmake/android.toolchain.cmake'),
        '-DCMAKE_MAKE_PROGRAM=' + str(sdk / 'cmake/3.22.1/bin/ninja'), '-DANDROID_ABI=arm64-v8a',
        '-DANDROID_PLATFORM=android-26', '-DANDROID_STL=c++_static', '-DCMAKE_BUILD_TYPE=Release'])
    run([cmake, '--build', native])
    classes = out / 'classes'; classes.mkdir()
    run([java / 'javac', '--release', '11', '-cp', platform, '-d', classes, *sources])
    jar = out / 'classes.jar'; run([java / 'jar', 'cf', jar, '-C', classes, '.'])
    dex = out / 'dex'; dex.mkdir()
    run([build / 'd8', '--min-api', '26', '--lib', platform, '--output', dex, jar])
    manifest = out / 'AndroidManifest.xml'
    manifest.write_text(f'''<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="{PACKAGE}">
<uses-sdk android:minSdkVersion="26" android:targetSdkVersion="36"/><uses-permission android:name="android.permission.INTERNET"/>
<application android:label="Disposable native NIP46 proof" android:debuggable="true" android:allowBackup="false" android:usesCleartextTraffic="true" android:theme="@android:style/Theme.Material.Light.NoActionBar" android:extractNativeLibs="true">
<activity android:name="org.nostrocket.hypergolic.signercore.Nip46ProofActivity" android:exported="true"><intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter></activity>
</application></manifest>''')
    unsigned = out / 'unsigned.apk'; run([build / 'aapt2', 'link', '-I', platform, '--manifest', manifest, '-o', unsigned])
    with zipfile.ZipFile(unsigned, 'a', zipfile.ZIP_DEFLATED) as archive:
        archive.write(dex / 'classes.dex', 'classes.dex')
        archive.write(native / 'libhypergolic_signer_jni.so', 'lib/arm64-v8a/libhypergolic_signer_jni.so')
        archive.writestr('assets/fixture.json', json.dumps(ready))
        archive.write(ready['der'], 'assets/fixture.der')
        for name in ['secp256k1-COPYING.txt', 'monocypher-LICENCE.txt']:
            archive.write(ROOT / 'modules/signer-core/android/src/main/assets/notices' / name, 'assets/notices/' + name)
    aligned = out / 'aligned.apk'; run([build / 'zipalign', '-f', '4', unsigned, aligned])
    keystore = out / 'disposable.jks'
    run([java / 'keytool', '-genkeypair', '-keystore', keystore, '-storepass', 'disposable-test', '-keypass', 'disposable-test', '-alias', 'proof', '-dname', 'CN=Disposable native proof', '-keyalg', 'RSA', '-validity', '2', '-noprompt'])
    apk = out / 'proof.apk'
    run([build / 'apksigner', 'sign', '--ks', keystore, '--ks-pass', 'pass:disposable-test', '--key-pass', 'pass:disposable-test', '--out', apk, aligned]); run([build / 'apksigner', 'verify', apk])
    devices = run([sdk / 'platform-tools/adb', 'devices'])
    serial = args.serial or next((line.split()[0] for line in devices.splitlines() if line.startswith('emulator-') and line.endswith('\tdevice')), None)
    if not serial or not re.fullmatch(r'emulator-[0-9]+', serial): raise RuntimeError('An owned emulator is required')
    adb = [sdk / 'platform-tools/adb', '-s', serial]
    if 'package:' + PACKAGE in run(adb + ['shell', 'pm', 'list', 'packages', PACKAGE]).splitlines(): raise RuntimeError('Proof package already installed')
    before = run(adb + ['shell', 'pm', 'list', 'packages']); (out / 'packages-before.txt').write_text(before)
    reverse_before = run(adb + ['reverse', '--list'])
    for port in [ready['port'], urlparse(ready['controlURL']).port]:
        if 'tcp:' + str(port) in reverse_before: raise RuntimeError('Fixture port is already reversed')
        run(adb + ['reverse', 'tcp:' + str(port), 'tcp:' + str(port)]); reversed_ports.append(port)
    run(adb + ['install', apk]); installed = True
    run(adb + ['shell', 'am', 'start', '-n', PACKAGE + '/org.nostrocket.hypergolic.signercore.Nip46ProofActivity'])
    finish = time.monotonic() + 180; native_receipt = None; taps = 0
    while time.monotonic() < finish:
        receipt = subprocess.run([str(x) for x in adb + ['exec-out', 'run-as', PACKAGE, 'cat', 'files/result.json']], capture_output=True, text=True, timeout=10)
        if receipt.returncode == 0 and receipt.stdout.strip():
            try: native_receipt = json.loads(receipt.stdout)
            except json.JSONDecodeError: native_receipt = None
            if native_receipt is not None:
                (out / 'native-result.json').write_text(json.dumps(native_receipt, indent=2) + '\n')
                if native_receipt.get('status') != 'passed': raise RuntimeError('Native RPC case failed: ' + json.dumps(native_receipt))
                break
        run(adb + ['shell', 'uiautomator', 'dump', '/data/local/tmp/hypergolic-nip46-proof.xml'])
        xml = run(adb + ['exec-out', 'cat', '/data/local/tmp/hypergolic-nip46-proof.xml'])
        document = ET.fromstring(xml[xml.index('<?xml'):])
        buttons = [item for item in document.iter('node') if item.get('text', '').lower() == 'approve once' and item.get('enabled') == 'true']
        if buttons:
            bounds = [int(value) for value in re.findall(r'\d+', buttons[0].get('bounds', ''))]
            if len(bounds) == 4: run(adb + ['shell', 'input', 'tap', str((bounds[0]+bounds[2])//2), str((bounds[1]+bounds[3])//2)]); taps += 1
        time.sleep(.1)
    if native_receipt is None: raise RuntimeError('Native RPC proof timed out')
    peer_receipt = json.loads((out / 'peer/receipt.json').read_text())
    verifier = out / 'verify.mjs'
    verifier.write_text('''import assert from 'node:assert/strict';
import fs from 'node:fs';
import { verifyEvent } from 'nostr-tools/pure';
const native=JSON.parse(fs.readFileSync(process.argv[2])), peer=JSON.parse(fs.readFileSync(process.argv[3]));
let assertions=0; const check=value=>{assert.ok(value);assertions++};
check(native.cases.length===30);check(native.nativeReviews===30);check(peer.invalidEvents===0);
check(peer.methodCounts.connect===1);check(peer.methodCounts.get_public_key===35);check(peer.methodCounts.switch_relays===30);
check([25,26].includes(peer.methodCounts.sign_event));check(peer.signatures===peer.methodCounts.sign_event-5);
check(new Set(peer.requests.map(row=>row.id)).size===peer.requests.length);
check(peer.wire.eventFrames===Object.values(peer.methodCounts).reduce((sum,value)=>sum+value,0));
for(const row of native.cases){
  check(row.possibleSigningSend=== (row.case!=='relay-change' && !row.case.startsWith('challenge-preflight-')));
  if(row.signedEvent){check(verifyEvent(structuredClone(row.signedEvent)));check(row.signedEvent.pubkey===peer.userPubkey);
    for(const field of ['kind','created_at','tags','content','pubkey'])check(JSON.stringify(row.signedEvent[field])===JSON.stringify(row.unsignedEvent[field]));}
}
check(native.cases.filter(row=>row.signedEvent).length===6);
const challengeRows=native.cases.filter(row=>row.case.startsWith('challenge-'));
check(challengeRows.length===6);
for(const row of challengeRows){check(row.authorizationChallenges===1);check(row.signedResultReturned===false);}
check(peer.authCompletions===0);
for(const request of peer.requests.filter(row=>row.method==='sign_event')){
  check(request.clientPubkey!==peer.peerPubkey && request.clientPubkey!==peer.userPubkey);
  if(request.approvedEvent){check(!Object.hasOwn(request.approvedEvent,'pubkey'));check(request.approvedEvent.kind===1);}
}
console.log(JSON.stringify({status:'passed',assertions}));
''')
    # Resolve pinned nostr-tools from this project's node_modules; the verifier has no signing secret input.
    # Do not write a temporary source file into the concurrent checkout.
    code = verifier.read_text().replace("from 'nostr-tools/pure'", "from " + json.dumps(str(ROOT / 'node_modules/nostr-tools/lib/esm/pure.js')))
    verifier.write_text(code)
    independent = json.loads(run([node, verifier, out / 'native-result.json', out / 'peer/receipt.json']))
    if native_receipt['assertions'] < 1 or taps < 30 or independent['assertions'] < 1: raise RuntimeError('Incomplete owning proof')
    verify_sources()
    result = {'status':'passed','scope':native_receipt['scope'],'platform':'Android','serial':serial,
        'assertions':native_receipt['assertions'],'nativeReviews':native_receipt['nativeReviews'],'independentAssertions':independent['assertions'],
        'peerCounters':{key:peer_receipt[key] for key in ['methodCounts','signatures','invalidEvents']},
        'sources':source_hashes,'apkSha256':hashlib.sha256(apk.read_bytes()).hexdigest()}
finally:
    if installed: run(adb + ['uninstall', PACKAGE]); installed = False
    for port in reversed_ports: run(adb + ['reverse', '--remove', 'tcp:' + str(port)])
    if adb and before is not None:
        after = run(adb + ['shell','pm','list','packages']); (out/'packages-after.txt').write_text(after)
        if sorted(before.splitlines()) != sorted(after.splitlines()): raise RuntimeError('Emulator package inventory changed')
    server.terminate()
    try: server.wait(timeout=10)
    except subprocess.TimeoutExpired: server.kill();server.wait()
    server_log.close(); (out/'build-runtime.log').write_text('\n'.join(log))
result['cleanup'] = 'Owned proof package removed, reverse ports removed, package inventory restored, controlled peer stopped.'
(out/'result.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({key:result[key] for key in ['status','assertions','nativeReviews','independentAssertions','cleanup']}))
