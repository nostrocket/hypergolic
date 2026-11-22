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
    binary = out / "proof"
    subprocess.run(["swiftc", "-O", "-swift-version", "6", "-warnings-as-errors", "-module-cache-path", out / "swift-modules",
                    "-import-objc-header", NATIVE / "BodyVerifier/PublishedBodyEnvelope.h", "-lc++", "-lsqlite3",
                    NATIVE / "PublishedArtifactRegistry.swift", NATIVE / "PublishedArtifactTransfer.swift", NATIVE / "PublishedBodyStore.swift",
                    Path(__file__).with_name("PublishedBodyProof.swift"), object_file, "-o", binary], check=True)
    subprocess.run([binary], check=True)
