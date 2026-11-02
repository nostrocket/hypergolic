#!/usr/bin/env python3
"""Run WSS parser proofs on macOS and compile the production query for iOS Simulator."""

from pathlib import Path
import os
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
NATIVE = ROOT / "modules/napplet-host/ios"
FIXTURE = Path(__file__).resolve().parent
SOURCES = [
    NATIVE / "NativeUploadAuthority.swift",
    NATIVE / "UploadFileProfile.swift",
    NATIVE / "UploadPngMetadata.swift",
    NATIVE / "UploadPngProfile.swift",

    NATIVE / "PublicAddressPolicy.swift",
    NATIVE / "PublishedHTTPResponse.swift",
    NATIVE / "PublishedPinnedHTTPS.swift",
    NATIVE / "PublishedRelayWebSocketHandshake.swift",
    NATIVE / "PublishedRelayWebSocketFrames.swift",
    NATIVE / "PublishedRelayWebSocketClientFrames.swift",
    NATIVE / "PublishedRelayWebSocketQuery.swift",
    NATIVE / "NativeSignerRelayPolicy.swift",
    NATIVE / "PublishedRelayEnvelope.swift",
]


def select_xcode() -> dict[str, str]:
    environment = os.environ.copy()
    selected = environment.get("DEVELOPER_DIR")
    if not selected:
        result = subprocess.run(["xcode-select", "-p"], text=True, capture_output=True)
        candidate = result.stdout.strip()
        if candidate.endswith("/Contents/Developer"):
            selected = candidate
        else:
            candidate = "/Applications/Xcode.app/Contents/Developer"
            if Path(candidate).is_dir():
                selected = candidate
    if not selected or not Path(selected).is_dir():
        raise SystemExit("Full Xcode is required for the iOS Simulator compile")
    environment["DEVELOPER_DIR"] = selected
    return environment


def sdk_path(sdk: str, environment: dict[str, str]) -> str:
    result = subprocess.run(
        ["xcrun", "--sdk", sdk, "--show-sdk-path"],
        cwd=ROOT, env=environment, text=True, capture_output=True, check=True,
    )
    return result.stdout.strip()


def run(command: list[str], environment: dict[str, str]) -> None:
    print("+", " ".join(command), flush=True)
    subprocess.run(command, cwd=ROOT, env=environment, check=True)


environment = select_xcode()
macos_sdk = sdk_path("macosx", environment)
simulator_sdk = sdk_path("iphonesimulator", environment)

with tempfile.TemporaryDirectory(prefix="hypergolic-ios-published-wss-") as temporary:
    output = Path(temporary)
    proof = output / "published-wss-proof"
    run([
        "xcrun", "swiftc", "-swift-version", "6", "-warnings-as-errors", "-sdk", macos_sdk,
        "-module-cache-path", str(output / "macos-modules"), "-parse-as-library",
        "-o", str(proof), *(str(source) for source in SOURCES),
        str(FIXTURE / "PublishedRelayWebSocketQueryProof.swift"),
    ], environment)
    run([str(proof)], environment)

    run([
        "xcrun", "swiftc", "-swift-version", "6", "-warnings-as-errors", "-target", "arm64-apple-ios18.4-simulator",
        "-sdk", simulator_sdk, "-module-cache-path", str(output / "simulator-modules"),
        "-parse-as-library", "-emit-module", "-emit-module-path", str(output / "PublishedRelayWSS.swiftmodule"),
        *(str(source) for source in SOURCES),
    ], environment)

print("macOS WSS proof and arm64 iOS Simulator compile passed")
