#!/usr/bin/env python3
"""Owning Java/Swift upload-body authority proofs; these are not native UI journeys."""
from pathlib import Path
import hashlib
import json
import struct
import zlib
import subprocess
import tempfile
from png_metadata_fixtures import write_metadata_fixtures
from exif_fixtures import write_exif_fixtures

ROOT = Path(__file__).resolve().parents[3]
ANDROID = ROOT / 'modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host'
IOS = ROOT / 'modules/napplet-host/ios'
HERE = Path(__file__).resolve().parent
tokens = json.loads(subprocess.check_output(['node', str(HERE/'credential-fixtures.mjs')], text=True, cwd=ROOT))
with tempfile.TemporaryDirectory(prefix='hypergolic-upload-authority-') as temporary:
    out = Path(temporary)
    subprocess.run(['javac', '-Xlint:all', '-Werror', '-d', str(out),
                    *[str(ANDROID / (name + '.java')) for name in ['NativeSigningHold', 'UploadJsonBounds', 'UploadRecoveryLedger', 'UploadRecoveryReadAuthority', 'UploadLeaseRegistry', 'UploadFileProfile', 'UploadPngProfile', 'UploadExifMetadata', 'UploadPngMetadata', 'NativeUploadAuthority', 'NativeBlossomPermit', 'PublishedHttpsTransport', 'PublishedHttpsResponseReader']],
                    str(HERE / 'UploadQueueProof.java'), str(HERE / 'UploadRecoveryReadProof.java'), str(HERE / 'UploadRecoveryProof.java'), str(HERE / 'UploadJsonBoundsProof.java'), str(HERE / 'UploadRegistryProof.java'), str(HERE / 'UploadPngProof.java'), str(HERE / 'UploadExifProof.java'), str(HERE / 'UploadFileProof.java'), str(HERE / 'UploadAuthorityProof.java'), str(HERE / 'UploadResponseProof.java'), str(HERE/'NativePermitProof.java')], check=True)
    subprocess.run(['java', '-cp', str(out), 'org.nostrocket.hypergolic.host.UploadRecoveryProof', str(out)], check=True)
    subprocess.run(['swiftc', '-swift-version', '6', '-warnings-as-errors', '-module-cache-path', str(out/'swift-cache'),
                    str(IOS/'UploadPngProfile.swift'), str(IOS/'UploadPngMetadata.swift'), str(IOS/'UploadFileProfile.swift'), str(IOS/'NativeUploadAuthority.swift'),
                    str(IOS/'UploadRecoveryLedger.swift'), str(HERE/'UploadRecoveryProof.swift'), '-o', str(out/'swift-recovery-proof')], check=True)
    subprocess.run([str(out/'swift-recovery-proof'), str(out)], check=True)
    assert (out/'java-recovery.bin').read_bytes() == (out/'swift-recovery.bin').read_bytes(), 'Recovery codec parity failed'
    subprocess.run(['java', '-cp', str(out), 'org.nostrocket.hypergolic.host.UploadRecoveryProof', str(out), str(out/'swift-recovery.bin')], check=True)
    subprocess.run(['java', '-cp', str(out), 'org.nostrocket.hypergolic.host.UploadRecoveryReadProof'], check=True)
    subprocess.run(['swiftc', '-swift-version', '6', '-warnings-as-errors', '-module-cache-path', str(out/'swift-cache'),
                    str(IOS/'UploadPngProfile.swift'), str(IOS/'UploadPngMetadata.swift'), str(IOS/'UploadFileProfile.swift'), str(IOS/'NativeUploadAuthority.swift'),
                    str(IOS/'UploadRecoveryLedger.swift'), str(IOS/'UploadRecoveryReadAuthority.swift'), str(HERE/'UploadRecoveryReadProof.swift'), '-o', str(out/'swift-recovery-read-proof')], check=True)
    subprocess.run([str(out/'swift-recovery-read-proof')], check=True)
    subprocess.run(['java', '-cp', str(out), 'org.nostrocket.hypergolic.host.UploadQueueProof'], check=True)
    subprocess.run(['swiftc', '-swift-version', '6', '-warnings-as-errors', '-module-cache-path', str(out/'swift-cache'),
                    str(IOS/'UploadPngProfile.swift'), str(IOS/'UploadPngMetadata.swift'), str(IOS/'UploadFileProfile.swift'), str(IOS/'NativeUploadAuthority.swift'),
                    str(HERE/'UploadQueueProof.swift'), '-o', str(out/'swift-queue-proof')], check=True)
    subprocess.run([str(out/'swift-queue-proof')], check=True)
    subprocess.run(['java', '-cp', str(out), 'org.nostrocket.hypergolic.host.UploadJsonBoundsProof'], check=True)
    subprocess.run(['java', '-cp', str(out), 'org.nostrocket.hypergolic.host.UploadAuthorityProof'], check=True)
    subprocess.run(['java', '-cp', str(out), 'org.nostrocket.hypergolic.host.UploadResponseProof'], check=True)
    subprocess.run(['java', '-cp', str(out), 'org.nostrocket.hypergolic.host.NativePermitProof', *tokens], check=True)
    subprocess.run(['swiftc', '-swift-version', '6', '-warnings-as-errors', '-module-cache-path', str(out/'swift-cache'),
                    str(IOS/'UploadPngProfile.swift'), str(IOS/'UploadPngMetadata.swift'), str(IOS/'UploadFileProfile.swift'), str(IOS/'NativeUploadAuthority.swift'), str(HERE/'UploadAuthorityProof.swift'),
                    '-o', str(out/'swift-proof')], check=True)
    subprocess.run([str(out/'swift-proof')], check=True)
    subprocess.run(['swiftc', '-swift-version', '6', '-warnings-as-errors', '-module-cache-path', str(out/'swift-cache'),
                    str(IOS/'PublishedHTTPResponse.swift'), str(HERE/'UploadResponseProof.swift'),
                    '-o', str(out/'swift-response-proof')], check=True)
    subprocess.run([str(out/'swift-response-proof')], check=True)
    subprocess.run(['swiftc', '-swift-version', '6', '-warnings-as-errors', '-module-cache-path', str(out/'swift-cache'),
                    str(IOS/'UploadPngProfile.swift'), str(IOS/'UploadPngMetadata.swift'), str(IOS/'UploadFileProfile.swift'), str(IOS/'NativeUploadAuthority.swift'), str(IOS/'NativeBlossomPermit.swift'), str(IOS/'UploadLeaseRegistry.swift'), str(HERE/'NativePermitProof.swift'),
                    '-o', str(out/'swift-permit-proof')], check=True)
    subprocess.run([str(out/'swift-permit-proof'), *tokens], check=True)
    def png_chunk(name, data):
        encoded = name.encode('ascii') + data
        return struct.pack('>I', len(data)) + encoded + struct.pack('>I', zlib.crc32(encoded))
    header = struct.pack('>IIBBBBB', 2, 1, 8, 6, 0, 0, 0)
    raw = bytes([0, 255, 0, 0, 255, 0, 255, 0, 255])
    signature = bytes([137,80,78,71,13,10,26,10])
    def png(h=header, pixels=raw, before=b'', after=b'', suffix=b'', compressed=None):
        data = zlib.compress(pixels) if compressed is None else compressed
        return signature + png_chunk('IHDR',h) + before + png_chunk('IDAT',data) + after + png_chunk('IEND',b'') + suffix
    good = png()
    fixtures = [('valid',good,True),('color',png(before=png_chunk('sRGB',b'\x00')),True),
                ('signature',b'not PNG '+good[8:],False), ('truncated',good[:-1],False),
                ('crc',good[:40]+bytes([good[40]^1])+good[41:],False),
                ('text',png(before=png_chunk('tEXt',b'Author\0private')),False),
                ('exif',png(before=png_chunk('eXIf',b'IIprivate')),False),
                ('icc',png(before=png_chunk('iCCP',b'profile\0private')),False),
                ('animation',png(before=png_chunk('acTL',bytes(8))),False),
                ('unknown',png(before=png_chunk('aaAA',b'private')),False),
                ('duplicate-header',png(before=png_chunk('IHDR',header)),False),
                ('duplicate-color',png(before=png_chunk('sRGB',b'\x00')*2),False),
                ('late-color',png(after=png_chunk('sRGB',b'\x00')),False),
                ('interlaced',png(h=header[:-1]+b'\x01'),False),
                ('huge',png(h=struct.pack('>IIBBBBB',4096,4096,8,6,0,0,0)),False),
                ('bad-filter',png(pixels=b'\x05'+raw[1:]),False),
                ('short-pixels',png(pixels=raw[:-1]),False),
                ('extra-pixels',png(pixels=raw+b'\x00'),False),
                ('compressed-trailer',png(compressed=zlib.compress(raw)+b'extra'),False),
                ('after-end',png(suffix=b'extra'),False), ('jpeg',b'\xff\xd8JPEG',False)]
    write_metadata_fixtures(out, png, png_chunk, good)
    for name,data,_ in fixtures: (out/(name+'.png')).write_bytes(data)
    subprocess.run(['/usr/bin/sips', '-s', 'format', 'jpeg', str(out/'valid.png'), '--out', str(out/'thumbnail.jpg')], check=True, stdout=subprocess.DEVNULL)
    write_exif_fixtures(out, (out/'thumbnail.jpg').read_bytes())
    subprocess.run(['java', '-cp', str(out), 'org.nostrocket.hypergolic.host.UploadExifProof', str(out)], check=True)
    subprocess.run(['swiftc', '-swift-version', '6', '-warnings-as-errors', '-module-cache-path', str(out/'swift-cache'),
                    str(IOS/'UploadExifMetadata.swift'), str(HERE/'UploadExifProof.swift'), '-o', str(out/'swift-exif-proof')], check=True)
    subprocess.run([str(out/'swift-exif-proof'), str(out)], check=True)
    (out/'png-cases.json').write_text(json.dumps([{'name':name,'accepted':expected} for name,_,expected in fixtures]))
    subprocess.run(['java', '-cp', str(out), 'org.nostrocket.hypergolic.host.UploadPngProof', str(out)], check=True)
    subprocess.run(['swiftc', '-swift-version', '6', '-warnings-as-errors', '-module-cache-path', str(out/'swift-cache'),
                    str(IOS/'UploadPngProfile.swift'), str(IOS/'UploadPngMetadata.swift'), str(IOS/'UploadFileProfile.swift'), str(IOS/'NativeUploadAuthority.swift'), str(HERE/'UploadPngProof.swift'),
                    '-o', str(out/'swift-png-proof')], check=True)
    subprocess.run([str(out/'swift-png-proof'), str(out)], check=True)
    registry_tokens = json.loads(subprocess.check_output(['node', str(HERE/'credential-fixtures.mjs'),
        'https://files.example.com', hashlib.sha256(good).hexdigest()], text=True, cwd=ROOT))
    subprocess.run(['java', '-cp', str(out), 'org.nostrocket.hypergolic.host.UploadRegistryProof', str(out), registry_tokens[0], registry_tokens[1]], check=True)
    subprocess.run(['swiftc', '-swift-version', '6', '-warnings-as-errors', '-module-cache-path', str(out/'swift-cache'),
                    str(IOS/'UploadPngProfile.swift'), str(IOS/'UploadPngMetadata.swift'), str(IOS/'UploadFileProfile.swift'), str(IOS/'NativeUploadAuthority.swift'), str(IOS/'NativeBlossomPermit.swift'),
                    str(IOS/'UploadLeaseRegistry.swift'), str(HERE/'UploadRegistryProof.swift'), '-o', str(out/'swift-registry-proof')], check=True)
    subprocess.run([str(out/'swift-registry-proof'), str(out), registry_tokens[0], registry_tokens[1]], check=True)

    subprocess.run(['python3', str(ROOT/'tests/native/upload/create-attachments.py'), '--output', str(out/'attachments')], check=True)
    subprocess.run(['java', '-cp', str(out), 'org.nostrocket.hypergolic.host.UploadFileProof', str(out/'attachments')], check=True)
    subprocess.run(['swiftc', '-swift-version', '6', '-warnings-as-errors', '-module-cache-path', str(out/'swift-cache'),
                    str(IOS/'UploadFileProfile.swift'), str(IOS/'UploadPngProfile.swift'), str(IOS/'UploadPngMetadata.swift'), str(IOS/'NativeUploadAuthority.swift'), str(HERE/'UploadFileProof.swift'), '-o', str(out/'swift-file-proof')], check=True)
    subprocess.run([str(out/'swift-file-proof'), str(out/'attachments')], check=True)
