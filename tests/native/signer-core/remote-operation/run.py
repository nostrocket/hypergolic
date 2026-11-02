#!/usr/bin/env python3
"""Compile unchanged Android NativeRemoteOperation against explicit host ports; no device/network."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

sys.dont_write_bytecode = True
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[4])
parser.add_argument('--source', type=Path, help='Exact retained before source for red reproduction')
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
root = args.root.resolve()
here = Path(__file__).resolve().parent
source = (args.source or root / 'modules/signer-core/android/src/main/java/org/nostrocket/hypergolic/signercore/NativeRemoteOperation.java').resolve()
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=False)
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
inputs = [source, Path(__file__).resolve(), *[here / name for name in ['SystemClock.java', 'NativeVault.java', 'NativeSignerRelay.java', 'RemoteOperationTests.java']]]
java = root / '.tools/jdk/Contents/Home/bin'
tools = [java / 'javac', java / 'java']
receipt = {'passed': False, 'scope': 'Actual unchanged production Android operation class; explicit host clock, vault-error and relay-Control ports, in-memory write-admission counter and unconnected Socket close counter. No Android lifecycle, vault, crypto, actual relay send, signature or publication claim.', 'deviceOperations': 0, 'networkOperations': 0, 'source': str(source), 'sourceSha256': sha(source), 'inputHashes': {str(p): sha(p) for p in inputs}, 'toolHashes': {str(p): sha(p) for p in tools}, 'commands': []}
try:
    copied = out / 'NativeRemoteOperation.java'
    copied.write_bytes(source.read_bytes())
    if sha(copied) != receipt['sourceSha256']:
        raise RuntimeError('Copied production bytes differ')
    sources = [copied, *inputs[2:]]
    env = dict(os.environ, JAVA_HOME=str(java.parent))
    commands = [[str(java / 'javac'), '-Xlint:all', '-Werror', '--release', '17', '-d', str(out / 'classes'), *map(str, sources)], [str(java / 'java'), '-cp', str(out / 'classes'), 'org.nostrocket.hypergolic.signercore.RemoteOperationTests']]
    for name, command, limit in zip(['compile', 'test'], commands, [30, 10]):
        result = subprocess.run(command, capture_output=True, timeout=limit, env=env)
        (out / (name + '.stdout')).write_bytes(result.stdout)
        (out / (name + '.stderr')).write_bytes(result.stderr)
        receipt['commands'].append({'name': name, 'argv': command, 'exitCode': result.returncode, 'timeoutSeconds': limit})
        if name == 'compile' and result.returncode != 0:
            raise RuntimeError('Host compilation failed')
        if name == 'test':
            receipt['result'] = json.loads(result.stdout)
            receipt['passed'] = result.returncode == 0 and receipt['result'].get('passed') is True and receipt['result'].get('cases') == 14 and receipt['result'].get('assertions', 0) > 0
    receipt['inputsUnchanged'] = all(sha(Path(p)) == expected for p, expected in receipt['inputHashes'].items())
    receipt['toolsUnchanged'] = all(sha(Path(p)) == expected for p, expected in receipt['toolHashes'].items())
    receipt['passed'] = receipt['passed'] and receipt['inputsUnchanged'] and receipt['toolsUnchanged']
except BaseException as failure:
    receipt['passed'] = False
    receipt['error'] = type(failure).__name__ + ': ' + str(failure)
finally:
    receipt['artifactHashes'] = {str(p.relative_to(out)): sha(p) for p in out.rglob('*') if p.is_file()}
    (out / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({key: receipt.get(key) for key in ['passed', 'result', 'error']}))
sys.exit(0 if receipt['passed'] else 1)
