#!/usr/bin/env python3
"""Compile and run the Android WSS policy proof on a host JVM."""
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
HOST = ROOT / "modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host"
SOURCES = [
    HOST / "PublicAddressPolicy.java",
    HOST / "PublishedHttpsResponseReader.java",
    HOST / "PublishedHttpsTransport.java",
    HOST / "PublishedHttpsRequestOwner.java",
    HOST / "PublishedRelayWebSocketHandshake.java",
    HOST / "PublishedRelayWebSocketFrames.java",
    HOST / "PublishedRelayWebSocketClientFrames.java",
    HOST / "PublishedRelayWssQuery.java",
    HOST / "PublishedRelayWssIo.java",
    HOST / "PublishedRelayResponseClassifier.java",
    HOST / "PublishedRelayWssRequestOwner.java",
    Path(__file__).with_name("PublishedRelayWssQueryProof.java"),
    Path(__file__).with_name("PublishedRelayResponseClassifierProof.java"),
    Path(__file__).with_name("PublishedRelayWssRequestOwnerProof.java"),
    ROOT / "tests/native/android-published-https/PublishedHttpsTlsProof.java",
    Path(__file__).with_name("PublishedRelayWssTlsProof.java"),
]
JDK = ROOT / ".tools/jdk/Contents/Home/bin"
JAVAC = str(JDK / "javac") if (JDK / "javac").is_file() else "javac"
JAVA = str(JDK / "java") if (JDK / "java").is_file() else "java"

with tempfile.TemporaryDirectory(prefix="published-wss-proof-") as temp:
    cert = Path(temp) / "server.pem"
    key = Path(temp) / "server.key"
    pkcs12 = Path(temp) / "server.p12"
    subprocess.run([
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
        "-keyout", str(key), "-out", str(cert), "-subj", "/CN=relay.example.org",
        "-addext", "subjectAltName=DNS:relay.example.org",
    ], check=True, capture_output=True)
    subprocess.run([
        "openssl", "pkcs12", "-export", "-inkey", str(key), "-in", str(cert),
        "-out", str(pkcs12), "-passout", "pass:temporary-proof",
    ], check=True, capture_output=True)
    subprocess.run([JAVAC, "-Xlint:all", "-Werror", "-d", temp, *map(str, SOURCES)], check=True)
    subprocess.run([JAVA, "-cp", temp, "org.nostrocket.hypergolic.host.PublishedRelayWssQueryProof"], check=True)
    subprocess.run([JAVA, "-cp", temp, "org.nostrocket.hypergolic.host.PublishedRelayResponseClassifierProof"], check=True)
    subprocess.run([JAVA, "-cp", temp, "org.nostrocket.hypergolic.host.PublishedRelayWssRequestOwnerProof"], check=True)
    subprocess.run([
        JAVA, "-cp", temp, "org.nostrocket.hypergolic.host.PublishedRelayWssTlsProof",
        str(cert), str(pkcs12),
    ], check=True)
