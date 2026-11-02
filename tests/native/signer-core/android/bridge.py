#!/usr/bin/env python3
"""Build or observe the actual Expo signer bridge in a disposable emulator app."""
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

ROOT = Path(__file__).resolve().parents[4]
PACKAGE = 'org.nostrocket.hypergolic.signercore.bridgeproof'
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--output', type=Path, required=True)
p.add_argument('--entry', type=Path, default=ROOT / 'index.signer.fixture.tsx')
p.add_argument('--serial', default='emulator-5554')
p.add_argument('--observe-only', action='store_true')
p.add_argument('--boundary-only', action='store_true')
p.add_argument('--build-only', action='store_true')
p.add_argument('--offline', action='store_true')
a = p.parse_args(); out = a.output.resolve(); out.mkdir(parents=True, exist_ok=True)
entry = a.entry.resolve()
if not entry.is_file() or not re.fullmatch(r'emulator-[0-9]+', a.serial):
    raise SystemExit('A real fixture entry and emulator transport are required.')
sdk = ROOT / '.tools/android-sdk'; tools = sdk / 'build-tools/36.0.0'; adb = [sdk / 'platform-tools/adb', '-s', a.serial]
env = os.environ.copy(); env['JAVA_HOME'] = str(ROOT / '.tools/jdk/Contents/Home')
env['ANDROID_HOME'] = str(sdk); env['ANDROID_SDK_ROOT'] = str(sdk); env['GRADLE_USER_HOME'] = str(ROOT / '.tools/gradle-home')
env['PATH'] = os.pathsep.join([str(ROOT / '.tools/node/bin'), str(ROOT / '.tools/pnpm/bin'), str(Path(env['JAVA_HOME']) / 'bin'), env.get('PATH', '')])
env['EXPO_NO_TELEMETRY'] = '1'
def run(command, timeout=60):
    return subprocess.check_output([str(x) for x in command], env=env, text=True, stderr=subprocess.STDOUT, timeout=timeout)
def hashes():
    files = [entry, Path(__file__).resolve(), Path(__file__).with_name('BoundaryInstrumentation.java'), ROOT / 'patches/expo-secure-store@57.0.3.patch', ROOT / 'tests/native/securestore-config/source-manifest.json', ROOT / 'app.json', ROOT / 'package.json', ROOT / 'pnpm-lock.yaml', ROOT / 'android/app/build.gradle']
    files += [path for path in (ROOT / 'src').rglob('*') if path.is_file()]
    files += [path for path in (ROOT / 'tests/native/securestore-config').rglob('*') if path.is_file()]
    files += [path for path in (ROOT / 'node_modules/expo-secure-store/android').rglob('*') if path.is_file() and '/build/' not in str(path)]
    files += [path for path in (ROOT / 'modules').glob('*/expo-module.config.json')]
    files += [path for path in (ROOT / 'modules').glob('*/android/build.gradle')]
    files += [path for path in (ROOT / 'android/app/src').rglob('*') if path.is_file()]
    for folder in (ROOT / 'modules').glob('*/android/src'):
        files += [path for path in folder.rglob('*') if path.is_file()]
    for folder in [ROOT / 'modules/signer-core/shared', ROOT / 'modules/signer-core/vendor']:
        files += [path for path in folder.rglob('*') if path.is_file()]
    return {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in files}
manifest = json.loads((ROOT / 'tests/native/securestore-config/source-manifest.json').read_text())
if hashlib.sha256((ROOT / 'patches/expo-secure-store@57.0.3.patch').read_bytes()).hexdigest() != manifest['patchSha256']:
    raise RuntimeError('SecureStore patch differs from reviewed manifest')
for relative, expected in manifest['patched'].items():
    if hashlib.sha256((ROOT / 'node_modules/expo-secure-store' / relative).read_bytes()).hexdigest() != expected:
        raise RuntimeError('Installed SecureStore differs from reviewed source: ' + relative)
apk = out / 'bridge.apk'
if not a.observe_only:
    before = hashes()
    def groovy(value): return "'" + str(value).replace('\\', '\\\\').replace("'", "\\'") + "'"
    init = out / 'bridge.init.gradle'
    init.write_text("gradle.beforeProject { project ->\n  if (project.path == ':app') {\n    project.afterEvaluate {\n" +
      "      project.android.defaultConfig.applicationId = " + groovy(PACKAGE) + "\n" +
      "      project.android.buildTypes.release.signingConfig = project.android.signingConfigs.debug\n" +
      "      project.extensions.getByName('react').entryFile.set(new File(" + groovy(entry) + "))\n    }\n  }\n}\n")
    command = [ROOT / 'android/gradlew', '-p', ROOT / 'android', ':app:assembleRelease', '-I', init, '-PreactNativeArchitectures=arm64-v8a', '--console=plain', '--no-daemon']
    if a.offline: command.append('--offline')
    with (out / 'build.log').open('w') as log:
        subprocess.run([str(x) for x in command], env=env, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=600)
    if before != hashes(): raise RuntimeError('Compiled source inputs changed during bridge build')
    shutil.copy2(ROOT / 'android/app/build/outputs/apk/release/app-release.apk', apk)
    badging = run([tools / 'aapt', 'dump', 'badging', apk]); (out / 'badging.txt').write_text(badging)
    if "package: name='" + PACKAGE + "'" not in badging: raise RuntimeError('Disposable package override was not applied')
    run([tools / 'apksigner', 'verify', apk])
    (out / 'build.json').write_text(json.dumps({'status': 'compiled-not-executed', 'sources': before, 'sourcesUnchanged': True,
      'apkSha256': hashlib.sha256(apk.read_bytes()).hexdigest(), 'package': PACKAGE, 'entry': str(entry.relative_to(ROOT)), 'assertions': 0}, indent=2) + '\n')
seal = json.loads((out / 'build.json').read_text())
if seal['sources'] != hashes() or seal['apkSha256'] != hashlib.sha256(apk.read_bytes()).hexdigest():
    raise RuntimeError('Bridge source/product seal no longer matches')
if a.build_only:
    print(json.dumps({'status': 'compiled-not-executed', 'assertions': 0, 'apk': str(apk), 'sourcesUnchanged': True}))
    raise SystemExit(0)
packages = run(adb + ['shell', 'pm', 'list', 'packages'])
if 'package:' + PACKAGE in packages.splitlines(): raise RuntimeError('Inspect the previous bridge package before replacing it')
(out / 'packages-before.txt').write_text(packages)
probe_package = PACKAGE + '.test'
if 'package:' + probe_package in packages.splitlines(): raise RuntimeError('Previous boundary instrumentation package exists')
java = Path(env['JAVA_HOME']) / 'bin'; platform = sdk / 'platforms/android-36/android.jar'
probe_classes = out / 'probe-classes'; probe_classes.mkdir(exist_ok=True)
run([java / 'javac', '--release', '11', '-cp', platform, '-d', probe_classes, Path(__file__).with_name('BoundaryInstrumentation.java')])
probe_jar = out / 'probe.jar'; run([java / 'jar', 'cf', probe_jar, '-C', probe_classes, '.'])
probe_dex = out / 'probe-dex'; probe_dex.mkdir(exist_ok=True)
run([tools / 'd8', '--min-api', '26', '--lib', platform, '--output', probe_dex, probe_jar])
probe_manifest = out / 'probe-manifest.xml'
probe_manifest.write_text(f'<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="{probe_package}"><uses-sdk android:minSdkVersion="26" android:targetSdkVersion="36"/><application android:label="Disposable boundary probe"/><instrumentation android:name="org.nostrocket.hypergolic.signercore.proof.BoundaryInstrumentation" android:targetPackage="{PACKAGE}"/></manifest>')
probe_unsigned = out / 'probe-unsigned.apk'
run([tools / 'aapt2', 'link', '-I', platform, '--manifest', probe_manifest, '-o', probe_unsigned])
import zipfile
with zipfile.ZipFile(probe_unsigned, 'a', zipfile.ZIP_DEFLATED) as archive: archive.write(probe_dex / 'classes.dex', 'classes.dex')
probe_aligned = out / 'probe-aligned.apk'; run([tools / 'zipalign', '-f', '4', probe_unsigned, probe_aligned])
probe_apk = out / 'probe.apk'
run([tools / 'apksigner', 'sign', '--ks', ROOT / 'android/app/debug.keystore', '--ks-pass', 'pass:android', '--key-pass', 'pass:android', '--ks-key-alias', 'androiddebugkey', '--out', probe_apk, probe_aligned])
def probe(mode):
    output = run(adb + ['shell', 'am', 'instrument', '-w', '-e', 'mode', mode, probe_package + '/org.nostrocket.hypergolic.signercore.proof.BoundaryInstrumentation'])
    (out / ('boundary-' + mode + '.txt')).write_text(output)
    if 'INSTRUMENTATION_RESULT: status=passed' not in output: raise RuntimeError('Native boundary inventory probe failed')
    line = next((line for line in output.splitlines() if line.startswith('INSTRUMENTATION_RESULT: inventory=')), '')
    return json.loads(line.split('=', 1)[1])
checks = []; installed = False; probe_installed = False; legacy_before = None

try:
    run(adb + ['install', apk]); installed = True
    run(adb + ['install', probe_apk]); probe_installed = True
    legacy_before = probe('seed')
    (out / 'legacy-before.json').write_text(json.dumps(legacy_before, indent=2) + '\n')
    run(adb + ['shell', 'am', 'start', '-W', '-n', PACKAGE + '/org.nostrocket.hypergolic.dev.MainActivity'])
    def snapshot(name):
        run(adb + ['shell', 'uiautomator', 'dump', '/data/local/tmp/hg-signer-bridge.xml'], timeout=20)
        xml = run(adb + ['exec-out', 'cat', '/data/local/tmp/hg-signer-bridge.xml'])
        (out / (name + '.xml')).write_text(xml)
        return ET.fromstring(xml)
    def find(text, name, tap=False, partial=False):
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            tree = snapshot(name)
            for node in tree.iter('node'):
                value = node.get('text', '') or node.get('content-desc', '')
                matches = text.casefold() in value.casefold() if partial else text.casefold() == value.casefold()
                if matches:
                    raw = subprocess.check_output([str(x) for x in adb + ['exec-out', 'screencap', '-p']], timeout=15)
                    (out / (name + '.png')).write_bytes(raw)
                    if tap:
                        bounds = re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', node.get('bounds', ''))
                        if not bounds: raise RuntimeError('Target has no native bounds')
                        l, t, r, b = map(int, bounds.groups()); run(adb + ['shell', 'input', 'tap', (l+r)//2, (t+b)//2])
                    checks.append(name); return value
            run(adb + ['shell', 'input', 'swipe', '500', '1600', '500', '500', '350'])
            time.sleep(.2)
        raise RuntimeError('Bridge UI target absent: ' + text)
    find('Native owner claimed.', 'native-owner', partial=True)
    find('Check native boundary', 'boundary-request', tap=True)
    boundary = find('Native boundary passed.', 'boundary-bridge-result', partial=True)
    if 'Vault available: true.' not in boundary or '25 restricted calls denied' not in boundary or 'round trips passed; fixture record removed.' not in boundary:
        raise RuntimeError('Actual configuration bridge assertions missing')
    checks += ['boundary-availability-readonly', 'boundary-five-export-denials-25', 'boundary-config-roundtrip-and-cleanup']
    legacy_after = probe('inspect')
    if legacy_after != legacy_before: raise RuntimeError('Legacy fixture records or aliases changed')
    (out / 'legacy-after.json').write_text(json.dumps(legacy_after, indent=2) + '\n')
    checks.append('legacy-three-encrypted-records-and-one-alias-unchanged')
    run(adb + ['shell', 'am', 'start', '-W', '-n', PACKAGE + '/org.nostrocket.hypergolic.dev.MainActivity'])
    for _ in range(3): run(adb + ['shell', 'input', 'swipe', '500', '500', '500', '1700', '250'])
    if not a.boundary_only:
        find('Review test event', 'first-request', tap=True)
        find('Review signing request', 'first-native-review')
        find('Trusted shell / Disposable signing trace', 'fixed-requester', partial=True)
        find('Approve once', 'first-native-approve', tap=True)
        public = find('Signature verified. Nothing was published.', 'first-independent-success', partial=True)
        if not re.search(r'Event: [a-f0-9]{64}', public) or not re.search(r'Disposable public key: [a-f0-9]{64}', public):
            raise RuntimeError('Public verified event receipt is missing')
        checks.append('public-event-id-and-key')
        find('Review test event', 'repeated-request', tap=True)
        find('Reject', 'native-reject', tap=True)
        find('Signer check cancelled or unavailable.', 'rejected-bridge-result', partial=True)
        find('Close signer check', 'unmount-cancel-call', tap=True)
        find('Open signer check', 'remount', tap=True)
        find('Review test event', 'after-remount-request', tap=True)
        find('Approve once', 'after-remount-approve', tap=True)
        find('Signature verified. Nothing was published.', 'after-remount-success', partial=True)
        run(adb + ['shell', 'input', 'keyevent', '3']); checks.append('real-background-input')
        run(adb + ['shell', 'am', 'start', '-W', '-n', PACKAGE + '/org.nostrocket.hypergolic.dev.MainActivity'])
        find('Review test event', 'after-background-request', tap=True)
        find('Approve once', 'after-background-approve', tap=True)
        regenerated = find('Signature verified. Nothing was published.', 'after-background-success', partial=True)
        first_key = re.search(r'Disposable public key: ([a-f0-9]{64})', public).group(1)
        next_key = re.search(r'Disposable public key: ([a-f0-9]{64})', regenerated).group(1)
        if first_key == next_key: raise RuntimeError('Background did not retire the disposable key')
        checks.append('background-new-native-key')
        if seal['sources'] != hashes(): raise RuntimeError('Bridge source inputs changed during observation')
finally:
    if probe_installed: run(adb + ['uninstall', probe_package])
    if installed:
        run(adb + ['uninstall', PACKAGE])
        after = run(adb + ['shell', 'pm', 'list', 'packages']); (out / 'packages-after.txt').write_text(after)
        if set(packages.splitlines()) != set(after.splitlines()): raise RuntimeError('Bridge package cleanup mismatch')
        run(adb + ['shell', 'rm', '-f', '/data/local/tmp/hg-signer-bridge.xml'])
receipt = {'status': 'passed', 'platform': 'android', 'suite': 'configuration-boundary' if a.boundary_only else 'bridge', 'assertions': len(checks), 'checks': checks,
  'environment': 'Android emulator; actual Hypergolic Expo/React Native bridge with existing native AppContext owner',
  'nativeExportDenials': 25, 'configReadbackAssertions': 5, 'legacyRecordCount': 3, 'legacyAliasCount': 1, 'legacyInventoryUnchanged': True,
  'scope': 'Configuration availability, restricted SecureStore calls and public config roundtrip; seeded legacy encrypted bytes and alias preserved.' if a.boundary_only else 'Activation/generation/native approve/reject/repeat/React unmount cancel invocation/background regeneration; independently validated public signature result; no saved keys or publication.',
  'limitations': 'No saved vault opened; native source signing and persistence proof are separate.' if a.boundary_only else 'React unmount cancel invokes native API with no pending review; this does not establish pending-review cancellation through the Expo bridge.',
  'sources': seal['sources'], 'sourcesUnchanged': True, 'apkSha256': seal['apkSha256'], 'cleanup': 'Disposable bridge package removed; exact package inventory restored.'}
(out / 'result.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps({'status': receipt['status'], 'assertions': len(checks), 'output': str(out)}))
