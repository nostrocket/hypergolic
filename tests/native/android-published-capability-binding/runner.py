#!/usr/bin/env python3
"""Compile the Android published-capability binding rules on a host JVM."""
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
HOST = ROOT / "modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host"
PROOF = Path(__file__).with_name("PublishedCapabilityBindingProof.java")
JDK = ROOT / ".tools/jdk/Contents/Home/bin"
JAVAC = str(JDK / "javac") if (JDK / "javac").is_file() else "javac"
JAVA = str(JDK / "java") if (JDK / "java").is_file() else "java"

with tempfile.TemporaryDirectory(prefix="published-capability-proof-") as temp:
    subprocess.run([JAVAC, "-Xlint:all", "-Werror", "-d", temp,
                    str(HOST / "PublishedCapabilityBinding.java"), str(PROOF)], check=True)
    subprocess.run([JAVA, "-cp", temp,
                    "org.nostrocket.hypergolic.host.PublishedCapabilityBindingProof"], check=True)
