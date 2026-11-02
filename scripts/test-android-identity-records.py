#!/usr/bin/env python3
"""Run the isolated native record probe, requiring exact installed app and test APKs."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess


PACKAGE = 'org.nostrocket.hypergolic.identityfixture'
RUNNER = 'org.nostrocket.hypergolic.identityowner.RecordsInstrumentation'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--expected-apk-sha256', required=True)
    parser.add_argument('--expected-test-apk-sha256', required=True)
    parser.add_argument('--selected', required=True, help='Expected existing fixture public key')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    for value in [args.expected_apk_sha256, args.expected_test_apk_sha256, args.selected]:
        if not re.fullmatch('[0-9a-f]{64}', value):
            raise RuntimeError('Malformed expected public identity or artifact digest')
    root = Path(__file__).resolve().parent.parent
    relatives = [
        'modules/identity-owner/android/src/main/java/org/nostrocket/hypergolic/identityowner/DeletionAuthority.java',
        'modules/identity-owner/android/src/main/java/org/nostrocket/hypergolic/identityowner/SecureStoreIdentityRecords.java',
        'modules/identity-owner/android/src/main/java/org/nostrocket/hypergolic/identityowner/BackupNsec.java',
        'tests/native/android-identity-actions/RecordsInstrumentation.java',
        'scripts/test-android-identity-records.py',
        'tests/native/android-identity-actions/secure-store-source.json',
    ]
    contract = json.loads((root / 'tests/native/android-identity-actions/secure-store-source.json').read_text())
    sdk = root / 'node_modules/expo-secure-store'
    if json.loads((sdk / 'package.json').read_text()).get('version') != contract['version']:
        raise RuntimeError('SecureStore version changed; review its native codec before this proof')
    sdk_sources = {name: sha(sdk / name) for name in contract['sources']}
    if sdk_sources != contract['sources']:
        raise RuntimeError('SecureStore native source changed; review compatibility before this proof')
    before = {name: sha(root / name) for name in relatives}
    output = args.output.resolve(); output.mkdir(parents=True, exist_ok=False)
    def adb(*command):
        result = subprocess.run(['adb', '-s', args.serial, *command], capture_output=True, text=True, timeout=60, check=True)
        return result.stdout.strip()
    def verify(package, expected, suffix):
        paths = adb('shell', 'pm', 'path', package).splitlines()
        if len(paths) != 1 or not paths[0].startswith('package:/data/app/') or not paths[0].endswith('/base.apk'):
            raise RuntimeError('Expected one installed standalone APK')
        destination = output / (suffix + '.apk')
        adb('pull', paths[0][8:], str(destination))
        if sha(destination) != expected:
            raise RuntimeError('Installed artifact does not match the reviewed build')
    verify(PACKAGE, args.expected_apk_sha256, 'app-before')
    verify(PACKAGE + '.test', args.expected_test_apk_sha256, 'test-before')
    component = PACKAGE + '.test/' + RUNNER
    listing = adb('shell', 'pm', 'list', 'instrumentation')
    if f'instrumentation:{component} (target={PACKAGE})' not in listing.splitlines():
        raise RuntimeError('Missing exact isolated instrumentation target')
    raw = adb('shell', 'am', 'instrument', '-w', '-r', '-e', 'selected', args.selected, component)
    (output / 'instrumentation.log').write_text(raw + '\n')
    fields = {}
    for line in raw.splitlines():
        match = re.fullmatch(r'INSTRUMENTATION_RESULT: ([A-Za-z]+)=(.*)', line)
        if match:
            name, value = match.groups()
            if name in fields:
                raise RuntimeError('Duplicate instrumentation result')
            fields[name] = value
    if fields.get('result') != 'passed' or fields.get('existingRecordsUnchanged') != 'true' or fields.get('selectedPublicKey') != args.selected:
        raise RuntimeError('Native record probe failed; inspect its retained step/result')
    if 'INSTRUMENTATION_CODE: -1' not in raw.splitlines() or not fields.get('assertions', '').isdigit() or int(fields['assertions']) < 1:
        raise RuntimeError('Incomplete native record probe')
    verify(PACKAGE, args.expected_apk_sha256, 'app-after')
    verify(PACKAGE + '.test', args.expected_test_apk_sha256, 'test-after')
    if before != {name: sha(root / name) for name in relatives} or sdk_sources != {name: sha(sdk / name) for name in sdk_sources}:
        raise RuntimeError('Owning sources changed during native execution')
    record = {'status': 'passed', 'serial': args.serial, 'package': PACKAGE, 'assertions': int(fields['assertions']),
              'selectedPublicKey': args.selected, 'existingRecordsUnchanged': True, 'sourceSha256': before,
              'apkSha256': args.expected_apk_sha256, 'testApkSha256': args.expected_test_apk_sha256,
              'secureStoreVersion': contract['version'], 'secureStoreSourceSha256': sdk_sources,
              'scope': fields.get('scope'), 'device': adb('shell', 'getprop', 'ro.product.model'),
              'api': adb('shell', 'getprop', 'ro.build.version.sdk')}
    (output / 'result.json').write_text(json.dumps(record, indent=2) + '\n'); print(json.dumps(record))


if __name__ == '__main__':
    main()
