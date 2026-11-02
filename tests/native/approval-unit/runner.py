#!/usr/bin/env python3
"""Compile and test the exact owning Swift native approval authority in a disposable package."""
import argparse, hashlib, json, os, subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
SOURCE = "modules/napplet-host/ios/NativeApprovalAuthority.swift"


def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()


def validate_inputs():
    expected = json.loads((HERE / "source-manifest.json").read_text())
    groups = {
        "productionSources": {SOURCE: REPO / SOURCE},
        "testSources": {"Tests/NativeApprovalAuthorityTests.swift": HERE / "Tests/NativeApprovalAuthorityTests.swift"},
        "harnessFiles": {name: HERE / name for name in ("README.md", "Package.swift.template", "runner.py")},
    }
    for group, paths in groups.items():
        actual = {}
        for name, path in paths.items():
            if not path.is_file() or path.is_symlink():
                raise RuntimeError("Missing regular owning source: " + name)
            actual[name] = digest(path)
        if actual != expected[group]:
            raise RuntimeError("Reviewed approval source changed in " + group)
    return expected


def exact_link(link, destination):
    expected = os.path.relpath(destination, link.parent)
    if link.is_symlink():
        if os.readlink(link) != expected or link.resolve() != destination.resolve():
            raise RuntimeError("Generated source link points elsewhere; use a fresh build root")
    elif link.exists():
        raise RuntimeError("Generated source path is a copy; use a fresh build root")
    else:
        link.symlink_to(expected)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build-root", type=Path, required=True)
    args = parser.parse_args()
    before = validate_inputs()
    build_root = args.build_root.resolve()
    if build_root.exists():
        raise RuntimeError("Use a fresh build root")
    package = build_root / "package"
    source_dir = package / "Sources/NativeApprovalAuthority"
    source_dir.mkdir(parents=True)
    exact_link(source_dir / "NativeApprovalAuthority.swift", REPO / SOURCE)
    exact_link(package / "Tests", HERE / "Tests")
    (package / "Package.swift").write_bytes((HERE / "Package.swift.template").read_bytes())
    environment = dict(os.environ,
        CLANG_MODULE_CACHE_PATH=str(build_root / "clang-cache"),
        SWIFTPM_MODULECACHE_OVERRIDE=str(build_root / "swift-module-cache"))
    command = ["xcrun", "swift", "test", "--disable-sandbox", "--package-path", str(package),
        "--scratch-path", str(build_root / "build"), "--cache-path", str(build_root / "cache"),
        "--config-path", str(build_root / "config"), "--security-path", str(build_root / "security")]
    with (build_root / "test.log").open("w") as log:
        result = subprocess.run(command, env=environment, stdout=log, stderr=subprocess.STDOUT, timeout=300)
    receipt = {"schema": 1, "status": "passed" if result.returncode == 0 else "failed",
        "command": command, "exitCode": result.returncode, "inputs": before,
        "sourceUnchanged": before == validate_inputs(), "testLogSha256": digest(build_root / "test.log")}
    (build_root / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    if result.returncode or not receipt["sourceUnchanged"]:
        raise RuntimeError("Approval authority tests failed or source changed; see preserved receipt/log")
    print(json.dumps({"status": "passed", "receipt": str(build_root / "receipt.json")}))


if __name__ == "__main__": main()
