#!/usr/bin/env python3
"""Exercise the actual iOS HTTPS owner against disposable loopback TLS servers.

The address/trust seam exists only with HYPERGOLIC_NETWORK_PROOF. Set
HYPERGOLIC_TLS_SIMULATOR_UDID to exercise a standalone iOS Simulator binary.
"""

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
PROOF = Path(__file__).resolve().parent / "PublishedHTTPSTlsProof.swift"


def identity(directory: Path, name: str) -> tuple[Path, Path]:
    key = directory / f"{name}.key"
    cert = directory / f"{name}.pem"
    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
         "-keyout", str(key), "-out", str(cert), "-subj", f"/CN={name}",
         "-addext", f"subjectAltName=DNS:{name}",
         "-addext", "extendedKeyUsage=serverAuth",
         "-addext", "keyUsage=digitalSignature,keyEncipherment"],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    der = directory / f"{name}.der"
    subprocess.run(["openssl", "x509", "-in", str(cert), "-outform", "DER", "-out", str(der)], check=True)
    return key, cert


def serve(mode: str, key: Path, cert: Path, listener: socket.socket,
          observed: list[str], errors: list[str]) -> None:
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certfile=str(cert), keyfile=str(key))
    listener.settimeout(8)
    try:
        raw, _ = listener.accept()
        observed.append("accepted")
        raw.settimeout(4)
        with context.wrap_socket(raw, server_side=True) as peer:
            request = bytearray()
            while b"\r\n\r\n" not in request and len(request) < 8192:
                chunk = peer.recv(8192)
                if not chunk:
                    return
                request.extend(chunk)
            if not request.startswith(b"GET /fixture HTTP/1.1\r\n") or b"Host: blossom.example.net:" not in request:
                errors.append("unexpected request")
            observed.append("request")
            if mode == "cancel":
                time.sleep(0.8)
                return
            response = (
                b"HTTP/1.1 302 Found\r\nLocation: https://other.example.org/\r\nContent-Length: 0\r\n\r\n"
                if mode == "redirect" else
                b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nproof"
            )
            peer.sendall(response)
    except (ConnectionError, OSError, ssl.SSLError) as error:
        if mode not in {"untrusted", "wrong-host", "cancel"}:
            errors.append(str(error))
    finally:
        listener.close()


def main() -> None:
    if not shutil.which("openssl") or not shutil.which("swiftc"):
        raise RuntimeError("OpenSSL and Swift are required for the loopback TLS proof")
    with tempfile.TemporaryDirectory(prefix="hypergolic-ios-https-tls-") as temporary:
        output = Path(temporary)
        simulator = os.environ.get("HYPERGOLIC_TLS_SIMULATOR_UDID")
        valid_key, valid_cert = identity(output, "blossom.example.net")
        wrong_key, wrong_cert = identity(output, "other.example.net")
        valid_der = output / "blossom.example.net.der"
        wrong_der = output / "other.example.net.der"
        binary = output / "ios-https-tls-proof"
        compiler = ["swiftc", "-D", "HYPERGOLIC_NETWORK_PROOF", "-warnings-as-errors"]
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
            *(str(NATIVE / source) for source in ["NativeUploadAuthority.swift", "UploadFileProfile.swift", "UploadPngMetadata.swift", "UploadPngProfile.swift"]),
            str(NATIVE / "PublicAddressPolicy.swift"),
            str(NATIVE / "PublishedHTTPResponse.swift"),
            str(NATIVE / "PublishedPinnedHTTPS.swift"), str(PROOF),
        ], cwd=ROOT, env=compiler_environment, check=True)
        for mode in ("valid", "failover", "untrusted", "wrong-host", "redirect", "cancel", "mixed-dns"):
            key, cert, anchor = (
                (wrong_key, wrong_cert, wrong_der) if mode == "wrong-host"
                else (valid_key, valid_cert, valid_der)
            )
            command = (["xcrun", "simctl", "spawn", simulator] if simulator else [])
            if mode == "mixed-dns":
                subprocess.run([*command, str(binary), "1", str(anchor), mode],
                               cwd=ROOT, check=True, timeout=12)
                continue
            listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            port = listener.getsockname()[1]
            observed: list[str] = []
            errors: list[str] = []
            thread = threading.Thread(target=serve, args=(mode, key, cert, listener, observed, errors), daemon=True)
            thread.start()
            subprocess.run([*command, str(binary), str(port), str(anchor), mode],
                           cwd=ROOT, check=True, timeout=12)
            thread.join(timeout=9)
            if thread.is_alive() or errors:
                raise AssertionError(f"{mode}: server did not finish cleanly: {errors}")
            expected = ["accepted"] if mode in {"untrusted", "wrong-host"} else ["accepted", "request"]
            if observed != expected:
                raise AssertionError(f"{mode}: expected {expected}, observed {observed}")


if __name__ == "__main__":
    main()
