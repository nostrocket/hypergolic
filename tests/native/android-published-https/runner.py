#!/usr/bin/env python3
"""Compile and run the Android HTTPS URL-contract proof on the host JVM."""
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / "modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host/PublishedHttpsTransport.java"
POLICY = ROOT / "modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host/PublicAddressPolicy.java"
RESPONSE_READER = ROOT / "modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host/PublishedHttpsResponseReader.java"
PROOF = Path(__file__).with_name("PublishedHttpsTransportProof.java")
JDK = ROOT / ".tools/jdk/Contents/Home/bin"
JAVAC = str(JDK / "javac") if (JDK / "javac").is_file() else "javac"
JAVA = str(JDK / "java") if (JDK / "java").is_file() else "java"

with tempfile.TemporaryDirectory(prefix="published-https-proof-") as temp:
    out = Path(temp)
    cert = out / "server.pem"
    key = out / "server.key"
    pkcs12 = out / "server.p12"
    subprocess.run([
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
        "-keyout", str(key), "-out", str(cert), "-subj", "/CN=napplets.example.org",
        "-addext", "subjectAltName=DNS:napplets.example.org",
    ], check=True, capture_output=True)
    subprocess.run([
        "openssl", "pkcs12", "-export", "-inkey", str(key), "-in", str(cert),
        "-out", str(pkcs12), "-passout", "pass:temporary-proof",
    ], check=True, capture_output=True)
    subprocess.run([
        JAVAC, "-Xlint:all", "-Werror", "-d", str(out), str(SOURCE), str(POLICY), str(RESPONSE_READER),
        str(PROOF), str(Path(__file__).with_name("PublishedHttpsTlsProof.java")),
    ], check=True)
    subprocess.run([
        JAVA, "-cp", str(out), "org.nostrocket.hypergolic.host.PublishedHttpsTransportProof",
    ], check=True)
    subprocess.run([
        JAVA, "-cp", str(out), "org.nostrocket.hypergolic.host.PublishedHttpsTlsProof",
        str(cert), str(pkcs12),
    ], check=True)
