"""Portable input and installed-product fingerprints for upload acceptance."""
import hashlib,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
def sha(data):return hashlib.sha256(data).hexdigest()
def sources():
    paths=subprocess.check_output(['git','ls-files','-co','--exclude-standard','-z'],cwd=ROOT).decode().split('\0')
    paths.extend(['runtime/dist/index.html','runtime/dist/host.js'])
    prefixes=('src/','modules/napplet-host/','runtime/src/','runtime/patches/','runtime/fixtures/','runtime/dist/','napplets/upload-lab/','tests/native/upload/','tests/native/ios/XCTest/','plugins/')
    names=('app.json','package.json','pnpm-lock.yaml','runtime/pnpm-lock.yaml','metro.config.js','tsconfig.json','scripts/build-runtime.mjs')
    return {p:sha((ROOT/p).read_bytes()) for p in sorted(set(paths)) if (p.startswith(prefixes) or p in names) and (ROOT/p).is_file()}
def product(root):return {str(p.relative_to(root)):sha(p.read_bytes()) for p in sorted(root.rglob('*')) if p.is_file()}

def recovery_records(data):
    """Independent inspection of metadata-only disk bytes; not a native storage-policy proof."""
    import struct
    assert len(data)<=128*1024 and data[:8]==b'HGUR0001' and hashlib.sha256(data[:-32]).digest()==data[-32:]
    payload=data[:-32];cursor=8
    def number():
        nonlocal cursor
        assert cursor+4<=len(payload);value=struct.unpack('>I',payload[cursor:cursor+4])[0];cursor+=4;return value
    def text():
        nonlocal cursor
        length=number();assert cursor+length<=len(payload);value=payload[cursor:cursor+length].decode('utf-8');cursor+=length;return value
    count=number();assert count<=32;rows=[]
    for _ in range(count):
        row={key:text() for key in ['uploadId','identity','publisher','appId','destination','sha256','mimeType']};row['size']=number()
        assert cursor<len(payload) and payload[cursor]<6;row['state']=['unknown','present','absent','confirmed','rejected','not_sent'][payload[cursor]];cursor+=1;rows.append(row)
    assert cursor==len(payload) and len({row['uploadId'] for row in rows})==len(rows);return rows

def large_wav():
    """Public deterministic 4 MiB PCM WAV, independently built from the guest recipe."""
    import struct
    length=4*1024*1024
    return b'RIFF'+struct.pack('<I',length-8)+b'WAVEfmt '+struct.pack('<IHHIIHH',16,1,1,8000,8000,1,8)+b'data'+struct.pack('<I',length-44)+b'a'*(length-44)
