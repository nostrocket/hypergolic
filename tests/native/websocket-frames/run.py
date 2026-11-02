#!/usr/bin/env python3
"""Compile the production Java and Swift frame decoders against one shared vector set."""
import pathlib
import subprocess
import tempfile
import os

ROOT = pathlib.Path(__file__).resolve().parents[3]
VECTORS = pathlib.Path(__file__).with_name("vectors.tsv")
JAVA = ROOT / "modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host/PublishedRelayWebSocketFrames.java"
SWIFT = ROOT / "modules/napplet-host/ios/PublishedRelayWebSocketFrames.swift"
JAVA_TEST = pathlib.Path(__file__).with_name("FrameVectorsJava.java")
SWIFT_TEST = pathlib.Path(__file__).with_name("FrameVectorsSwift.swift")


def run(*args, env=None):
    print("+", " ".join(map(str, args)), flush=True)
    subprocess.run(list(map(str, args)), check=True, cwd=ROOT, env=env)


with tempfile.TemporaryDirectory(prefix="hypergolic-ws-frames-") as temp:
    temp = pathlib.Path(temp)
    failures = []
    classes = temp / "classes"
    classes.mkdir()
    try:
        run("javac", "-Xlint:all", "-Werror", "-d", classes, JAVA, JAVA_TEST)
        run("java", "-cp", classes, "org.nostrocket.hypergolic.host.FrameVectorsJava", VECTORS)
    except (subprocess.CalledProcessError, FileNotFoundError) as error:
        failures.append("Java proof failed or no JDK is installed: " + str(error))
    swift_binary = temp / "swift-frame-vectors"
    swift_env = os.environ.copy()
    swift_env["CLANG_MODULE_CACHE_PATH"] = str(temp / "swift-module-cache")
    swift_sdk = os.environ.get("HYPERGOLIC_SWIFT_SDK")
    if swift_sdk:
        swift_args = ["-sdk", swift_sdk]
    else:
        swift_args = []
    try:
        run("swiftc", *swift_args, "-module-cache-path", temp / "swift-module-cache",
            "-warnings-as-errors", SWIFT, SWIFT_TEST, "-o", swift_binary, env=swift_env)
        run(swift_binary, VECTORS)
    except (subprocess.CalledProcessError, FileNotFoundError) as error:
        failures.append("Swift proof failed: " + str(error))
    if failures:
        raise SystemExit("\n".join(failures))
