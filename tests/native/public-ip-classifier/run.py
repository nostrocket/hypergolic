#!/usr/bin/env python3
"""Compile and execute the actual Java and Swift address classifiers against one vector set."""

from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = Path(__file__).resolve().parent
JAVA_DIR = ROOT / "modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host"
IOS_DIR = ROOT / "modules/napplet-host/ios"
LOCAL_JDK = ROOT / ".tools/jdk/Contents/Home/bin"


def run(*command: str) -> None:
    print("+", " ".join(command), flush=True)
    subprocess.run(command, cwd=ROOT, check=True)


with tempfile.TemporaryDirectory(prefix="hypergolic-public-address-") as temp:
    output = Path(temp)
    javac = str(LOCAL_JDK / "javac") if (LOCAL_JDK / "javac").is_file() else "javac"
    java = str(LOCAL_JDK / "java") if (LOCAL_JDK / "java").is_file() else "java"
    run(javac, "-Xlint:all", "-Werror", "-d", str(output),
        str(JAVA_DIR / "PublicAddressPolicy.java"),
        str(FIXTURES / "PublicAddressPolicyProof.java"))
    run(java, "-cp", str(output), "org.nostrocket.hypergolic.host.PublicAddressPolicyProof",
        str(FIXTURES / "vectors.tsv"))
    swift_binary = output / "ios-public-address-proof"
    run("swiftc", "-warnings-as-errors", "-module-cache-path", str(output / "swift-modules"),
        str(IOS_DIR / "PublicAddressPolicy.swift"),
        str(FIXTURES / "PublicAddressPolicyProof.swift"), "-o", str(swift_binary))
    run(str(swift_binary), str(FIXTURES / "vectors.tsv"))
