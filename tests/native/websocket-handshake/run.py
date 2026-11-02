#!/usr/bin/env python3
"""Compile both native handshake validators and run the same RFC 6455 vectors."""
import os
import pathlib
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[3]
HERE = pathlib.Path(__file__).resolve().parent
JAVA = ROOT / "modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host/PublishedRelayWebSocketHandshake.java"
SWIFT = ROOT / "modules/napplet-host/ios/PublishedRelayWebSocketHandshake.swift"


def run(*args, env=None):
    print("+", " ".join(map(str, args)), flush=True)
    subprocess.run(list(map(str, args)), check=True, cwd=ROOT, env=env)


with tempfile.TemporaryDirectory(prefix="hypergolic-ws-handshake-") as temp:
    temp = pathlib.Path(temp)
    classes = temp / "classes"
    classes.mkdir()
    run("javac", "-Xlint:all", "-Werror", "-d", classes, JAVA, HERE / "VectorsJava.java")
    run("java", "-cp", classes, "org.nostrocket.hypergolic.host.VectorsJava", HERE / "vectors.tsv")
    swift_env = os.environ.copy()
    swift_env["CLANG_MODULE_CACHE_PATH"] = str(temp / "swift-module-cache")
    swift = temp / "swift-vectors"
    run("swiftc", "-module-cache-path", temp / "swift-module-cache", "-warnings-as-errors",
        SWIFT, HERE / "VectorsSwift.swift", "-o", swift, env=swift_env)
    run(swift, HERE / "vectors.tsv")
