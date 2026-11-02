#!/usr/bin/env python3
"""Compile and execute the iOS published-host parser and one-use reader proof."""
import argparse
import json
import os
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
SOURCES = [
    "modules/napplet-host/ios/CapabilityLeaseRegistry.swift",
    "modules/napplet-host/ios/CapabilityTransport.swift",
    "modules/napplet-host/ios/PublishedArtifactRegistry.swift",
    "modules/napplet-host/ios/PublishedArtifactTransfer.swift",
    "modules/napplet-host/ios/PublishedArtifactHost.swift",
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build-root", type=Path, required=True)
    args = parser.parse_args()
    root = args.build_root.resolve()
    if root.exists():
        raise RuntimeError("Use a fresh build root")
    root.mkdir(parents=True)
    binary = root / "PublishedArtifactHostProof"
    command = ["xcrun", "swiftc", "-warnings-as-errors", "-o", str(binary)]
    command.extend(str(REPO / source) for source in SOURCES)
    command.append(str(HERE / "PublishedArtifactHostProof.swift"))
    environment = dict(os.environ, CLANG_MODULE_CACHE_PATH=str(root / "clang-cache"))
    with (root / "test.log").open("w") as log:
        build = subprocess.run(command, cwd=REPO, env=environment, stdout=log, stderr=subprocess.STDOUT, timeout=180)
        if build.returncode:
            raise RuntimeError("Swift proof compile failed; see " + str(root / "test.log"))
        result = subprocess.run([str(binary)], cwd=REPO, env=environment,
            stdout=log, stderr=subprocess.STDOUT, timeout=60)
    receipt = {"schema": 1, "status": "passed" if result.returncode == 0 else "failed",
        "compileCommand": command, "exitCode": result.returncode}
    (root / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    if result.returncode:
        raise RuntimeError("Published artifact host proof failed; see " + str(root / "test.log"))
    print(json.dumps(receipt))


if __name__ == "__main__":
    main()
