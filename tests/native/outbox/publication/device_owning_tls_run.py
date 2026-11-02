#!/usr/bin/env python3
"""Physical Android shell-UID owner/WSS fault suite; controlled route, no app or protected signer."""
import argparse
import difflib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import threading
import time
import uuid
import zipfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
MODULE = ROOT / 'modules/napplet-host/android'
HOST = MODULE / 'src/main/java/org/nostrocket/hypergolic/host'
KEEPER = 'org.nostrocket.hypergolic.emptyacceptance'
spec = importlib.util.spec_from_file_location('owner_tls', HERE / 'android_owning_tls_run.py')
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    sdk = ROOT / '.tools/android-sdk'
    tools = sdk / 'build-tools/36.0.0'
    android = sdk / 'platforms/android-36/android.jar'
    adb = [str(sdk / 'platform-tools/adb'), '-s', args.serial]
    receipt = {'status': 'failed', 'scope': __doc__, 'cases': [], 'commands': [], 'cleanup': [],
               'limits': ['Shell UID 2000, not installed app UID or Expo/guest composition',
                          'Unchanged owner and downstream WSS, one test-only publish route wrapper',
                          'Loopback DNS/address policy and disposable public TLS anchor',
                          'Pre-signed public fixture; no protected signer, key access or public publication',
                          'No OS suspend, UI lifecycle, complete fanout or full acceptance claim']}
    owned = {}
    mappings = {}
    key = out / 'server.key'
    cert = out / 'server.pem'
    suffix = uuid.uuid4().hex
    release_remote = '/data/local/tmp/hg-outbox-owner-' + suffix + '.release'
    release_texts = ['release after fifth denied before transport\n', 'release on cleanup\n']

    def persist():
        (out / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')

    def run(command, name, cwd=ROOT, timeout=180):
        with (out / (name + '.log')).open('w') as log:
            result = subprocess.run(command, cwd=cwd, stdout=log, stderr=subprocess.STDOUT, timeout=timeout)
        receipt['commands'].append({'name': name, 'exitCode': result.returncode})
        persist()
        result.check_returncode()

    def device(*values, check=True, timeout=30):
        result = subprocess.run([*adb, *values], capture_output=True, text=True, timeout=timeout)
        receipt['commands'].append({'arguments': list(values), 'stdout': result.stdout,
                                    'stderr': result.stderr, 'exitCode': result.returncode})
        if check:
            result.check_returncode()
        return result

    def remote_sha(remote):
        value = device('shell', 'sha256sum', remote).stdout.split()[0]
        assert re.fullmatch('[0-9a-f]{64}', value)
        return value

    def forward(listener):
        port = listener.getsockname()[1]
        prior = device('reverse', '--list').stdout.splitlines()
        assert not any('tcp:' + str(port) in line.split() for line in prior), 'Refuse replacing existing mapping'
        device('reverse', 'tcp:' + str(port), 'tcp:' + str(port))
        mappings[port] = 'tcp:' + str(port)
        assert any(line.split()[-2:] == [mappings[port], mappings[port]] for line in device('reverse', '--list').stdout.splitlines())
        return port

    def remove_mapping(port):
        expected = mappings[port]
        lines = device('reverse', '--list').stdout.splitlines()
        assert sum(line.split()[-2:] == [expected, expected] for line in lines) == 1, 'Mapping changed'
        device('reverse', '--remove', expected)
        assert not any(expected in line.split() for line in device('reverse', '--list').stdout.splitlines())
        receipt['cleanup'].append({'reverse': expected, 'absent': True})
        del mappings[port]

    def execute(mode, port, extra=()):
        result = device('shell', 'env', 'CLASSPATH=' + jar_remote, 'app_process', '/system/bin',
                        'org.nostrocket.hypergolic.host.DeviceOwnerTLSProof', str(port), cert_remote,
                        '-', mode, fixture_remote, *extra, check=False, timeout=40)
        (out / (mode + '.log')).write_text(result.stdout + result.stderr)
        lines = result.stdout.splitlines()
        if lines:
            runtime = json.loads(lines[0])
            assert runtime['uid'] == 2000 and runtime['sdk'] == 36 and runtime['frameworkJson'] and runtime['frameworkClockHandlerLooper']
            if result.returncode:
                failure = device('shell', 'logcat', '--pid', str(runtime['pid']), '-d', '-v', 'brief', '-s', 'AndroidRuntime:E')
                (out / (mode + '-owned-runtime-failure.log')).write_text(failure.stdout + failure.stderr)
        result.check_returncode()
        assert len(lines) == 2
        return runtime, json.loads(lines[1])

    try:
        assert device('get-state').stdout.strip() == 'device'
        assert device('shell', 'getprop', 'ro.build.version.sdk').stdout.strip() == '36'
        receipt['inventoryBefore'] = device('shell', 'pm', 'list', 'packages', '-3').stdout.splitlines()
        path = device('shell', 'pm', 'path', KEEPER).stdout.strip().removeprefix('package:')
        assert path.startswith('/') and '\n' not in path
        receipt['keeperBefore'] = {'path': path, 'sha256': remote_sha(path)}
        receipt['reverseBefore'] = device('reverse', '--list').stdout.splitlines()
        assert device('shell', 'test', '-e', release_remote, check=False).returncode == 1
        selected = [*HOST.glob('*.java'), *HOST.glob('*.kt'), HERE / 'fixtures.json', Path(__file__),
                    HERE / 'OwnerTLSProof.java', HERE / 'OwnerTLSRoute.java', HERE / 'OwnerCapacityProof.java',
                    HERE / 'DeviceOwnerTLSProof.java', HERE / 'android_owning_tls_run.py', HERE / 'tls_run.py',
                    ROOT / 'tests/native/android-published-https/PublishedHttpsTlsProof.java', android]
        receipt['sourceBefore'] = {str(p.relative_to(ROOT)): sha(p) for p in selected}
        run(['node', '--input-type=module', '-e', "import fs from 'node:fs';import {verifyEvent} from 'nostr-tools/pure';const f=JSON.parse(fs.readFileSync('tests/native/outbox/publication/fixtures.json'));for(const key of ['primary','list']){if(!verifyEvent(f[key]))throw Error('Invalid public fixture '+key);}console.log('Verified exact primary and ancillary public fixture signatures');"], 'independent-signatures')
        run(['./gradlew', ':hypergolic-napplet-host:compileReleaseJavaWithJavac', '--offline', '--console=plain'], 'native-compile', ROOT / 'android')
        folders = [MODULE / 'build/tmp/kotlin-classes/release', MODULE / 'build/intermediates/javac/release/compileReleaseJavaWithJavac/classes']
        receipt['compiledInputs'] = {str(p.relative_to(ROOT)): sha(p) for folder in folders for p in folder.rglob('*.class')}
        stdlib = owner.artifact('org.jetbrains.kotlin', 'kotlin-stdlib', '2.1.20')
        receipt['kotlinStdlib'] = {'path': str(stdlib.relative_to(ROOT)), 'sha256': sha(stdlib)}
        source_dir = out / 'route-adapter'
        source_dir.mkdir()
        original = (HOST / 'PublishedRelayWssQuery.java').read_text()
        assert original.count(owner.ROUTE_BEFORE) == 1
        adapted = original.replace(owner.ROUTE_BEFORE, owner.ROUTE_AFTER)
        source = source_dir / 'PublishedRelayWssQuery.java'
        source.write_text(adapted)
        patch = ''.join(difflib.unified_diff(original.splitlines(True), adapted.splitlines(True), fromfile='owning/PublishedRelayWssQuery.java', tofile='physical-route/PublishedRelayWssQuery.java'))
        (out / 'route-adapter.patch').write_text(patch)
        receipt['routeAdapter'] = {'originalSha256': hashlib.sha256(original.encode()).hexdigest(), 'adaptedSha256': sha(source), 'patchSha256': sha(out / 'route-adapter.patch')}
        classes = out / 'classes'
        classes.mkdir()
        classpath = os.pathsep.join(map(str, [*folders, stdlib, android]))
        proof_sources = [source, HERE / 'OwnerTLSProof.java', HERE / 'OwnerTLSRoute.java', HERE / 'OwnerCapacityProof.java', HERE / 'DeviceOwnerTLSProof.java', ROOT / 'tests/native/android-published-https/PublishedHttpsTlsProof.java']
        run(['javac', '--release', '17', '-Xlint:all', '-Werror', '-cp', classpath, '-d', str(classes), *map(str, proof_sources)], 'proof-compile')
        combined = out / 'native-input.jar'
        with zipfile.ZipFile(combined, 'w') as z:
            entries = {}
            for folder in [*folders, classes]:
                for p in folder.rglob('*.class'):
                    entries[p.relative_to(folder).as_posix()] = p.read_bytes()
            for name, data in entries.items(): z.writestr(name, data)
        dex = out / 'dex'
        dex.mkdir()
        run([str(tools / 'd8'), '--min-api', '36', '--lib', str(android), '--output', str(dex), str(combined), str(stdlib)], 'dex')
        for index, p in enumerate(sorted(dex.glob('*.dex'))):
            run([str(tools / 'dexdump'), '-f', str(p)], 'dex-inventory-' + str(index))
            inventory = (out / ('dex-inventory-' + str(index) + '.log')).read_text()
            assert not re.search(r"Class descriptor\s*:\s*'L(?:org/json/|android/os/)", inventory), 'Packaged definitions replace Android framework'
        jar = out / 'device-owner-proof.jar'
        run(['jar', 'cf', str(jar), '-C', str(dex), '.'], 'dex-jar')
        receipt['product'] = {'jarSha256': sha(jar), 'nativeInputJarSha256': sha(combined), 'dex': {p.name: sha(p) for p in dex.glob('*.dex')}}
        run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', str(key), '-out', str(cert), '-subj', '/CN=relay.example.org', '-addext', 'subjectAltName=DNS:relay.example.org', '-addext', 'extendedKeyUsage=serverAuth', '-addext', 'keyUsage=digitalSignature,keyEncipherment'], 'certificate')
        for local, extension in [(jar, 'jar'), (cert, 'pem'), (HERE / 'fixtures.json', 'json')]:
            remote = '/data/local/tmp/hg-outbox-owner-' + suffix + '.' + extension
            assert device('shell', 'test', '-e', remote, check=False).returncode == 1
            owned[remote] = sha(local)
            device('push', str(local), remote)
            assert remote_sha(remote) == owned[remote]
        jar_remote = next(p for p in owned if p.endswith('.jar'))
        cert_remote = next(p for p in owned if p.endswith('.pem'))
        fixture_remote = next(p for p in owned if p.endswith('.json'))
        fixture = json.loads((HERE / 'fixtures.json').read_text())
        for mode in owner.MODES:
            listener = socket.socket()
            listener.bind(('127.0.0.1', 0))
            listener.listen(1)
            trace, errors = [], []
            port = forward(listener)
            thread = threading.Thread(target=owner.serve, args=(listener, key, cert, mode, fixture, trace, errors), daemon=True)
            thread.start()
            try:
                runtime, result = execute(mode, port)
            finally:
                thread.join(timeout=16)
                if thread.is_alive(): listener.close()
                (out / (mode + '-receiver.json')).write_text(json.dumps({'observed': trace, 'errors': errors}, indent=2) + '\n')
                remove_mapping(port)
            assert not thread.is_alive() and not errors, (mode, errors)
            count = sum(row['phase'] == 'exact-event' for row in trace)
            assert count == (0 if mode in ['revoke-before-send', 'job-cancel-before-send'] else 1)
            assert result['status'] == 'passed' and result['ownerIdle'] and result['routeCalls'] == 1
            assert any(row['phase'] == 'verified-upgrade' for row in trace)
            if mode == 'silent-timeout': assert 2500 <= result['elapsedMs'] <= 8000
            if mode == 'slow-notices': assert 9000 <= result['elapsedMs'] <= 13000
            receipt['cases'].append({'mode': mode, 'runtime': runtime, 'result': result, 'eventCount': count, 'observed': trace})
            persist()
            print('PASS physical-android-owner-' + mode, flush=True)
        listener = socket.socket()
        listener.bind(('127.0.0.1', 0))
        listener.listen(5)
        trace, errors = [], []
        release = out / 'capacity-release.txt'
        port = forward(listener)
        threads = [threading.Thread(target=owner.controlled_receiver, args=(listener, key, cert, 'capacity', fixture, trace, errors, release, index), daemon=True) for index in range(5)]
        for thread in threads: thread.start()
        stopped = threading.Event()
        def mirror_release():
            deadline = time.monotonic() + 15
            while not stopped.is_set() and time.monotonic() < deadline:
                probe = subprocess.run([*adb, 'shell', 'cat', release_remote], capture_output=True, text=True, timeout=3)
                if probe.returncode == 0:
                    assert probe.stdout in release_texts
                    release.write_text(probe.stdout)
                    return
                stopped.wait(.1)
        mirror = threading.Thread(target=mirror_release, daemon=True)
        mirror.start()
        try:
            runtime, result = execute('capacity', port, [release_remote])
        finally:
            stopped.set()
            mirror.join(timeout=4)
            for thread in threads: thread.join(timeout=12)
            listener.close()
            (out / 'capacity-receiver.json').write_text(json.dumps({'observed': trace, 'errors': errors}, indent=2) + '\n')
            remove_mapping(port)
        assert not mirror.is_alive() and all(not t.is_alive() for t in threads) and not errors, errors
        assert result['status'] == 'passed' and result['ownerIdle'] and result['routeCalls'] == 5 and result['replayDenied']
        assert len(result['completed']) == 4 and result['blocked']['status'] == 'cancelled-before-send' and result['recovered']['status'] == 'accepted'
        assert sum(row['phase'] == 'exact-event' for row in trace) == 5
        receipt['capacity'] = {'runtime': runtime, 'result': result, 'eventCount': 5, 'observed': trace}
        print('PASS physical-android-owner-capacity-and-recovery', flush=True)
        assert all(sha(ROOT / p) == digest for p, digest in receipt['sourceBefore'].items())
        assert all(sha(ROOT / p) == digest for p, digest in receipt['compiledInputs'].items())
        assert sha(stdlib) == receipt['kotlinStdlib']['sha256']
        receipt['sourceAfter'] = receipt['sourceBefore'].copy()
        receipt['status'] = 'passed-scoped-physical-owner-transport'
    except BaseException as error:
        receipt['error'] = str(error) or type(error).__name__
        raise
    finally:
        for port in list(mappings):
            try: remove_mapping(port)
            except Exception as error: receipt['status'] = 'failed-cleanup'; receipt['cleanup'].append({'reversePort': port, 'error': str(error)})
        probe = device('shell', 'test', '-e', release_remote, check=False)
        if probe.returncode == 0:
            try:
                assert remote_sha(release_remote) in {hashlib.sha256(s.encode()).hexdigest() for s in release_texts}
                device('shell', 'rm', release_remote)
                assert device('shell', 'test', '-e', release_remote, check=False).returncode == 1
                receipt['cleanup'].append({'releaseFile': release_remote, 'absent': True})
            except Exception as error: receipt['status'] = 'failed-cleanup'; receipt['cleanup'].append({'releaseFile': release_remote, 'error': str(error)})
        for remote, digest in owned.items():
            try:
                assert remote_sha(remote) == digest
                device('shell', 'rm', remote)
                assert device('shell', 'test', '-e', remote, check=False).returncode == 1
                receipt['cleanup'].append({'remote': remote, 'sha256': digest, 'absent': True})
            except Exception as error: receipt['status'] = 'failed-cleanup'; receipt['cleanup'].append({'remote': remote, 'error': str(error)})
        key.unlink(missing_ok=True)
        receipt['privateTlsKeyRemoved'] = not key.exists()
        if 'keeperBefore' in receipt:
            try:
                path = device('shell', 'pm', 'path', KEEPER).stdout.strip().removeprefix('package:')
                receipt['keeperAfter'] = {'path': path, 'sha256': remote_sha(path)}
                receipt['inventoryAfter'] = device('shell', 'pm', 'list', 'packages', '-3').stdout.splitlines()
                receipt['reverseAfter'] = device('reverse', '--list').stdout.splitlines()
                assert receipt['keeperAfter'] == receipt['keeperBefore'] and receipt['inventoryAfter'] == receipt['inventoryBefore'] and receipt['reverseAfter'] == receipt['reverseBefore']
            except Exception as error: receipt['status'] = 'failed-cleanup'; receipt['keeperVerificationError'] = str(error)
        receipt['logs'] = {p.name: sha(p) for p in out.glob('*.log')}
        persist()
    if receipt['status'] != 'passed-scoped-physical-owner-transport': raise SystemExit(1)
    print(json.dumps({'status': receipt['status'], 'singleCases': len(receipt['cases']), 'capacity': receipt['capacity']['result']['status'], 'keeperUnchanged': receipt['keeperAfter'] == receipt['keeperBefore']}), flush=True)


if __name__ == '__main__':
    main()
