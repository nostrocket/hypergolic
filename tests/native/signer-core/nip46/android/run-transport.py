#!/usr/bin/env python3
"""Host proof of the production Android native signer WSS route and unchanged ordinary caps."""
from pathlib import Path
import hashlib
import json
import os
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[5]
HERE = Path(__file__).resolve().parent
HOST = ROOT / 'modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host'
NAMES = ['PublicAddressPolicy', 'PublishedHttpsResponseReader', 'PublishedHttpsTransport',
         'PublishedHttpsRequestOwner', 'PublishedRelayWebSocketHandshake', 'PublishedRelayWebSocketFrames',
         'PublishedRelayWebSocketClientFrames', 'PublishedRelayWssQuery', 'PublishedRelayWssIo',
         'PublishedRelayResponseClassifier', 'NativeSignerRelayOpening', 'NativeSignerRelay']
SOURCES = [HOST / (name + '.java') for name in NAMES] + [
    ROOT / 'tests/native/android-published-https/PublishedHttpsTlsProof.java', HERE / 'NativeSignerRelayProof.java', HERE / 'NativeSignerRelayFixture.java']
JDK = ROOT / '.tools/jdk/Contents/Home/bin'
SDK = Path(os.environ.get('ANDROID_HOME', str(ROOT / '.tools/android-sdk'))) / 'platforms/android-36/android.jar'

def hashes():
    return {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in SOURCES + [Path(__file__).resolve()]}

before = hashes()
with tempfile.TemporaryDirectory(prefix='native-signer-relay-') as temp:
    temp = Path(temp)
    cert, key, p12 = [temp / name for name in ('server.pem', 'server.key', 'server.p12')]
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                    '-keyout', str(key), '-out', str(cert), '-subj', '/CN=relay.example.org',
                    '-addext', 'subjectAltName=DNS:relay.example.org'], check=True, capture_output=True)
    subprocess.run(['openssl', 'pkcs12', '-export', '-inkey', str(key), '-in', str(cert), '-out', str(p12),
                    '-passout', 'pass:temporary-proof'], check=True, capture_output=True)
    subprocess.run([str(JDK / 'javac'), '-Xlint:all', '-Werror', '-cp', str(SDK), '-d', str(temp), *map(str, SOURCES)], check=True)
    subprocess.run([str(JDK / 'java'), '-cp', str(temp) + os.pathsep + str(SDK),
                    'org.nostrocket.hypergolic.host.NativeSignerRelayProof', str(cert), str(p12)], check=True)
if hashes() != before:
    raise SystemExit('Source changed during owning proof')
print(json.dumps({'status': 'PASS', 'sourceUnchanged': True, 'temporaryTlsMaterialRemoved': True,
                  'evidenceScope': 'host JVM with real controlled TLS; no device-runtime claim', 'sources': before}, indent=2))
