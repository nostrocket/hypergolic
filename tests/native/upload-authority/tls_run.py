#!/usr/bin/env python3
"""Actual Java/Swift raw TLS PUTs to isolated servers; not SDK/native UI acceptance."""
import base64
import hashlib
import json
from pathlib import Path
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
JAVA = ROOT / 'modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host'
SWIFT = ROOT / 'modules/napplet-host/ios'
BODY = bytes([1, 2, 3])
HASH = hashlib.sha256(BODY).hexdigest()


def certificate(out, host):
    key, pem, der = (out / (host + suffix) for suffix in ['.key', '.pem', '.der'])
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                    '-keyout', str(key), '-out', str(pem), '-subj', '/CN=' + host,
                    '-addext', 'subjectAltName=DNS:' + host, '-addext', 'extendedKeyUsage=serverAuth',
                    '-addext', 'keyUsage=digitalSignature,keyEncipherment'], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(['openssl', 'x509', '-in', str(pem), '-outform', 'DER', '-out', str(der)], check=True)
    return key, pem, der


def serve(listener, cert, key, mode, observed, errors):
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(str(cert), str(key))
    listener.settimeout(3.0 if mode not in ['cancel-before', 'mixed-dns'] else 1.0)
    try:
        raw, _ = listener.accept()
        observed['connections'] += 1
        raw.settimeout(8)
        with context.wrap_socket(raw, server_side=True) as peer:
            wire = bytearray()
            while b'\r\n\r\n' not in wire:
                chunk = peer.recv(8192)
                if not chunk:
                    return
                wire.extend(chunk)
                if len(wire) > 16384:
                    raise AssertionError('oversized request header')
            head, body = bytes(wire).split(b'\r\n\r\n', 1)
            lines = head.decode('ascii').split('\r\n')
            assert lines[0] == 'PUT /upload HTTP/1.1'
            headers = dict(line.split(': ', 1) for line in lines[1:])
            assert len(headers) == len(lines) - 1
            assert headers['Content-Length'] == '3' and headers['X-SHA-256'] == HASH
            assert headers['Content-Type'] == 'application/octet-stream'
            assert headers['Host'].startswith('files.example.com:')
            token = headers['Authorization'].removeprefix('Nostr ')
            auth = json.loads(base64.urlsafe_b64decode(token + '=' * ((4 - len(token) % 4) % 4)))
            assert auth['kind'] == 24242 and auth['pubkey'] == '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
            assert auth['tags'] == [['t', 'upload'], ['x', HASH], ['server', 'files.example.com'], ['expiration', '1120']]
            assert auth['content'] == 'Upload reviewed file to https://' + headers['Host']
            verified = subprocess.check_output(['node', '--input-type=module', '-e',
                "import{verifyEvent}from'nostr-tools/pure';let raw='';for await(const bytes of process.stdin)raw+=bytes;process.stdout.write(String(verifyEvent(JSON.parse(raw))));"],
                input=json.dumps(auth), text=True, cwd=ROOT)
            assert verified == 'true', 'authorization signature failed at independent server observer'
            while len(body) < 3:
                part = peer.recv(3 - len(body))
                if not part:
                    break
                body += part
            assert body == BODY, 'stored bytes differ from native reviewed bytes'
            observed['requests'] += 1
            observed['sha256'] = hashlib.sha256(body).hexdigest()
            if mode in ['loss-ack', 'cancel-after']:
                if mode == 'cancel-after':
                    time.sleep(0.1)
                return
            status = {'existing': 200, 'denied': 403, 'large': 413, 'quota': 429, 'redirect': 307}.get(mode, 201)
            receipt = json.dumps({'url': 'https://files.example.com/' + HASH + '.bin', 'sha256': HASH,
                                  'size': len(body), 'type': 'application/octet-stream', 'uploaded': 1001}).encode()
            location = b'Location: https://other.example.com/upload\r\n' if mode == 'redirect' else b''
            peer.sendall(b'HTTP/1.1 ' + str(status).encode() + b' Fixture\r\n' + location +
                         b'Content-Type: application/json\r\nContent-Length: ' + str(len(receipt)).encode() +
                         b'\r\nConnection: close\r\n\r\n' + receipt)
    except (socket.timeout, ConnectionError, ssl.SSLError, OSError) as error:
        if mode not in ['untrusted', 'wrong-host', 'cancel-before', 'mixed-dns', 'cancel-after']:
            errors.append(str(error))
    except (AssertionError, ValueError) as error:
        errors.append(str(error))
    finally:
        listener.close()


def main():
    with tempfile.TemporaryDirectory(prefix='hypergolic-upload-tls-') as temporary:
        out = Path(temporary)
        good_key, good_pem, good_der = certificate(out, 'files.example.com')
        wrong_key, wrong_pem, wrong_der = certificate(out, 'other.example.com')
        java_names = ['NativeSigningHold', 'UploadFileProfile', 'UploadPngProfile', 'UploadPngMetadata', 'NativeUploadAuthority', 'NativeBlossomPermit', 'PublishedHttpsRequestOwner',
                      'PublishedHttpsTransport', 'PublishedHttpsResponseReader', 'PublicAddressPolicy', 'UploadPinnedHttpsTransport']
        subprocess.run(['javac', '-Xlint:all', '-Werror', '-d', str(out),
                        *[str(JAVA / (name + '.java')) for name in java_names], str(HERE/'UploadTLSProof.java')], check=True)
        swift_names = ['UploadFileProfile', 'UploadPngProfile', 'UploadPngMetadata', 'NativeUploadAuthority', 'NativeBlossomPermit', 'PublishedHTTPResponse',
                       'PublishedPinnedHTTPS', 'PublicAddressPolicy', 'UploadPinnedHTTPS']
        subprocess.run(['swiftc', '-swift-version', '6', '-D', 'HYPERGOLIC_NETWORK_PROOF', '-warnings-as-errors',
                        '-module-cache-path', str(out/'swift-cache'), *[str(SWIFT/(name+'.swift')) for name in swift_names],
                        str(HERE/'UploadTLSProof.swift'), '-o', str(out/'swift-proof')], check=True)
        rows = []
        for language in (sys.argv[1:] or ['Java', 'Swift']):
            assert language in ['Java', 'Swift']
            for mode in ['valid', 'existing', 'switch', 'denied', 'large', 'quota', 'redirect', 'loss-ack',
                         'cancel-before', 'cancel-after', 'mixed-dns', 'untrusted', 'wrong-host']:
                key, pem, der = (wrong_key, wrong_pem, wrong_der) if mode == 'wrong-host' else (good_key, good_pem, good_der)
                listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                listener.bind(('127.0.0.1', 0)); listener.listen(1)
                port = listener.getsockname()[1]
                tokens = json.loads(subprocess.check_output(['node', str(HERE/'credential-fixtures.mjs'),
                                    'https://files.example.com:' + str(port)], cwd=ROOT, text=True))
                observed, errors = {'connections': 0, 'requests': 0}, []
                worker = threading.Thread(target=serve, args=(listener, pem, key, mode, observed, errors), daemon=True)
                worker.start()
                command = ['java', '-cp', str(out), 'org.nostrocket.hypergolic.host.UploadTLSProof', str(port), str(pem), tokens[0], mode] if language == 'Java' else [str(out/'swift-proof'), str(port), str(der), tokens[0], mode]
                result = json.loads(subprocess.check_output(command, cwd=ROOT, text=True, timeout=12))
                worker.join(timeout=5)
                assert not worker.is_alive() and not errors, (language, mode, errors, observed, result)
                if mode in ['valid', 'existing', 'switch']:
                    assert result.get('status') == (200 if mode == 'existing' else 201) and result['dispatched'], (mode, result)
                else:
                    expected = {'denied': 'server rejected', 'large': 'file too large', 'quota': 'quota exceeded',
                                'redirect': 'outcome unknown', 'loss-ack': 'outcome unknown', 'cancel-after': 'outcome unknown',
                                'cancel-before': 'policy denied', 'mixed-dns': 'policy denied', 'untrusted': 'upload failed', 'wrong-host': 'upload failed'}[mode]
                    assert result.get('error') == expected, (language, mode, result)
                    assert result['dispatched'] == (mode in ['denied', 'large', 'quota', 'redirect', 'loss-ack', 'cancel-after']), (language, mode, result)
                no_request = mode in ['cancel-before', 'mixed-dns', 'untrusted', 'wrong-host']
                assert observed['requests'] == (0 if no_request else 1), (language, mode, observed)
                if mode in ['cancel-before', 'mixed-dns']:
                    assert observed['connections'] == 0, (language, mode, observed)
                rows.append({'language': language, 'mode': mode, **result, 'observer': observed})
                print(json.dumps(rows[-1]), flush=True)
        print(json.dumps({'nativeTlsUploadCases': len(rows), 'failed': 0}), flush=True)


if __name__ == '__main__':
    main()
