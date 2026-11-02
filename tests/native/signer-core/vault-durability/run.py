#!/usr/bin/env python3
"""Offline production NativeVaultFile orchestration regression; Android/Keystore/AtomicFile are explicit doubles."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--output', required=True, type=Path)
p.add_argument('--vault-file', type=Path, help='Exact old/new production source for red/green comparison')
p.add_argument('--java-home', type=Path)
p.add_argument('--android-jar', type=Path)
a = p.parse_args()
out = a.output.resolve()
out.mkdir(mode=0o700, parents=True, exist_ok=False)
java = (a.java_home or ROOT / '.tools/jdk/Contents/Home') / 'bin'
source = (a.vault_file or ROOT / 'modules/signer-core/android/src/main/java/org/nostrocket/hypergolic/signercore/NativeVaultFile.java').resolve()
secret = ROOT / 'modules/signer-core/android/src/main/java/org/nostrocket/hypergolic/signercore/NativeSecretBuffer.java'
# A TEMP copy of this test may select the already installed JDK and unchanged helper explicitly.
if not secret.is_file():
    secret = source.with_name('NativeSecretBuffer.java')
if not secret.is_file():
    raise RuntimeError('Unchanged production NativeSecretBuffer source is required beside selected source')
fixtures = sorted((HERE / 'fixtures').rglob('*.java'))
inputs = [source, secret, Path(__file__).resolve()] + fixtures
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
pins = {str(path): sha(path) for path in inputs}
code = out / 'src/org/nostrocket/hypergolic/signercore'
code.mkdir(parents=True)
for path in [source, secret]:
    shutil.copyfile(path, code / path.name)
classes = out / 'classes'
classes.mkdir()
commands = []
env = {'PATH': str(java) + os.pathsep + '/usr/bin:/bin', 'LANG': 'C.UTF-8'}
if 'HOME' in os.environ:
    env['HOME'] = os.environ['HOME']
def run(argv, label):
    argv = [str(item) for item in argv]
    result = subprocess.run(argv, env=env, capture_output=True, text=True, timeout=30)
    (out / (label + '.log')).write_text(result.stdout + result.stderr)
    commands.append({'argv': argv, 'exitCode': result.returncode})
    return result
compile_result = run([java / 'javac', '--release', '17', '-Xlint:all', '-d', classes] + fixtures + sorted(code.glob('*.java')), 'compile')
if compile_result.returncode:
    raise RuntimeError('Host compile failed; inspect compile.log')
scratch = out / 'tmp'
scratch.mkdir(mode=0o700)
test = run([java / 'java', '-Djava.io.tmpdir=' + str(scratch), '-cp', classes,
            'org.nostrocket.hypergolic.signercore.DurabilityProof'], 'test')
api = None
if a.android_jar:
    api_classes = out / 'android-api-classes'
    api_classes.mkdir()
    api = run([java / 'javac', '--release', '17', '-classpath', a.android_jar.resolve(), '-d', api_classes,
               code / source.name, code / secret.name,
               HERE / 'fixtures/org/nostrocket/hypergolic/signercore/NativeVault.java'], 'android-api')
    pins[str(a.android_jar.resolve())] = sha(a.android_jar.resolve())
unchanged = all(sha(Path(path)) == digest for path, digest in pins.items())
report = {'passed': test.returncode == 0 and (api is None or api.returncode == 0) and unchanged,
          'scope': 'Actual production file read/write orchestration; real host AES-GCM and local files. Explicit Android OS/Keystore/AtomicFile fault doubles. No app build, Android execution or physical durability claim.',
          'sourcePins': pins, 'sourceUnchanged': unchanged, 'commands': commands,
          'output': test.stdout, 'deviceNetworkOrLiveWrites': 0}
(out / 'receipt.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'passed': report['passed'], 'testExitCode': test.returncode, 'sourceUnchanged': unchanged}))
raise SystemExit(0 if report['passed'] else 1)
