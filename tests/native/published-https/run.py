#!/usr/bin/env python3
"""Compile the actual Swift HTTPS owner and exercise bounded offline contract cases."""

from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
NATIVE = ROOT / "modules/napplet-host/ios"
PROOF = Path(__file__).resolve().parent / "PublishedHTTPResponseProof.swift"


with tempfile.TemporaryDirectory(prefix="hypergolic-published-https-") as temporary:
    output = Path(temporary)
    binary = output / "published-https-proof"
    command = [
        "swiftc", "-warnings-as-errors", "-module-cache-path", str(output / "swift-modules"),
        "-o", str(binary),
        str(NATIVE / "PublicAddressPolicy.swift"),
        str(NATIVE / "PublishedHTTPResponse.swift"),
        str(NATIVE / "PublishedPinnedHTTPS.swift"),
        str(PROOF),
    ]
    subprocess.run(command, cwd=ROOT, check=True)
    subprocess.run([str(binary)], cwd=ROOT, check=True)
