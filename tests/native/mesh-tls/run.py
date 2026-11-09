#!/usr/bin/env python3
"""Build actual private Mesh TLS; no device, socket, install or dependency fetch."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import time

ROOT = Path(__file__).resolve().parents[3]
VENDOR = ROOT / 'modules/mesh-core/vendor'

def fingerprint():
    paths = list(VENDOR.rglob('*')) + list((ROOT / 'modules/mesh-core/shared').glob('*.c')) + list((ROOT / 'modules/mesh-core/shared').glob('*.h')) + list(Path(__file__).parent.glob('*'))
    return {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(paths) if p.is_file() and '__pycache__' not in p.parts}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--android-ndk', type=Path)
    parser.add_argument('--iphoneos', action='store_true')
    args = parser.parse_args()
    output = args.output.resolve()
    if output.exists() or ROOT == output or ROOT in output.parents:
        raise SystemExit('Output must be a new directory outside the source tree')
    output.mkdir(parents=True)
    cmake = shutil.which('cmake')
    if not cmake:
        raise SystemExit('Existing CMake required; this runner installs nothing')
    before = fingerprint()
    steps = []
    receipt = {'status': 'running', 'scope': 'native TLS host proof and optional static ARM64 cross-compiles; no device acceptance', 'sourceBefore': before, 'steps': steps}
    def run(name, command):
        start = time.monotonic()
        with (output / (name + '.log')).open('wb') as log:
            result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, timeout=240)
        steps.append({'name': name, 'exitCode': result.returncode, 'seconds': time.monotonic() - start, 'command': [str(x) for x in command]})
        if result.returncode:
            raise RuntimeError('Failed: ' + name)
    def build(name, flags, proof=False):
        directory = output / name
        run(name+'-configure', [cmake, '-S', str(VENDOR), '-B', str(directory), '-DCMAKE_BUILD_TYPE=Release', '-DHYPERGOLIC_MESH_TLS_TESTS='+('ON' if proof else 'OFF')] + flags)
        run(name+'-compile', [cmake, '--build', str(directory), '-j', '4'])
        if proof:
            run(name+'-proof', [str(directory / 'mesh_tls_proof')])
            payload = json.loads((output / (name+'-proof.log')).read_text())
            if payload.get('status') != 'passed' or payload.get('trackedBytesAfterShutdown') != 0:
                raise RuntimeError('Proof did not establish successful cleanup')
            receipt[name] = payload
    try:
        build('host', [], True)
        build('sanitized', ['-DCMAKE_C_FLAGS=-fsanitize=address,undefined -fno-omit-frame-pointer', '-DCMAKE_EXE_LINKER_FLAGS=-fsanitize=address,undefined'], True)
        if args.android_ndk:
            toolchain = args.android_ndk.resolve() / 'build/cmake/android.toolchain.cmake'
            if not toolchain.is_file():
                raise RuntimeError('Explicit installed Android NDK toolchain missing')
            build('android-arm64', ['-DCMAKE_TOOLCHAIN_FILE='+str(toolchain), '-DANDROID_ABI=arm64-v8a', '-DANDROID_PLATFORM=android-24'])
        if args.iphoneos:
            build('iphoneos-arm64', ['-DCMAKE_SYSTEM_NAME=iOS', '-DCMAKE_OSX_SYSROOT=iphoneos', '-DCMAKE_OSX_ARCHITECTURES=arm64', '-DCMAKE_OSX_DEPLOYMENT_TARGET=18.4'])
        after = fingerprint()
        if before != after:
            raise RuntimeError('Source changed during build')
        receipt['status'] = 'passed'
    except Exception as failure:
        receipt['status'] = 'failed'
        receipt['errorStage'] = str(failure)
        raise
    finally:
        receipt['sourceAfter'] = fingerprint()
        receipt['archives'] = [{'path': str(p.relative_to(output)), 'bytes': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(output.rglob('*.a'))]
        (output / 'receipt.json').write_text(json.dumps(receipt, indent=2)+'\n')

if __name__ == '__main__':
    main()
