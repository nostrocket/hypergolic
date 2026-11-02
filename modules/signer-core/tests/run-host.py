#!/usr/bin/env python3
"""Compile and run the real C primitive on the host. No mobile acceptance claim."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--sanitize', action='store_true', help='AddressSanitizer and UndefinedBehaviorSanitizer')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
vendor = root / 'vendor' / 'secp256k1'
manifest = json.loads((root / 'vendor' / 'secp256k1-manifest.json').read_text())
actual_files = {str(p.relative_to(vendor)) for p in vendor.rglob('*') if p.is_file()}
if actual_files != set(manifest['files']):
    raise SystemExit('Vendored source file set differs from pin')
for name, expected in manifest['files'].items():
    if hashlib.sha256((vendor / name).read_bytes()).hexdigest() != expected:
        raise SystemExit('Vendored source hash differs: ' + name)
monocypher = root / 'vendor' / 'monocypher'
mono_manifest = json.loads((root / 'vendor' / 'monocypher-manifest.json').read_text())
if {str(p.relative_to(monocypher)) for p in monocypher.rglob('*') if p.is_file()} != set(mono_manifest['files']):
    raise SystemExit('Monocypher file set differs from pin')
for name, expected in mono_manifest['files'].items():
    if hashlib.sha256((monocypher / name).read_bytes()).hexdigest() != expected:
        raise SystemExit('Monocypher source differs from pin: ' + name)
vector_manifest = json.loads((root / 'tests' / 'bip340-manifest.json').read_text())
vectors = root / 'tests' / 'bip340-test-vectors.csv'
if hashlib.sha256(vectors.read_bytes()).hexdigest() != vector_manifest['sha256']:
    raise SystemExit('Official vectors differ from pin')
with tempfile.TemporaryDirectory(prefix='hypergolic-signer-host-') as temporary:
    output = Path(temporary) / 'primitive-tests'
    command = [os.environ.get('CC', 'cc'), '-std=c99', '-O2', '-Wall', '-Wextra', '-Werror',
               '-fvisibility=hidden', '-I' + str(root / 'shared' / 'include'), '-I' + str(vendor / 'include'), '-I' + str(monocypher / 'src')]
    command += ['-D' + definition for definition in manifest['compile']['definitions']]
    if args.sanitize:
        command += ['-fsanitize=address,undefined', '-fno-omit-frame-pointer']
    sources = [root / 'shared' / 'hypergolic_signer.c', root / 'shared' / 'hypergolic_nip44.c',
               monocypher / 'src' / 'monocypher.c', root / 'tests' / 'primitive_test.c']
    sources += [vendor / source for source in manifest['compile']['sources']]
    objects = []
    for index, source in enumerate(sources):
        obj = Path(temporary) / (str(index) + '.o')
        # Upstream CMakeLists.txt:227 uses this for intentionally unused helpers.
        flags = ['-Wno-unused-function'] if vendor in source.parents else []
        if source.name == 'hypergolic_signer.c':
            flags += ['-Dcalloc=signer_test_calloc', '-Dfree=signer_test_free', '-DHYPERGOLIC_SIGNER_TEST_CLEAR=1']
        subprocess.run(command + flags + ['-c', str(source), '-o', str(obj)], check=True)
        objects.append(str(obj))
    subprocess.run(command + objects + ['-o', str(output)], check=True)
    subprocess.run([str(output), str(vectors)], check=True)
print('SOURCE pin verified: ' + manifest['release'] + ' ' + manifest['commit'])
