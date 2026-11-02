#!/usr/bin/env python3
"""Host native crypto/vector/caller checks; all generated artifacts stay temporary."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--sanitize', action='store_true')
args = parser.parse_args()
here = Path(__file__).resolve().parent
root = here.parents[1]
application = root.parents[1]
vendor = root / 'vendor/secp256k1'
monocypher = root / 'vendor/monocypher'
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
pin = json.loads((root / 'vendor/secp256k1-manifest.json').read_text())
for name, expected in pin['files'].items():
    if sha(vendor / name) != expected: raise SystemExit('secp256k1 source changed: ' + name)
mono_pin = json.loads((root / 'vendor/monocypher-manifest.json').read_text())
if {str(p.relative_to(monocypher)) for p in monocypher.rglob('*') if p.is_file()} != set(mono_pin['files']):
    raise SystemExit('Monocypher source file set changed')
for name, expected in mono_pin['files'].items():
    if sha(monocypher / name) != expected: raise SystemExit('Monocypher source changed: ' + name)
if sha(here / 'nip44-spec.md') != 'b5f89374e4e1dbdee7881e8573b4313b6a89430a9c8d518471599ae0660cf0e2':
    raise SystemExit('Pinned NIP44 specification changed')
if sha(here / 'nip44.vectors.json') != '269ed0f69e4c192512cc779e78c555090cebc7c785b609e338a62afc3ce25040':
    raise SystemExit('Pinned official NIP44 vectors changed')
node = application / '.tools/node/bin/node'
if not node.is_file(): raise SystemExit('Pinned application Node toolchain unavailable')
flags = [os.environ.get('CC', 'cc'), '-std=c99', '-O2', '-Wall', '-Wextra', '-Werror',
         '-fvisibility=hidden', '-I' + str(root / 'shared/include'), '-I' + str(vendor / 'include'),
         '-I' + str(monocypher / 'src')]
flags += ['-D' + definition for definition in pin['compile']['definitions']]
if 'ENABLE_MODULE_ECDH=1' not in pin['compile']['definitions']: raise SystemExit('ECDH module not enabled')
if args.sanitize: flags += ['-fsanitize=address,undefined', '-fno-omit-frame-pointer']
with tempfile.TemporaryDirectory(prefix='hypergolic-nip44-host-') as temporary:
    build = Path(temporary)
    env = dict(os.environ, HYPERGOLIC_NIP44_APPLICATION_ROOT=str(application), HYPERGOLIC_NIP44_OUTPUT_DIR=str(build))
    subprocess.run([str(node), str(here / 'independent.cjs')], check=True, env=env)
    if sha(build / 'authenticated-invalid.json') != sha(here / 'authenticated-invalid.json'):
        raise SystemExit('Independent authenticated negative fixtures changed')
    subprocess.run(['python3', str(here / 'generate.py'), '--output', str(build / 'vectors.inc')], check=True)
    sources = [root / 'shared/hypergolic_signer.c', root / 'shared/hypergolic_nip44.c',
               here / 'nip44_test.c', monocypher / 'src/monocypher.c']
    sources += [vendor / name for name in pin['compile']['sources']]
    objects = []
    for index, source in enumerate(sources):
        obj = build / (str(index) + '.o')
        extra = []
        if source.name in ['hypergolic_signer.c', 'hypergolic_nip44.c']:
            extra += ['-Dcalloc=nip44_test_calloc', '-Dfree=nip44_test_free', '-DHYPERGOLIC_NIP44_TEST=1']
        if source.name == 'hypergolic_signer.c': extra += ['-DHYPERGOLIC_SIGNER_TEST_CLEAR=1']
        # Upstream owning build default for intentionally unused internal helpers.
        if vendor in source.parents: extra += ['-Wno-unused-function']
        subprocess.run(flags + ['-I' + str(build)] + extra + ['-c', str(source), '-o', str(obj)], check=True)
        objects.append(str(obj))
    executable = build / 'nip44-test'
    subprocess.run(flags + objects + ['-o', str(executable)], check=True)
    subprocess.run([str(executable)], cwd=build, check=True)
    subprocess.run([str(node), str(here / 'independent.cjs'), '--verify'], check=True, env=env)
print('Pinned native NIP44 host suite passed' + (' with ASan/UBSan' if args.sanitize else ''))
