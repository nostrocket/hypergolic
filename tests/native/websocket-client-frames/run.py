#!/usr/bin/env python3
"""Compile Java and Swift WebSocket client encoders and run common deterministic vectors."""
import pathlib
import os
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[3]
HERE = pathlib.Path(__file__).resolve().parent
JAVA = ROOT / "modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host/PublishedRelayWebSocketClientFrames.java"
SWIFT = ROOT / "modules/napplet-host/ios/PublishedRelayWebSocketClientFrames.swift"


def run(*args, env=None):
    print("+", " ".join(map(str, args)), flush=True)
    subprocess.run(list(map(str, args)), check=True, cwd=ROOT, env=env)


with tempfile.TemporaryDirectory(prefix="hypergolic-ws-client-frames-") as temp:
    temp = pathlib.Path(temp)
    classes = temp / "classes"
    classes.mkdir()
    run("javac", "-Xlint:all", "-Werror", "-d", classes, JAVA, HERE / "VectorsJava.java")
    run("java", "-cp", classes, "org.nostrocket.hypergolic.host.VectorsJava", HERE / "vectors.tsv")
    swift = temp / "swift-vectors"
    swift_env = os.environ.copy()
    swift_env["DEVELOPER_DIR"] = "/Applications/Xcode.app/Contents/Developer"
    swift_env["CLANG_MODULE_CACHE_PATH"] = str(temp / "swift-module-cache")
    swift_env["SWIFT_MODULE_CACHE_PATH"] = str(temp / "swift-module-cache")
    swift_main = temp / "main.swift"
    shutil.copyfile(HERE / "VectorsSwift.swift", swift_main)
    run("xcrun", "swiftc", "-module-cache-path", temp / "swift-module-cache", "-warnings-as-errors",
        SWIFT, swift_main, "-o", swift, env=swift_env)
    run(swift, HERE / "vectors.tsv")
