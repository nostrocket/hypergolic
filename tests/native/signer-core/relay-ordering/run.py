#!/usr/bin/env python3
from pathlib import Path
import hashlib
import argparse
import json
import os
import subprocess

here = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description='Host actual-client relay ordering; no network or device')
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--client-source', type=Path)
args = parser.parse_args()
root = here.parents[3]
# A staging copy may locate the actual checkout without copying production sources.
if not (root / 'modules/signer-core/ios/NativeNip46Client.swift').is_file():
    root = Path(os.environ.get('HYPERGOLIC_SOURCE_ROOT', ''))
if not (root / 'modules/signer-core/ios/NativeNip46Client.swift').is_file():
    parser.error('Owning checkout not found; set HYPERGOLIC_SOURCE_ROOT for external staging')
stage = args.output.resolve()
stage.mkdir(parents=True, exist_ok=False)
client_source = (args.client_source or root / 'modules/signer-core/ios/NativeNip46Client.swift').resolve()
developer = Path('/Applications/Xcode.app/Contents/Developer')
toolchain = developer / 'Toolchains/XcodeDefault.xctoolchain/usr/bin'
sdk = developer / 'Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk'
env = dict(os.environ, DEVELOPER_DIR=str(developer))
includes = [root / p for p in ['modules/signer-core/shared/include', 'modules/signer-core/vendor/secp256k1/include',
                              'modules/signer-core/vendor/monocypher/src']]
defines = ['ENABLE_MODULE_SCHNORRSIG=1', 'ENABLE_MODULE_EXTRAKEYS=1', 'ENABLE_MODULE_ECDH=1',
           'ECMULT_WINDOW_SIZE=15', 'COMB_BLOCKS=43', 'COMB_TEETH=6', 'SECP256K1_NO_API_VISIBILITY_ATTRIBUTES=1']
c_sources = ['modules/signer-core/shared/hypergolic_signer.c', 'modules/signer-core/shared/hypergolic_nip44.c',
 'modules/signer-core/vendor/monocypher/src/monocypher.c', 'modules/signer-core/vendor/secp256k1/src/secp256k1.c',
 'modules/signer-core/vendor/secp256k1/src/precomputed_ecmult.c', 'modules/signer-core/vendor/secp256k1/src/precomputed_ecmult_gen.c']
swift_sources = ['modules/signer-core/ios/NativeSignerCore.swift', 'modules/signer-core/ios/ExactSignerEvent.swift',
 'modules/signer-core/ios/NativeVaultKey.swift', 'modules/signer-core/ios/NativeVaultRecord.swift',
 'modules/signer-core/ios/NativeNip46Protocol.swift', 'modules/napplet-host/ios/NativeSignerRelayPolicy.swift']

def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()

build = stage / 'build'
build.mkdir(exist_ok=False)
commands = []
(stage / 'NativeSignerBridge.h').write_text('#include \"hypergolic_signer.h\"\n#include \"hypergolic_nip44.h\"\n')
for index, relative in enumerate(c_sources):
    target = build / (str(index) + '.o')
    command = [str(toolchain / 'clang'), '-O1', '-isysroot', str(sdk), '-c', str(root / relative), '-o', str(target)]
    for include in includes: command += ['-I', str(include)]
    command += ['-D' + define for define in defines]
    commands.append(command)
    with (build / (str(index) + '.log')).open('w') as log:
        subprocess.run(command, env=env, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=120)
results = {}
for variant, source in [('owning-client', client_source)]:
    binary = build / variant
    command = [str(toolchain / 'swiftc'), '-swift-version', '6', '-warnings-as-errors', '-parse-as-library',
      '-sdk', str(sdk), '-target', 'arm64-apple-macos15.0', '-module-cache-path', str(build / 'ModuleCache'),
      '-import-objc-header', str(stage / 'NativeSignerBridge.h')]
    for include in includes: command += ['-I', str(include)]
    command += [str(root / p) for p in swift_sources] + [str(source), str(here / 'HostTransportSupport.swift'),
        str(here / 'RelayOrderingTests.swift')] + [str(build / (str(i) + '.o')) for i in range(len(c_sources))] + ['-o', str(binary)]
    commands.append(command)
    with (build / (variant + '-compile.log')).open('w') as log:
        subprocess.run(command, env=env, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=120)
    result = subprocess.run([str(binary)], env=env, capture_output=True, text=True, timeout=30)
    (build / (variant + '.json')).write_text(result.stdout)
    (build / (variant + '.stderr')).write_text(result.stderr)
    results[variant] = {'exitCode': result.returncode, 'result': json.loads(result.stdout), 'binarySha256': digest(binary), 'clientSha256': digest(source)}
receipt = {'passed': results['owning-client']['exitCode'] == 0,
 'scope': 'macOS host actual client/Handoff/crypto; in-memory exchange/pause/URL-support doubles; no network/Simulator/lower registry proof',
 'commands': commands, 'results': results,
 'sourceHashes': {p: digest(root / p) for p in c_sources + swift_sources},
 'testHashes': {p.name: digest(p) for p in here.iterdir() if p.is_file()}}
(stage / 'host-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps({'passed': receipt['passed'], 'assertions': results['owning-client']['result']['assertions'], 'receipt': str(stage / 'host-receipt.json')}))
raise SystemExit(0 if receipt['passed'] else 1)
