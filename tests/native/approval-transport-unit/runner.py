#!/usr/bin/env python3
"""Compile and test the exact iOS native approval transport in a disposable package."""
import argparse, hashlib, json, os, subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
SOURCES = [
    "modules/napplet-host/ios/NativeApprovalAuthority.swift",
    "modules/napplet-host/ios/NativeOutboxPlan.swift",
    "modules/napplet-host/ios/PublishedRelayWebSocketClientFrames.swift",
    "modules/napplet-host/ios/CapabilityLeaseRegistry.swift",
    "modules/napplet-host/ios/CapabilityTransport.swift",
    "modules/napplet-host/ios/ApprovalTransport.swift",
]

def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()

def validate_inputs():
    expected = json.loads((HERE / "source-manifest.json").read_text())
    groups = {
        "productionSources": {name: REPO / name for name in SOURCES},
        "testSources": {"Tests/ApprovalTransportTests.swift": HERE / "Tests/ApprovalTransportTests.swift"},
        "harnessFiles": {name: HERE / name for name in ("README.md", "Package.swift.template", "runner.py")},
    }
    for group, paths in groups.items():
        actual = {name: digest(path) for name, path in paths.items() if path.is_file() and not path.is_symlink()}
        if len(actual) != len(paths) or actual != expected[group]:
            raise RuntimeError("Reviewed approval transport source changed in " + group)
    return expected

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build-root", type=Path, required=True)
    args = parser.parse_args()
    before = validate_inputs()
    root = args.build_root.resolve()
    if root.exists(): raise RuntimeError("Use a fresh build root")
    package = root / "package"
    source_dir = package / "Sources/ApprovalTransport"
    source_dir.mkdir(parents=True)
    for source in SOURCES:
        destination = REPO / source
        (source_dir / destination.name).symlink_to(os.path.relpath(destination, source_dir))
    (package / "Tests").symlink_to(os.path.relpath(HERE / "Tests", package))
    (package / "Package.swift").write_bytes((HERE / "Package.swift.template").read_bytes())
    environment = dict(os.environ, CLANG_MODULE_CACHE_PATH=str(root / "clang-cache"),
        SWIFTPM_MODULECACHE_OVERRIDE=str(root / "swift-module-cache"))
    command = ["xcrun", "swift", "test", "--disable-sandbox", "--package-path", str(package),
        "--scratch-path", str(root / "build"), "--cache-path", str(root / "cache"),
        "--config-path", str(root / "config"), "--security-path", str(root / "security")]
    with (root / "test.log").open("w") as log:
        result = subprocess.run(command, env=environment, stdout=log, stderr=subprocess.STDOUT, timeout=300)
    receipt = {"schema": 1, "status": "passed" if result.returncode == 0 else "failed",
        "command": command, "exitCode": result.returncode, "inputs": before,
        "sourceUnchanged": before == validate_inputs(), "testLogSha256": digest(root / "test.log")}
    (root / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    if result.returncode or not receipt["sourceUnchanged"]:
        raise RuntimeError("Approval transport tests failed or source changed; see preserved receipt/log")
    print(json.dumps({"status": "passed", "receipt": str(root / "receipt.json")}))

if __name__ == "__main__": main()
