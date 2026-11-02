#!/usr/bin/env python3
"""Compile and run the Android native HTTPS operation-owner proof on the host JVM."""
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
JAVA_ROOT = ROOT / "modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host"
PROOF = Path(__file__).with_name("PublishedHttpsRequestOwnerProof.java")
JDK = ROOT / ".tools/jdk/Contents/Home/bin"
JAVAC = str(JDK / "javac") if (JDK / "javac").is_file() else "javac"
JAVA = str(JDK / "java") if (JDK / "java").is_file() else "java"

with tempfile.TemporaryDirectory(prefix="published-https-owner-proof-") as temp:
    out = Path(temp)
    subprocess.run([
        JAVAC, "-Xlint:all", "-Werror", "-d", str(out),
        str(JAVA_ROOT / "PublishedHttpsTransport.java"),
        str(JAVA_ROOT / "PublishedHttpsResponseReader.java"),
        str(JAVA_ROOT / "PublicAddressPolicy.java"),
        str(JAVA_ROOT / "PublishedHttpsRequestOwner.java"),
        str(PROOF),
    ], check=True)
    subprocess.run([
        JAVA, "-cp", str(out), "org.nostrocket.hypergolic.host.PublishedHttpsRequestOwnerProof",
    ], check=True)
