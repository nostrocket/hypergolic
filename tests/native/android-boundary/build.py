#!/usr/bin/env python3
"""Build/seal disposable Release app and instrumentation; never installs or runs a device."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import zipfile

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
PACKAGE = 'org.nostrocket.hypergolic.androidboundaryprobe'
RUNNER = 'org.nostrocket.hypergolic.boundary.BoundaryInstrumentation'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def snapshot():
    names = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=REPO).decode().split('\0')
    paths = [REPO / name for name in names if name and (REPO / name).is_file()]
    # Generated native packaging is ignored by Git, but it affects this build.
    paths += [REPO / name for name in ['android/app/build.gradle', 'android/build.gradle',
        'android/settings.gradle', 'android/gradle.properties', 'android/app/src/main/AndroidManifest.xml',
        'android/app/src/main/java/org/nostrocket/hypergolic/dev/MainApplication.kt',
        'android/app/src/main/java/org/nostrocket/hypergolic/dev/MainActivity.kt']]
    return {str(path.relative_to(REPO)): sha(path) for path in sorted(set(paths))}


def build(output, network_control=False):
    output = output.resolve()
    if output == REPO or REPO in output.parents:
        raise RuntimeError('Use a fresh external output directory for sealed products')
    output.mkdir(parents=True, exist_ok=False)
    receipt = {'schema': 1, 'status': 'incomplete', 'installed': False, 'executed': False,
        'physicalAcceptance': False, 'applicationId': PACKAGE, 'testApplicationId': PACKAGE + '.test',
        'runner': RUNNER, 'networkControlCleartext': network_control, 'dateUTC': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'scope': 'Offline Release compilation only; no physical WebView, security or Expo acceptance claim'}
    before = snapshot()
    (output / 'source-inputs.json').write_text(json.dumps(before, indent=2) + '\n')
    try:
        expected = json.loads((HERE / 'expected-inputs.json').read_text())['sources']
        actual = {name: sha(REPO / name) for name in expected}
        if actual != expected:
            raise RuntimeError('Reviewed native/runtime inputs changed: inspect the test scope before rebaselining')
        receipt['reviewedInputs'] = actual
        receipt['sourceHead'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip()
        command = ['./android/gradlew', '-p', 'android', '--init-script', str(HERE / 'init.gradle'),
            '-Dhypergolic.boundaryRoot=' + str(HERE), ':app:assembleRelease', ':app:assembleReleaseAndroidTest',
            '--no-daemon', '--max-workers=2', '-PreactNativeArchitectures=arm64-v8a', '-PhypergolicUploadProof=false']
        if network_control:
            command.insert(5, '-Dhypergolic.boundaryNetworkControl=true')
        receipt['command'] = command
        env = {key: value for key, value in os.environ.items() if key != 'ENTRY_FILE' and not key.startswith('HYPERGOLIC_KEY')}
        with (output / 'gradle.log').open('w') as log:
            rc = subprocess.run(command, cwd=REPO, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=1200).returncode
        receipt['gradleExitCode'] = rc
        if rc != 0:
            raise RuntimeError('Gradle failed; preserve and inspect the raw log')
        artifacts = {'app': REPO / 'android/app/build/outputs/apk/release/app-release.apk',
            'test': REPO / 'android/app/build/outputs/apk/androidTest/release/app-release-androidTest.apk'}
        tools = Path(os.environ['ANDROID_HOME']) / 'build-tools/36.0.0'
        products = {}
        certificates = []
        for kind, source in artifacts.items():
            target = output / (kind + '.apk')
            shutil.copy2(source, target)
            badging = subprocess.check_output([str(tools / 'aapt'), 'dump', 'badging', str(target)], text=True)
            (output / (kind + '-badging.txt')).write_text(badging)
            manifest = subprocess.check_output([str(tools / 'aapt'), 'dump', 'xmltree', str(target), 'AndroidManifest.xml'], text=True)
            (output / (kind + '-manifest.txt')).write_text(manifest)
            expected_package = PACKAGE + ('.test' if kind == 'test' else '')
            if "package: name='" + expected_package + "'" not in badging:
                raise RuntimeError('Unexpected package identity')
            if kind == 'app' and ('application-debuggable' in badging or "native-code: 'arm64-v8a'" not in badging):
                raise RuntimeError('Expected nondebuggable ARM64 Release target')
            if "application: label='Hypergolic'" not in badging:
                raise RuntimeError('Both test packages must retain the Hypergolic application label')
            if kind == 'app' and network_control and 'usesCleartextTraffic' not in manifest:
                raise RuntimeError('Test-only receiver-control manifest overlay missing')
            if kind == 'test' and (RUNNER not in manifest or PACKAGE not in manifest or 'targetPackage' not in manifest):
                raise RuntimeError('Instrumentation target/runner missing')
            signature = subprocess.check_output([str(tools / 'apksigner'), 'verify', '--verbose', '--print-certs', str(target)], text=True)
            (output / (kind + '-signature.txt')).write_text(signature)
            cert = re.findall(r'certificate SHA-256 digest: ([0-9a-f]{64})', signature)
            if len(cert) != 1 or 'Verified using v2 scheme (APK Signature Scheme v2): true' not in signature:
                raise RuntimeError('Invalid signed test product')
            certificates.append(cert[0]); products[kind] = {'sha256': sha(target), 'bytes': target.stat().st_size, 'certificateSha256': cert[0]}
        if len(set(certificates)) != 1:
            raise RuntimeError('App and instrumentation do not share the same test signer')
        with zipfile.ZipFile(output / 'app.apk') as archive:
            for name in ['index.html', 'host.js']:
                data = archive.read('assets/runtime/' + name)
                if data != (REPO / 'modules/napplet-host/android/src/main/assets/runtime' / name).read_bytes():
                    raise RuntimeError('Packaged runtime differs from reviewed source')
            receipt['jsBundleSha256'] = hashlib.sha256(archive.read('assets/index.android.bundle')).hexdigest()
        receipt['products'] = products
        receipt['status'] = 'compiled-not-executed'
    except Exception as error:
        receipt['error'] = str(error)
    finally:
        receipt['sourceInputsUnchanged'] = before == snapshot()
        if not receipt['sourceInputsUnchanged']:
            receipt['status'] = 'incomplete'; receipt['error'] = 'Inputs changed during compilation'
        if (output / 'gradle.log').is_file():
            receipt['gradleLogSha256'] = sha(output / 'gradle.log')
        (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(str(output / 'receipt.json'))
    if receipt['status'] != 'compiled-not-executed':
        raise RuntimeError(receipt.get('error', 'Build incomplete'))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--network-control', action='store_true', help='Disposable cleartext receiver control overlay; no ordinary app change')
    args = parser.parse_args()
    build(args.output, args.network_control)
