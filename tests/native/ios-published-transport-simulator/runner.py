#!/usr/bin/env python3
"""Run both owning Swift TLS proofs in a booted iPhone Simulator with a receipt."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[3]
NATIVE = ROOT / "modules/napplet-host/ios"
HTTPS = ROOT / "tests/native/published-https"
WSS = ROOT / "tests/native/ios-published-wss"
SOURCES = [
    NATIVE / name for name in (
        "NativeUploadAuthority.swift", "UploadFileProfile.swift", "UploadPngMetadata.swift", "UploadPngProfile.swift",
        "PublicAddressPolicy.swift", "PublishedHTTPResponse.swift", "PublishedPinnedHTTPS.swift",
        "PublishedRelayWebSocketHandshake.swift", "PublishedRelayWebSocketFrames.swift",
        "PublishedRelayWebSocketClientFrames.swift", "PublishedRelayWebSocketQuery.swift", "NativeSignerRelayPolicy.swift", "PublishedRelayEnvelope.swift",
    )
] + [
    HTTPS / "PublishedHTTPSTlsProof.swift", HTTPS / "tls_runner.py",
    WSS / "PublishedRelayWssTlsProof.swift", WSS / "tls_runner.py",
    Path(__file__).resolve(),
]
RUNNERS = [
    ("https", HTTPS / "tls_runner.py", {
        "valid": 1, "failover": 1, "untrusted": 1, "wrong-host": 1,
        "redirect": 1, "cancel": 1, "mixed-dns": 4,
    }),
    ("wss", WSS / "tls_runner.py", {
        "valid": 1, "failover": 1, "untrusted": 1, "wrong-host": 1,
        "redirect": 1, "bad-accept": 1, "oversize": 1, "cancel": 1, "auth-announcement": 1,
    }),
]


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def simulator_info(udid: str) -> dict[str, str]:
    result = subprocess.run(["xcrun", "simctl", "list", "devices", "-j"],
                            cwd=ROOT, capture_output=True, text=True, check=True)
    for runtime, devices in json.loads(result.stdout)["devices"].items():
        for device in devices:
            if device.get("udid") == udid:
                if device.get("state") != "Booted":
                    raise RuntimeError("The selected iPhone Simulator is not booted")
                return {"udid": udid, "name": device["name"], "runtime": runtime}
    raise RuntimeError("The selected iPhone Simulator was not found")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--simulator", required=True, help="Explicit booted arm64 iPhone Simulator UDID")
    parser.add_argument("--output", required=True, type=Path, help="New directory for the JSON receipt")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    before = {str(path.relative_to(ROOT)): sha256(path) for path in SOURCES}
    receipt: dict[str, object] = {
        "scope": "Standalone Swift HTTPS/WSS TLS proof binaries in iPhone Simulator; not the Expo app",
        "sourceSha256": before,
        "status": "failed",
    }
    try:
        receipt["simulator"] = simulator_info(args.simulator)
        env = os.environ.copy()
        env["HYPERGOLIC_TLS_SIMULATOR_UDID"] = args.simulator
        cases: dict[str, dict[str, int]] = {}
        for label, runner, expected in RUNNERS:
            result = subprocess.run(["python3", str(runner)], cwd=ROOT, env=env,
                                    capture_output=True, text=True, timeout=90, check=True)
            observed: dict[str, int] = {}
            for line in result.stdout.splitlines():
                parsed = json.loads(line)
                mode = parsed["mode"]
                if mode in observed or parsed.get("failed") != 0:
                    raise AssertionError(f"Duplicate or failed {label} mode: {mode}")
                observed[mode] = parsed["checks"]
            if observed != expected:
                raise AssertionError(f"{label} cases differ: {observed}")
            cases[label] = observed
            print(f"{label}: {sum(observed.values())} checks passed", flush=True)
        if before != {str(path.relative_to(ROOT)): sha256(path) for path in SOURCES}:
            raise AssertionError("Owning source changed during Simulator proof")
        receipt["checks"] = cases
        receipt["status"] = "passed"
    except Exception as error:
        receipt["error"] = str(error)[:500]
        raise
    finally:
        (args.output / "result.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
