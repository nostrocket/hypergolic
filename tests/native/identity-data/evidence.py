"""Portable input and installed-product fingerprints for public identity acceptance."""
import hashlib,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
def sha(data):return hashlib.sha256(data).hexdigest()
def sources():
    paths=subprocess.check_output(['git','ls-files','-co','--exclude-standard','-z'],cwd=ROOT).decode().split('\0')
    paths.extend(['runtime/dist/index.html','runtime/dist/host.js'])
    prefixes=('src/','modules/napplet-host/','runtime/src/','runtime/patches/','runtime/fixtures/','runtime/dist/','napplets/state-lab/','napplets/feed-lab/','tests/native/identity-data/','tests/native/ios/XCTest/','plugins/')
    names=('app.json','package.json','pnpm-lock.yaml','runtime/pnpm-lock.yaml','metro.config.js','tsconfig.json','scripts/build-runtime.mjs','tests/native/upload/android-upload.py')
    return {p:sha((ROOT/p).read_bytes()) for p in sorted(set(paths)) if (p.startswith(prefixes) or p in names) and (ROOT/p).is_file()}
def product(root):return {str(p.relative_to(root)):sha(p.read_bytes()) for p in sorted(root.rglob('*')) if p.is_file()}
