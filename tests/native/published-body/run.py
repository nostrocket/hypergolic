"""Exercise the production C++ verifier, SQLite body store and Swift one-use registry on macOS."""
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
NATIVE = ROOT / "modules/napplet-host/ios"
with tempfile.TemporaryDirectory(prefix="published-body-proof-") as temporary:
    out = Path(temporary)
    object_file = out / "envelope.o"
    subprocess.run(["clang++", "-std=c++17", "-O2", "-Wall", "-Wextra", "-Werror", "-c",
                    NATIVE / "BodyVerifier/PublishedBodyEnvelope.cpp", "-o", object_file], check=True)
    vendor = ROOT / "node_modules/expo-sqlite/vendor/sqlite3"
    expo_object, copy_object = out / "expo-sqlite.o", out / "cache-interop.o"
    subprocess.run(["clang", "-O1", "-DSQLITE_THREADSAFE=1", "-DSQLITE_TEMP_STORE=2", "-c", vendor / "sqlite3.c", "-o", expo_object], check=True)
    subprocess.run(["clang", "-Wall", "-Wextra", "-Werror", "-I", vendor, "-I", NATIVE / "BodyVerifier",
                    "-c", Path(__file__).with_name("CacheInterop.c"), "-o", copy_object], check=True)
    binary = out / "proof"
    subprocess.run(["swiftc", "-O", "-swift-version", "6", "-warnings-as-errors", "-module-cache-path", out / "swift-modules",
                    "-Xcc", "-I" + str(NATIVE / "BodyVerifier"), "-import-objc-header", Path(__file__).with_name("CacheInterop.h"), "-lc++", "-lsqlite3",
                    NATIVE / "PublishedArtifactRegistry.swift", NATIVE / "PublishedArtifactTransfer.swift", NATIVE / "PublishedBodyStore.swift",
                    Path(__file__).with_name("PublishedBodyProof.swift"), object_file, expo_object, copy_object, "-o", binary], check=True)
    subprocess.run([binary], check=True)
