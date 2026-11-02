#!/usr/bin/env python3
"""Exercise the actual Swift WSS owner against disposable loopback TLS relays."""

import base64
import hashlib
from pathlib import Path
import os
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[3]
NATIVE = ROOT / "modules/napplet-host/ios"
PROOF = Path(__file__).resolve().parent / "PublishedRelayWssTlsProof.swift"
SOURCES = [
    "NativeUploadAuthority.swift",
    "UploadFileProfile.swift",
    "UploadPngMetadata.swift",
    "UploadPngProfile.swift",

    "PublicAddressPolicy.swift", "PublishedHTTPResponse.swift", "PublishedPinnedHTTPS.swift",
    "PublishedRelayWebSocketHandshake.swift", "PublishedRelayWebSocketFrames.swift",
    "PublishedRelayWebSocketClientFrames.swift", "PublishedRelayWebSocketQuery.swift", "NativeSignerRelayPolicy.swift", "PublishedRelayEnvelope.swift",
]


def identity(directory: Path, name: str) -> tuple[Path, Path, Path]:
    key = directory / f"{name}.key"
    cert = directory / f"{name}.pem"
    der = directory / f"{name}.der"
    subprocess.run([
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
        "-keyout", str(key), "-out", str(cert), "-subj", f"/CN={name}",
        "-addext", f"subjectAltName=DNS:{name}",
        "-addext", "extendedKeyUsage=serverAuth",
        "-addext", "keyUsage=digitalSignature,keyEncipherment",
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(["openssl", "x509", "-in", str(cert), "-outform", "DER", "-out", str(der)], check=True)
    return key, cert, der


def read_exact(peer: ssl.SSLSocket, length: int) -> bytes:
    output = bytearray()
    while len(output) < length:
        part = peer.recv(length - len(output))
        if not part:
            raise ConnectionError("peer closed before frame completion")
        output.extend(part)
    return bytes(output)


def read_request_frame(peer: ssl.SSLSocket) -> str:
    first, second = read_exact(peer, 2)
    if first != 0x81 or not second & 0x80 or second & 0x7F >= 126:
        raise AssertionError("REQ was not a bounded masked text frame")
    mask = read_exact(peer, 4)
    encoded = read_exact(peer, second & 0x7F)
    return bytes(value ^ mask[index % 4] for index, value in enumerate(encoded)).decode("utf-8")


def frame(text: str) -> bytes:
    body = text.encode("utf-8")
    return bytes([0x81, len(body)]) + body


def serve(mode: str, key: Path, cert: Path, listener: socket.socket,
          observed: list[str], errors: list[str]) -> None:
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certfile=str(cert), keyfile=str(key))
    listener.settimeout(9)
    try:
        raw, _ = listener.accept()
        observed.append("accepted")
        raw.settimeout(5)
        with context.wrap_socket(raw, server_side=True) as peer:
            request = bytearray()
            while b"\r\n\r\n" not in request and len(request) < 8192:
                part = peer.recv(8192)
                if not part:
                    return
                request.extend(part)
            observed.append("upgrade")
            if not request.startswith(b"GET /fixture HTTP/1.1\r\n") or b"Host: relay.example.org:" not in request:
                errors.append("unexpected upgrade request")
            if mode == "redirect":
                peer.sendall(b"HTTP/1.1 302 Found\r\nLocation: wss://elsewhere.example.org/\r\n\r\n")
                return
            header = next((line for line in request.split(b"\r\n") if line.lower().startswith(b"sec-websocket-key: ")), None)
            if header is None:
                errors.append("missing WebSocket key")
                return
            key_value = header.split(b":", 1)[1].strip()
            accept = base64.b64encode(hashlib.sha1(key_value + b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest())
            if mode == "bad-accept":
                accept = b"invalid"
            peer.sendall(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + b"\r\n\r\n")
            if mode == "bad-accept":
                return
            req = read_request_frame(peer)
            observed.append("req")
            if req != '["REQ","proof",{"kinds":[35129]}]':
                errors.append("wrong masked REQ payload")
            if mode == "cancel":
                time.sleep(0.8)
            elif mode == "oversize":
                peer.sendall(b"\x81\x7f" + (66_561).to_bytes(8, "big"))
            elif mode == "auth-announcement":
                peer.sendall(frame('["AUTH","first"]') + frame('["AUTH","rotated"]') + frame('["EOSE","proof"]'))
            else:
                peer.sendall(frame("EVENT") + frame("EOSE"))
    except (ConnectionError, OSError, ssl.SSLError) as error:
        if mode not in {"untrusted", "wrong-host", "cancel", "oversize"}:
            errors.append(str(error))
    except AssertionError as error:
        errors.append(str(error))
    finally:
        listener.close()


def main() -> None:
    if not shutil.which("openssl") or not shutil.which("swiftc"):
        raise RuntimeError("OpenSSL and Swift are required for the loopback WSS proof")
    with tempfile.TemporaryDirectory(prefix="hypergolic-ios-wss-tls-") as temporary:
        output = Path(temporary)
        simulator = os.environ.get("HYPERGOLIC_TLS_SIMULATOR_UDID")
        valid_key, valid_cert, valid_der = identity(output, "relay.example.org")
        wrong_key, wrong_cert, wrong_der = identity(output, "other.example.org")
        binary = output / "ios-wss-tls-proof"
        compiler = ["swiftc", "-swift-version", "6", "-D", "HYPERGOLIC_NETWORK_PROOF", "-warnings-as-errors"]
        compiler_environment = os.environ.copy()
        if simulator:
            sdk = subprocess.check_output(["xcrun", "--sdk", "iphonesimulator", "--show-sdk-path"], text=True).strip()
            compiler_environment["SDKROOT"] = sdk
            compiler.extend([
                "-target", "arm64-apple-ios18.4-simulator", "-parse-as-library",
                "-sdk", sdk,
            ])
        subprocess.run([
            *compiler, "-module-cache-path", str(output / "swift-modules"), "-o", str(binary),
            *(str(NATIVE / source) for source in SOURCES), str(PROOF),
        ], cwd=ROOT, env=compiler_environment, check=True)
        for mode in ("valid", "auth-announcement", "failover", "untrusted", "wrong-host", "redirect",
                     "bad-accept", "oversize", "cancel"):
            key, cert, anchor = (
                (wrong_key, wrong_cert, wrong_der) if mode == "wrong-host"
                else (valid_key, valid_cert, valid_der)
            )
            listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            port = listener.getsockname()[1]
            observed: list[str] = []
            errors: list[str] = []
            thread = threading.Thread(target=serve, args=(mode, key, cert, listener, observed, errors), daemon=True)
            thread.start()
            command = (["xcrun", "simctl", "spawn", simulator] if simulator else [])
            subprocess.run([*command, str(binary), str(port), str(anchor), mode],
                           cwd=ROOT, check=True, timeout=12)
            thread.join(timeout=10)
            if thread.is_alive() or errors:
                raise AssertionError(f"{mode}: server did not finish cleanly: {errors}")
            if mode in {"untrusted", "wrong-host"}:
                expected = ["accepted"]
            elif mode == "redirect" or mode == "bad-accept":
                expected = ["accepted", "upgrade"]
            else:
                expected = ["accepted", "upgrade", "req"]
            if observed != expected:
                raise AssertionError(f"{mode}: expected {expected}, observed {observed}")


if __name__ == "__main__":
    main()
