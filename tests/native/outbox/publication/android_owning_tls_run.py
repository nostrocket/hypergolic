#!/usr/bin/env python3
"""Android host owner fault proof with declared clock/UI initialization and loopback route adapters."""
import argparse
import base64
import difflib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import ssl
import time
import threading

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
HOST = ROOT / 'modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host'
spec = importlib.util.spec_from_file_location('owner_tls_core', HERE / 'tls_run.py')
tls = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tls)
MODES = ['accepted', 'accepted-close', 'rejected', 'missing', 'wrong-id', 'malformed',
         'auth-required', 'revoke-before-send', 'trailing-data', 'trailing-nul',
         'concatenated', 'oversized-reason', 'multibyte-overflow',
         'job-cancel-before-send', 'revoke-after-send', 'job-cancel-after-send',
         'silent-timeout', 'slow-notices', 'notice-flood', 'oversized-frame'] + tls.INVALID_ACK_MODES
ROUTE_BEFORE = '''    return queryWithTransport(url, event, PublishedHttpsRequestOwner.addressPolicy(), control, stop,
        InetAddress::getAllByName, DNS, defaultFactory(), HttpsURLConnection.getDefaultHostnameVerifier());'''
ROUTE_AFTER = '    return OwnerTLSRoute.publish(url, event, control, stop);'


def inputs():
    files = [*HOST.glob('*.java'), *HOST.glob('*.kt'), HERE / 'fixtures.json', HERE / 'tls_run.py',
             HERE / 'run.py', Path(__file__), HERE / 'OwnerTLSProof.java', HERE / 'OwnerTLSRoute.java', HERE / 'OwnerCapacityProof.java',
             *(HERE / 'android-host' / name for name in ['SystemClock.java', 'Handler.java', 'Looper.java']),
             ROOT / 'tests/native/android-published-https/PublishedHttpsTlsProof.java',
             tls.core.ANDROID / 'build.gradle', ROOT / 'android/gradle.properties', ROOT / 'pnpm-lock.yaml']
    return {str(p.relative_to(ROOT)): tls.digest(p) for p in files}


def serve(listener, key, cert, mode, fixture, trace, errors):
    # Reuse the independently checking receiver, with the exact expected no-send/unknown cases.
    receiver_mode = {'job-cancel-before-send': 'revoke-before-send',
                     'revoke-after-send': 'missing', 'job-cancel-after-send': 'missing'}.get(mode, mode)
    if mode in ['silent-timeout', 'slow-notices', 'notice-flood', 'oversized-frame']:
        controlled_receiver(listener, key, cert, mode, fixture, trace, errors)
    else:
        tls.serve(listener, key, cert, receiver_mode, fixture, trace, errors)


def controlled_receiver(listener, key, cert, mode, fixture, trace, errors, release=None, connection=None):
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    row = {'mode': mode, 'connection': connection}
    try:
        listener.settimeout(12)
        raw, _ = listener.accept(); raw.settimeout(15)
        with context.wrap_socket(raw, server_side=True) as peer:
            headers = b''
            while b'\r\n\r\n' not in headers:
                headers += tls.exact(peer, 1)
                assert len(headers) < 8192
            assert headers.startswith(b'GET /fixture HTTP/1.1\r\nHost: relay.example.org:')
            nonce = next(line.split(b':', 1)[1].strip() for line in headers.split(b'\r\n')
                         if line.lower().startswith(b'sec-websocket-key:'))
            accept = base64.b64encode(hashlib.sha1(nonce + b'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest())
            peer.sendall(b'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + b'\r\n\r\n')
            trace.append({**row, 'phase': 'verified-upgrade'})
            wire = tls.read_frame(peer)
            assert json.loads(wire) == ['EVENT', fixture['primary']]
            trace.append({**row, 'phase': 'exact-event', 'wire': wire,
                          'sha256': hashlib.sha256(wire.encode()).hexdigest(), 'eventId': fixture['primary']['id']})
            if mode == 'capacity':
                deadline = time.monotonic() + 8
                while not release.exists():
                    assert time.monotonic() < deadline, 'Capacity release was not signalled'
                    time.sleep(0.01)
                ack = json.dumps(['OK', fixture['primary']['id'], True, 'stored'], separators=(',', ':'))
                peer.sendall(tls.frame(ack)); trace.append({**row, 'phase': 'ack', 'wire': ack})
                return
            notices = 0
            if mode == 'notice-flood':
                peer.sendall(tls.frame('["NOTICE","bounded flood fixture"]') * 65)
                trace.append({**row, 'phase': 'notice-flood-sent', 'messages': 65})
            elif mode == 'oversized-frame':
                declared = 2 * 1024 * 1024 + 1
                header = b'\x81\x7f' + declared.to_bytes(8, 'big')
                peer.sendall(header)
                trace.append({**row, 'phase': 'oversized-header-sent', 'declaredBytes': declared, 'headerHex': header.hex()})
            elif mode == 'slow-notices':
                started = time.monotonic()
                try:
                    while time.monotonic() - started < 13:
                        peer.sendall(tls.frame('["NOTICE","keepalive without ACK"]'))
                        notices += 1
                        time.sleep(0.25)
                except (OSError, ssl.SSLError) as stopped:
                    trace.append({**row, 'phase': 'peer-stopped', 'exceptionType': type(stopped).__name__})
                trace.append({**row, 'phase': 'slow-notices-sent', 'messages': notices})
                return
            # Silent peers and fault headers keep the socket open until the client actually stops it.
            end = peer.recv(1)
            assert end == b'', 'Client emitted unexpected extra bytes'
            trace.append({**row, 'phase': 'client-closed'})
    except Exception as error:
        errors.append(str(error))
    finally:
        if mode != 'capacity': listener.close()


def capacity_proof(out, cp, key, cert, fixture, receipt):
    listener = socket.socket(); listener.bind(('127.0.0.1', 0)); listener.listen(5)
    trace, errors = [], []
    release = out / 'capacity-release.txt'
    threads = [threading.Thread(target=controlled_receiver,
               args=(listener, key, cert, 'capacity', fixture, trace, errors, release, index), daemon=True)
               for index in range(5)]
    for thread in threads: thread.start()
    try:
        tls.run(['java', '-cp', cp, 'org.nostrocket.hypergolic.host.OwnerCapacityProof',
                 str(listener.getsockname()[1]), str(cert), '-', 'capacity', str(HERE / 'fixtures.json'), str(release)],
                out, 'capacity')
    finally:
        for thread in threads: thread.join(timeout=12)
        listener.close()
        (out / 'capacity-receiver.json').write_text(json.dumps({'observed': trace, 'errors': errors}, indent=2) + '\n')
    assert all(not thread.is_alive() for thread in threads) and not errors, errors
    result = json.loads((out / 'capacity.log').read_text())
    assert result['status'] == 'passed' and result['ownerIdle'] is True and result['routeCalls'] == 5 and result['replayDenied'] is True
    assert len(result['completed']) == 4 and result['blocked']['status'] == 'cancelled-before-send'
    assert result['recovered']['status'] == 'accepted'
    assert sum(row['phase'] == 'exact-event' for row in trace) == 5
    receipt['capacity'] = {**result, 'eventCount': 5, 'observed': trace}
    print('PASS android-owner-capacity-and-recovery', flush=True)


def artifact(group, name, version):
    directory = ROOT / '.tools/gradle-home/caches/modules-2/files-2.1' / group / name / version
    matches = list(directory.glob('*/*.jar'))
    if len(matches) != 1:
        raise RuntimeError(f'Expected one cached artifact {group}:{name}:{version}')
    return matches[0]


def compile_proof(out, receipt):
    tls.run(['./gradlew', ':hypergolic-napplet-host:compileReleaseJavaWithJavac', '--offline', '--console=plain'],
            out, 'android-compile', ROOT / 'android')
    classes = [tls.core.ANDROID / 'build/tmp/kotlin-classes/release',
               tls.core.ANDROID / 'build/intermediates/javac/release/compileReleaseJavaWithJavac/classes']
    jars = [artifact('org.json', 'json', '20180813'), artifact('org.jetbrains.kotlin', 'kotlin-stdlib', '2.1.20')]
    proof_classes = out / 'classes'
    proof_classes.mkdir()
    # These exact production class files are executed; only the WSS publish route wrapper is adapted.
    names = ['NativeSigningHold', 'OutboxPublicationOwner', 'ApprovalTransport', 'ApprovalLeaseRegistry', 'NativeApprovalAuthority',
             'NativeOutboxPlan', 'OutboxAcknowledgement']
    owned = [p for directory in classes for p in directory.rglob('*.class')
             if any(p.name == name + '.class' or p.name.startswith(name + '$') for name in names)]
    assert all(any(p.name == name + '.class' for p in owned) for name in names)
    receipt['compiledDependencyInputs'] = {str(p.relative_to(ROOT)): tls.digest(p)
        for directory in classes for p in directory.rglob('*.class')}
    receipt['cachedDependencyInputs'] = {str(p.relative_to(ROOT)): tls.digest(p) for p in jars}
    receipt['compiledOwnerInputs'] = {str(p.relative_to(ROOT)): tls.digest(p) for p in owned}
    cp = os.pathsep.join(map(str, [proof_classes, *classes, *jars]))
    original = (HOST / 'PublishedRelayWssQuery.java').read_text()
    assert original.count(ROUTE_BEFORE) == 1, 'Production publish route changed; review adapter before running'
    adapted = original.replace(ROUTE_BEFORE, ROUTE_AFTER)
    source_dir = out / 'route-adapter'
    source_dir.mkdir()
    source = source_dir / 'PublishedRelayWssQuery.java'
    source.write_text(adapted)
    patch = ''.join(difflib.unified_diff(original.splitlines(True), adapted.splitlines(True),
                                       fromfile='owning/PublishedRelayWssQuery.java', tofile='host-route/PublishedRelayWssQuery.java'))
    (out / 'route-adapter.patch').write_text(patch)
    receipt['routeAdapter'] = {'originalSha256': hashlib.sha256(original.encode()).hexdigest(),
                              'adaptedSha256': tls.digest(source), 'patchSha256': tls.digest(out / 'route-adapter.patch'),
                              'changedScope': 'Only publish entry forwards controlled route; owner and downstream WSS source unchanged'}
    sources = [source, HERE / 'OwnerTLSProof.java', HERE / 'OwnerTLSRoute.java', HERE / 'OwnerCapacityProof.java', HERE / 'OwnerCapacityProof.java',
               ROOT / 'tests/native/android-published-https/PublishedHttpsTlsProof.java',
               *(HERE / 'android-host' / name for name in ['SystemClock.java', 'Handler.java', 'Looper.java'])]
    tls.run(['javac', '-Xlint:all', '-Werror', '-cp', cp, '-d', str(proof_classes), *map(str, sources)],
            out, 'android-proof-compile')
    return cp


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    receipt = {'status': 'failed', 'scope': __doc__, 'sourceBefore': inputs(), 'runs': [],
               'limits': ['Host JVM org.json differs from Android platform parser',
                          'System.nanoTime clock does not model Android suspend',
                          'Handler/Looper only initialize production transport; UI queue calls fail',
                          'Published WSS route entry adapted to controlled loopback; public policy untested',
                          'Already signed public fixture; no protected signer, guest, Expo or phone execution']}
    key, cert, p12 = out / 'server.key', out / 'server.pem', out / 'server.p12'
    try:
        tls.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', str(key),
                 '-out', str(cert), '-subj', '/CN=relay.example.org', '-addext', 'subjectAltName=DNS:relay.example.org',
                 '-addext', 'extendedKeyUsage=serverAuth', '-addext', 'keyUsage=digitalSignature,keyEncipherment'],
                out, 'certificate')
        cp = compile_proof(out, receipt)
        fixture = json.loads((HERE / 'fixtures.json').read_text())
        for mode in MODES:
            listener = socket.socket()
            listener.bind(('127.0.0.1', 0)); listener.listen(1)
            trace, errors = [], []
            thread = threading.Thread(target=serve, args=(listener, key, cert, mode, fixture, trace, errors), daemon=True)
            thread.start()
            try:
                tls.run(['java', '-cp', cp, 'org.nostrocket.hypergolic.host.OwnerTLSProof',
                         str(listener.getsockname()[1]), str(cert), '-', mode, str(HERE / 'fixtures.json')], out, mode)
            finally:
                thread.join(timeout=12)
                if thread.is_alive(): listener.close()
                (out / (mode + '-receiver.json')).write_text(json.dumps({'observed': trace, 'errors': errors}, indent=2) + '\n')
            assert not thread.is_alive() and not errors, (mode, errors)
            result = json.loads((out / (mode + '.log')).read_text())
            event_count = sum(row['phase'] == 'exact-event' for row in trace)
            expected = 0 if mode in ['revoke-before-send', 'job-cancel-before-send'] else 1
            assert result['status'] == 'passed' and result['ownerIdle'] is True and result['routeCalls'] == 1 and event_count == expected
            assert any(row['phase'] == 'verified-upgrade' for row in trace)
            if mode == 'silent-timeout': assert 2500 <= result['elapsedMs'] <= 8000
            if mode == 'slow-notices': assert 9000 <= result['elapsedMs'] <= 13000
            receipt['runs'].append({**result, 'eventCount': event_count, 'observed': trace})
            print('PASS android-owner-' + mode, flush=True)
        capacity_proof(out, cp, key, cert, fixture, receipt)
        receipt['sourceAfter'] = inputs()
        assert receipt['sourceBefore'] == receipt['sourceAfter']
        assert all(tls.digest(ROOT / path) == sha for path, sha in receipt['compiledOwnerInputs'].items())
        assert all(tls.digest(ROOT / path) == sha for path, sha in receipt['compiledDependencyInputs'].items())
        assert all(tls.digest(ROOT / path) == sha for path, sha in receipt['cachedDependencyInputs'].items())
        receipt['adaptedClasses'] = {str(p.relative_to(out)): tls.digest(p) for p in (out / 'classes').rglob('*.class')}
        receipt['status'] = 'passed'
    finally:
        key.unlink(missing_ok=True); p12.unlink(missing_ok=True)
        receipt['logs'] = {p.name: tls.digest(p) for p in out.glob('*.log')}
        (out / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')


if __name__ == '__main__':
    main()
