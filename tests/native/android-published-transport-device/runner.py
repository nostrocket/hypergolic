#!/usr/bin/env python3
"""Run the actual Android HTTPS/WSS owners in a disposable emulator DEX.

This is an Android-runtime transport proof under the shell UID. It does not
exercise the Expo bridge, production app lifecycle, or system trust store.
"""

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[3]
HOST = ROOT / "modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host"
SOURCES = [
    HOST / "PublicAddressPolicy.java",
    HOST / "PublishedHttpsResponseReader.java",
    HOST / "PublishedHttpsTransport.java",
    HOST / "PublishedRelayWebSocketHandshake.java",
    HOST / "PublishedRelayWebSocketFrames.java",
    HOST / "PublishedRelayWebSocketClientFrames.java",
    HOST / "PublishedRelayWssQuery.java",
    HOST / "PublishedRelayWssIo.java",
    ROOT / "tests/native/android-published-https/PublishedHttpsTlsProof.java",
    ROOT / "tests/native/android-published-wss/PublishedRelayWssTlsProof.java",
]
CASES = [
    ("https", "napplets.example.org", "PublishedHttpsTlsProof", 55),
    ("wss", "relay.example.org", "PublishedRelayWssTlsProof", 37),
]


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def command(*args: str) -> str:
    result = subprocess.run(args, cwd=ROOT, check=True, text=True, capture_output=True)
    return result.stdout.strip()


def local_tool(name: str, relative: str) -> str:
    pinned = ROOT / ".tools" / relative
    if pinned.is_file():
        return str(pinned)
    found = shutil.which(name)
    if found:
        return found
    raise RuntimeError(f"{name} is required")


def identity(directory: Path, name: str) -> tuple[Path, Path]:
    key, cert, bundle = (directory / f"{name}.{suffix}" for suffix in ("key", "pem", "p12"))
    command("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
            "-keyout", str(key), "-out", str(cert), "-subj", f"/CN={name}",
            "-addext", f"subjectAltName=DNS:{name}",
            "-addext", "extendedKeyUsage=serverAuth",
            "-addext", "keyUsage=digitalSignature,keyEncipherment")
    command("openssl", "pkcs12", "-export", "-inkey", str(key), "-in", str(cert),
            "-out", str(bundle), "-passout", "pass:temporary-proof")
    return cert, bundle


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serial", required=True, help="Explicit disposable Android emulator serial")
    parser.add_argument("--output", required=True, type=Path, help="New directory for the JSON receipt")
    args = parser.parse_args()
    if not args.serial.startswith("emulator-"):
        parser.error("The target must be an explicitly named disposable emulator")
    args.output.mkdir(parents=True, exist_ok=False)
    receipt: dict[str, object] = {
        "scope": "Android app_process under shell UID; owning HTTPS/WSS Java sources and disposable TLS",
        "sourceSha256": {str(path.relative_to(ROOT)): sha256(path) for path in SOURCES},
        "status": "failed",
    }
    adb = local_tool("adb", "android-sdk/platform-tools/adb")
    javac = local_tool("javac", "jdk/Contents/Home/bin/javac")
    jar = local_tool("jar", "jdk/Contents/Home/bin/jar")
    d8_candidates = sorted((ROOT / ".tools/android-sdk/cmdline-tools").glob("*/bin/d8"))
    d8 = str(d8_candidates[-1]) if d8_candidates else local_tool("d8", "missing/d8")
    remote = "/data/local/tmp/hypergolic-transport-proof-" + uuid.uuid4().hex[:12]
    created_remote = False
    try:
        sdk = int(command(adb, "-s", args.serial, "shell", "getprop", "ro.build.version.sdk"))
        if sdk < 26:
            raise RuntimeError("Android API 26 or newer is required")
        receipt["device"] = {
            "serial": args.serial,
            "sdk": sdk,
            "buildFingerprint": command(adb, "-s", args.serial, "shell", "getprop", "ro.build.fingerprint"),
        }
        with tempfile.TemporaryDirectory(prefix="hypergolic-android-transport-") as temporary:
            work = Path(temporary)
            classes, dex = work / "classes", work / "dex"
            classes.mkdir(); dex.mkdir()
            command(javac, "--release", "8", "-Xlint:all", "-Werror", "-d", str(classes),
                    *(str(path) for path in SOURCES))
            archive = work / "proof.jar"
            command(jar, "cf", str(archive), "-C", str(classes), ".")
            command(d8, "--min-api", str(sdk), "--output", str(dex), str(archive))
            bytecode = dex / "classes.dex"
            receipt["dexSha256"] = sha256(bytecode)
            command(adb, "-s", args.serial, "shell", "mkdir", "-p", remote)
            created_remote = True
            command(adb, "-s", args.serial, "push", str(bytecode), remote + "/proof.dex")
            checks: dict[str, int] = {}
            for label, hostname, class_name, expected in CASES:
                cert, bundle = identity(work, hostname)
                remote_cert = remote + "/" + label + ".pem"
                remote_bundle = remote + "/" + label + ".p12"
                command(adb, "-s", args.serial, "push", str(cert), remote_cert)
                command(adb, "-s", args.serial, "push", str(bundle), remote_bundle)
                line = command(adb, "-s", args.serial, "shell", "CLASSPATH=" + remote + "/proof.dex",
                               "app_process", "/system/bin", "org.nostrocket.hypergolic.host." + class_name,
                               remote_cert, remote_bundle)
                if line != f"{class_name}: {expected} checks passed":
                    raise AssertionError(f"Unexpected {label} result: {line[:200]}")
                checks[label] = expected
                print(line, flush=True)
            receipt["checks"] = checks
            receipt["status"] = "passed"
    except Exception as error:
        receipt["error"] = str(error)[:500]
        raise
    finally:
        if created_remote:
            cleanup = subprocess.run([adb, "-s", args.serial, "shell", "rm", "-rf", remote],
                                     cwd=ROOT, check=False, capture_output=True)
            receipt["emulatorTempRemoved"] = cleanup.returncode == 0
            if cleanup.returncode != 0:
                receipt["status"] = "failed"
                receipt["cleanupError"] = "Disposable emulator files could not be removed"
        (args.output / "result.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    if receipt["status"] != "passed":
        raise RuntimeError("Transport proof did not complete cleanly; see result.json")


if __name__ == "__main__":
    main()
