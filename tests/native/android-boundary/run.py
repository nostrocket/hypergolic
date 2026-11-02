#!/usr/bin/env python3
"""Run already installed, exactly sealed disposable boundary APKs; never installs or resets."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import uuid
from urllib.parse import urlsplit
import ipaddress

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
PACKAGE = 'org.nostrocket.hypergolic.androidboundaryprobe'
RUNNER = 'org.nostrocket.hypergolic.boundary.BoundaryInstrumentation'
CASES = ['real-frame-and-opaque-isolation', 'native-schema-generation-and-replay',
    'actual-same-origin-child-native-rejection', 'actual-native-queue-bounds',
    'native-foreground-and-close-revocation', 'actual-native-utf8-wire-and-snapshot-bounds',
    'actual-renderer-termination-and-fresh-generation']


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(serial, build, output, network_receiver=None, network_nonce=None):
    if bool(network_receiver) != bool(network_nonce):
        raise RuntimeError('Receiver URL and nonce must be supplied together')
    if network_receiver:
        url = urlsplit(network_receiver)
        if url.scheme != 'http' or not url.hostname or not url.port or url.path or url.query or url.fragment or url.username or url.password or not ipaddress.ip_address(url.hostname).is_private or ipaddress.ip_address(url.hostname).is_loopback or not re.fullmatch('[a-f0-9]{32}', network_nonce):
            raise RuntimeError('Require an explicit nonce-scoped private LAN HTTP receiver')
    output = output.resolve()
    if output == REPO or REPO in output.parents:
        raise RuntimeError('Use fresh external evidence, never the source directory')
    output.mkdir(parents=True, exist_ok=False)
    build = build.resolve()
    result = {'schema': 1, 'status': 'failed-or-incomplete', 'serial': serial, 'package': PACKAGE,
        'dateUTC': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'runId': 'boundary-' + uuid.uuid4().hex, 'networkReceiver': network_receiver, 'networkNonce': network_nonce, 'installedByRunner': False, 'instrumentationAttempted': False,
        'scope': 'Exact source-linked native transport/fault cases; no whole physical/SEC acceptance claim'}
    adb_path = Path(os.environ['ANDROID_HOME']) / 'platform-tools/adb'

    def adb(*args, timeout=60):
        try:
            process = subprocess.run([str(adb_path), '-s', serial, *args], capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired as error:
            if 'instrument' in args:
                raw = error.stdout or ''
                (output / 'instrumentation.log').write_text(raw.decode() if isinstance(raw, bytes) else raw)
            raise RuntimeError('Observation timed out; do not replay until native job state is reconciled') from error
        if 'instrument' in args:
            (output / 'instrumentation.log').write_text(process.stdout + process.stderr)
        if process.returncode != 0:
            raise RuntimeError('ADB observation/action failed; preserve evidence and reconcile before retry')
        return process.stdout.strip()

    def installed(package):
        path = adb('shell', 'pm', 'path', package)
        if not re.fullmatch(r'package:/data/app/[A-Za-z0-9_~+/=.\-]+/base\.apk', path):
            raise RuntimeError('Require exactly one standalone installed sealed APK')
        observed = adb('shell', 'sha256sum', path[len('package:'):]).split()
        if len(observed) != 2 or not re.fullmatch('[0-9a-f]{64}', observed[0]):
            raise RuntimeError('Incomplete installed-byte observation')
        return {'path': path, 'sha256': observed[0]}

    def inputs():
        expected = json.loads((HERE / 'expected-inputs.json').read_text())['sources']
        observed = {name: sha(REPO / name) for name in expected}
        if observed != expected:
            raise RuntimeError('Owning native/runtime input changed; review and rebuild before running')
        source = json.loads((build / 'source-inputs.json').read_text())
        # The normal Expo app and instrumentation are compiled from these owning inputs.
        for name, digest in source.items():
            if name.startswith(('src/', 'modules/', 'runtime/', 'plugins/', 'android/')) or name in ['index.ts', 'app.json', 'package.json', 'pnpm-lock.yaml'] or name.startswith('tests/native/android-boundary/') and not name.endswith('.md'):
                if not (REPO / name).is_file() or sha(REPO / name) != digest:
                    raise RuntimeError('Compiled implementation/test input changed: rebuild before running')
        observed.update({str(p.relative_to(REPO)): sha(p) for p in [HERE / 'run.py', HERE / 'build.py', HERE / 'init.gradle', HERE / 'AndroidManifest.xml', HERE / 'NetworkControlManifest.xml', HERE / 'src/org/nostrocket/hypergolic/boundary/NetworkProbe.java', HERE / 'src/org/nostrocket/hypergolic/boundary/BoundaryInstrumentation.java']})
        return observed

    try:
        receipt = json.loads((build / 'receipt.json').read_text())
        if receipt['status'] != 'compiled-not-executed' or not receipt['sourceInputsUnchanged'] or receipt['applicationId'] != PACKAGE or receipt['testApplicationId'] != PACKAGE + '.test':
            raise RuntimeError('Incomplete or wrong-target build receipt')
        if bool(receipt.get('networkControlCleartext')) != bool(network_receiver):
            raise RuntimeError('Network arguments must match the sealed test-only control overlay')
        before = inputs(); result['sourceInputs'] = before
        for kind in ['app', 'test']:
            if sha(build / (kind + '.apk')) != receipt['products'][kind]['sha256']:
                raise RuntimeError('Sealed local APK changed')
        result['physical'] = adb('shell', 'getprop', 'ro.kernel.qemu') != '1'
        result['api'] = adb('shell', 'getprop', 'ro.build.version.sdk')
        result['model'] = adb('shell', 'getprop', 'ro.product.model')
        (output / 'webview-update.txt').write_text(adb('shell', 'dumpsys', 'webviewupdate') + '\n')
        installed_before = {kind: installed(PACKAGE + ('.test' if kind == 'test' else '')) for kind in ['app', 'test']}
        for kind in ['app', 'test']:
            if installed_before[kind]['sha256'] != receipt['products'][kind]['sha256']:
                raise RuntimeError('Installed product differs from the sealed exact build')
        result['installedBefore'] = installed_before
        component = PACKAGE + '.test/' + RUNNER
        if 'instrumentation:' + component + ' (target=' + PACKAGE + ')' not in adb('shell', 'pm', 'list', 'instrumentation').splitlines():
            raise RuntimeError('Exact disposable instrumentation registration is missing')
        result['instrumentationAttempted'] = True
        command = ['shell', 'am', 'instrument', '-w', '-r', '-e', 'runId', result['runId']]
        if network_receiver:
            command += ['-e', 'receiverURL', network_receiver, '-e', 'receiverNonce', network_nonce]
        raw = adb(*command, component, timeout=180)
        (output / 'instrumentation.log').write_text(raw + '\n')
        fields = {}
        for line in raw.splitlines():
            match = re.fullmatch(r'INSTRUMENTATION_RESULT: ([A-Za-z]+)=(.*)', line)
            if match:
                key, value = match.groups()
                if key in fields:
                    raise RuntimeError('Duplicate native result field')
                fields[key] = json.loads(value) if key in ['cases', 'probes'] else value
        result['native'] = fields
        after = inputs(); result['sourceInputsUnchanged'] = before == after
        installed_after = {kind: installed(PACKAGE + ('.test' if kind == 'test' else '')) for kind in ['app', 'test']}
        result['installedAfter'] = installed_after
        result['installedProductsUnchanged'] = installed_before == installed_after
        cases = fields.get('cases', []); probes = fields.get('probes', [])
        expected_cases = CASES + (['independent-network-receiver-and-guest-denials'] if network_receiver else [])
        if fields.get('result') != 'passed' or 'INSTRUMENTATION_CODE: -1' not in raw.splitlines() or [case['name'] for case in cases] != expected_cases or not all(case['status'] == 'passed' and case['assertions'] > 0 for case in cases):
            raise RuntimeError('Complete selected native run did not pass; retain its original failure')
        if not probes or not all(probe.get('closed') is True for probe in probes) or fields.get('cleanup') == 'failed' or not result['sourceInputsUnchanged'] or not result['installedProductsUnchanged']:
            raise RuntimeError('Incomplete cleanup or changed source/installed products')
        if int(fields['assertions']) < sum(case['assertions'] for case in cases):
            raise RuntimeError('Incomplete native assertion accounting')
        result['status'] = 'passed-scoped-physical-native' if result['physical'] else 'passed-scoped-emulator-native'
    except Exception as error:
        result['error'] = str(error)
    finally:
        (output / 'receipt.json').write_text(json.dumps(result, indent=2) + '\n')
    print(str(output / 'receipt.json'))
    if not result['status'].startswith('passed-scoped-'):
        raise RuntimeError(result.get('error', 'Native run incomplete'))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--build', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--network-receiver', help='Independent private LAN HTTP receiver, no trailing slash')
    parser.add_argument('--network-nonce', help='Fresh 32-character hexadecimal receiver nonce')
    args = parser.parse_args()
    run(args.serial, args.build, args.output, args.network_receiver, args.network_nonce)
