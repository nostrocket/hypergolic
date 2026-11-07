"""Prove both native parsers and file sinks with synthetic, network-free inputs."""
from pathlib import Path
import os
import struct
import subprocess
import tempfile


def box(kind: bytes, *parts: bytes) -> bytes:
    body = b"".join(parts)
    return struct.pack(">I4s", len(body) + 8, kind) + body


def media(ref, codec=b"avc1", extra=b"", misplaced=False, dims=(1920, 1080), ticks=84000, version=0):
    reference = box(b"dref", struct.pack(">II", 0, 1), ref)
    visual = bytes(24) + struct.pack(">HH", *dims) + bytes(50)
    description = box(b"stsd", struct.pack(">II", 0, 1), box(codec, visual))
    track = box(b"trak", box(b"mdia", box(b"minf", reference if misplaced else box(b"dinf", reference), box(b"stbl", description))))
    movie = box(b"mvhd", bytes(12) + struct.pack(">II", 1000, ticks)) if version == 0 else box(
        b"mvhd", b"\1" + bytes(19) + struct.pack(">IQ", 1000, ticks))
    return box(b"ftyp", b"isom\0\0\0\0isom") + box(b"moov", movie, track, extra) + box(b"mdat", b"sample")


root = Path(__file__).resolve().parents[3]
android = root / "modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host"
ios = root / "modules/napplet-host/ios"
java_bin = Path(os.environ["JAVA_HOME"]) / "bin" if "JAVA_HOME" in os.environ else Path("/usr/bin")
reference = box(b"url ", b"\0\0\0\1")
valid = media(reference)
cases = {
    "ok-local": valid,
    "ok-portrait": media(reference, dims=(2160, 3840)),
    "ok-version-one-duration": media(reference, version=1),
    "reject-remote": media(box(b"url ", b"\0\0\0\0https://192.168.1.1/video.mp4\0")),
    "reject-local-with-trailing-bytes": media(box(b"url ", b"\0\0\0\1hidden")),
    "reject-alias": media(box(b"alis", b"\0\0\0\1")),
    "reject-reference-movie": media(reference, extra=box(b"rmra", b"external")),
    "reject-pssh": media(reference, extra=box(b"pssh", b"encrypted")),
    "reject-encrypted-codec": media(reference, codec=b"encv"),
    "reject-audio-only": media(reference, codec=b"mp4a"),
    "reject-fragmented": media(reference, extra=box(b"mvex")),
    "reject-misplaced": media(reference, misplaced=True),
    "reject-truncated": valid[:-1],
    "reject-malformed-length": valid[:20] + struct.pack(">I", 0xFFFFFFFF) + valid[24:],
    "reject-zero-extended-length": valid[:20] + struct.pack(">I4sQ", 1, b"moov", 0) + valid[36:],
    "reject-wide": media(reference, dims=(3841, 2160)),
    "reject-square": media(reference, dims=(3000, 3000)),
    "reject-unknown-dimensions": media(reference, dims=(0, 0)),
    "reject-duration": media(reference, ticks=3600001),
    "reject-long-duration": media(reference, ticks=(1 << 63) + 1, version=1),
    "reject-missing-duration": valid[:20] + box(b"moov", valid[56:-14]) + valid[-14:],
    "reject-duplicate-duration": media(reference, extra=box(b"mvhd", bytes(12) + struct.pack(">II", 1000, 84000))),
}
with tempfile.TemporaryDirectory(prefix="finite-media-") as path:
    target = Path(path)
    for name, value in cases.items():
        (target / name).write_bytes(value)
    large = target / "ok-mdat-before-moov"
    size = 168532851
    with large.open("wb") as f:
        f.write(valid[:20])
        f.write(struct.pack(">I4s", size - len(valid) + 14, b"mdat"))
        f.seek(size - len(valid[20:-14]))
        f.write(valid[20:-14])
    with (target / "reject-too-large").open("wb") as f:
        f.truncate(256 * 1024 * 1024 + 1)
    inputs = [str(target / name) for name in [*cases, large.name, "reject-too-large"]]
    subprocess.run([java_bin / "javac", "-Xlint:all", "-Werror", "-d", target, *[
        android / name for name in ["FiniteMp4.java", "MediaHttpsFile.java", "PublishedHttpsResponseReader.java",
            "PublishedHttpsTransport.java", "PublicAddressPolicy.java"]
    ], Path(__file__).with_name("MediaFileProof.java")], check=True)
    subprocess.run([java_bin / "java", "-Xmx24m", "-cp", target,
        "org.nostrocket.hypergolic.host.MediaFileProof", str(target), *inputs], check=True)
    subprocess.run(["swiftc", "-swift-version", "6", "-module-cache-path", target / "swiftcache",
        ios / "FiniteMP4.swift", ios / "MediaHTTPSFile.swift", ios / "PublishedHTTPResponse.swift",
        Path(__file__).with_name("MediaFileProof.swift"), "-o", target / "proof"], check=True)
    subprocess.run([target / "proof", target, *inputs], check=True)
    print(f"Both native MP4 validators passed {len(inputs)} local cases, including a 161 MiB sparse file.")
