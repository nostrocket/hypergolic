#!/usr/bin/env python3
"""Exact Android accepted-result/completion/perform bodies with explicit host ports; no device/network."""
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
parser.add_argument('--client-source', type=Path)
parser.add_argument('--module-source', type=Path)
parser.add_argument('--controller-source', type=Path)
parser.add_argument('--ports', type=Path, help='Directory of explicit SystemClock/relay Control ports; defaults to this directory')
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
root = args.root.resolve()
here = Path(__file__).resolve().parent
ports = (args.ports or here).resolve()
base = root / 'modules/signer-core/android/src/main/java/org/nostrocket/hypergolic/signercore'
client = (args.client_source or base / 'NativeNip46Client.java').resolve()
module = (args.module_source or base / 'SignerCoreModule.kt').resolve()
operation = base / 'NativeRemoteOperation.java'
controller = (args.controller_source or base / 'NativeHandoffController.kt').resolve()
ticket = base / 'NativeHandoffTicket.java'
facade = root / 'modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host/NativeSigningSourceFacade.kt'
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=False)
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
receipt = {'passed': False, 'deviceOperations': 0, 'networkOperations': 0, 'scope': 'Actual unchanged complete NativeRemoteOperation plus exact acceptedResult method, completed lambda, Capture.perform and actual Authorization captured/state/execute/awaitResume body extraction with complete actual NativeHandoffTicket. Explicit synchronous continuation/session/record/source-state/authorization ports; no protocol, JNI, crypto, coroutine/Android scheduling, protected vault, signature, relay delivery, publication or ordinary-app acceptance.', 'commands': [], 'results': {}}
def block(path, marker):
    text = path.read_text()
    if text.count(marker) != 1:
        raise RuntimeError('Owning extraction marker changed: ' + marker)
    start = text.index(marker)
    end = text.index('{', start) + 1
    depth = 1
    while depth:
        depth += (text[end] == '{') - (text[end] == '}')
        end += 1
    return text[start:end]
def command(name, argv, limit):
    argv = list(map(str, argv))
    result = subprocess.run(argv, capture_output=True, timeout=limit, env=dict(os.environ, JAVA_HOME=str(java.parent)))
    (out / (name + '.stdout')).write_bytes(result.stdout)
    (out / (name + '.stderr')).write_bytes(result.stderr)
    receipt['commands'].append({'name': name, 'argv': argv, 'exitCode': result.returncode, 'timeoutSeconds': limit})
    return result
try:
    java = root / '.tools/jdk/Contents/Home/bin'
    cache = root / '.tools/gradle-home/caches/modules-2/files-2.1'
    def jar(group, name, version):
        matches = list((cache / group / name / version).glob('*/*.jar'))
        if len(matches) != 1:
            raise RuntimeError('Exact installed compiler dependency unavailable: ' + name)
        return matches[0]
    compiler = [jar('org.jetbrains.kotlin', name, '2.1.20') for name in ['kotlin-compiler-embeddable', 'kotlin-stdlib', 'kotlin-script-runtime', 'kotlin-reflect']]
    compiler += [jar('org.jetbrains.kotlinx', 'kotlinx-coroutines-core-jvm', '1.8.1'), jar('org.jetbrains', 'annotations', '13.0'), jar('org.jetbrains.intellij.deps', 'trove4j', '1.0.20200330')]
    java_ports = [ports / 'SystemClock.java', ports / 'NativeSignerRelay.java', here / 'NativeVault.java']
    inputs = [client, module, operation, facade, controller, ticket, Path(__file__).resolve(), here / 'AcceptedResultTests.java.in', here / 'CompletedResultTests.kt.in', here / 'HandoffResumeTests.kt.in', *java_ports, *compiler, java / 'javac', java / 'java']
    receipt['inputHashes'] = {str(path): sha(path) for path in inputs}
    extracted = {'acceptedResult': block(client, 'private void acceptedResult()'), 'completed': block(module, 'val completed: (String?) -> Unit ='), 'perform': block(facade, 'fun perform(effect: Runnable)')}
    controller_text = controller.read_text()
    def between(start, end):
        if controller_text.count(start) != 1 or controller_text.count(end) != 1:
            raise RuntimeError('Authorization expression marker changed')
        return controller_text[controller_text.index(start):controller_text.index(end)].strip()
    extracted.update({'captured': between('    private fun captured(): Boolean', '    fun state(): String?'), 'handoffState': block(controller, 'fun state(): String?'), 'handoffExecute': between('    fun execute(): Boolean', '    override fun challenge('), 'awaitResume': block(controller, 'override fun awaitResume(requestId: String)')})
    receipt['extractionSha256'] = {name: hashlib.sha256(body.encode()).hexdigest() for name, body in extracted.items()}
    accepted = (here / 'AcceptedResultTests.java.in').read_text().replace('__ACTUAL_ACCEPTED_RESULT__', extracted['acceptedResult'])
    completed = (here / 'CompletedResultTests.kt.in').read_text().replace('__ACTUAL_COMPLETED__', extracted['completed']).replace('__ACTUAL_PERFORM__', extracted['perform'])
    handoff = (here / 'HandoffResumeTests.kt.in').read_text()
    for name, marker in [('captured','CAPTURED'), ('handoffState','STATE'), ('handoffExecute','EXECUTE'), ('awaitResume','AWAIT_RESUME')]:
        handoff = handoff.replace('__ACTUAL_' + marker + '__', extracted[name])
    (out / 'HandoffResumeTests.kt').write_text(handoff)
    (out / 'AcceptedResultTests.java').write_text(accepted)
    (out / 'CompletedResultTests.kt').write_text(completed)
    classes = out / 'classes'
    compiled = command('java-compile', [java / 'javac', '-Xlint:all', '-Werror', '--release', '17', '-d', classes, operation, ticket, *java_ports, out / 'AcceptedResultTests.java'], 30)
    if compiled.returncode != 0:
        raise RuntimeError('Java host compilation failed')
    checked = command('accepted-result-test', [java / 'java', '-cp', classes, 'org.nostrocket.hypergolic.signercore.AcceptedResultTests'], 10)
    receipt['results']['acceptedResult'] = json.loads(checked.stdout)
    cp = os.pathsep.join(map(str, [classes, compiler[1], compiler[5]]))
    compiled = command('kotlin-compile', [java / 'java', '-cp', os.pathsep.join(map(str, compiler)), 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-Werror', '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-classpath', cp, '-d', classes, out / 'CompletedResultTests.kt', out / 'HandoffResumeTests.kt'], 30)
    if compiled.returncode != 0:
        raise RuntimeError('Kotlin host compilation failed')
    checked = command('completed-result-test', [java / 'java', '-cp', cp, 'org.nostrocket.hypergolic.signercore.CompletedResultTestsKt'], 10)
    receipt['results']['completedResult'] = json.loads(checked.stdout)
    checked = command('handoff-resume-test', [java / 'java', '-cp', cp, 'org.nostrocket.hypergolic.signercore.HandoffResumeTestsKt'], 10)
    receipt['results']['handoffResume'] = json.loads(checked.stdout)
    receipt['inputsUnchanged'] = all(sha(Path(path)) == expected for path, expected in receipt['inputHashes'].items())
    receipt['passed'] = receipt['inputsUnchanged'] and all(value.get('passed') is True for value in receipt['results'].values()) and receipt['results']['acceptedResult']['cases'] == 13 and receipt['results']['completedResult']['cases'] == 35 and receipt['results']['handoffResume']['cases'] == 14 and all(item['exitCode'] == 0 for item in receipt['commands'])
except BaseException as failure:
    receipt['error'] = type(failure).__name__ + ': ' + str(failure)
finally:
    receipt['artifactHashes'] = {str(path.relative_to(out)): sha(path) for path in out.rglob('*') if path.is_file()}
    (out / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({key: receipt.get(key) for key in ['passed', 'results', 'error']}))
sys.exit(0 if receipt['passed'] else 1)
