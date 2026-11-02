#!/usr/bin/env python3
"""Check exact native-panel resource transfers with resolved coroutines; no Android UI or device."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[4]
BASE = ROOT / 'modules/signer-core/android/src/main/java/org/nostrocket/hypergolic/signercore'
HERE = Path(__file__).resolve().parent
PANEL_NAMES = ('NativeImportPanel.kt', 'NativeConnectionPanel.kt')
OPT_IN = '@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)'
CALLBACK = ', onCancellation = { key?.close() }'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    env = os.environ.copy()
    java = ROOT / '.tools/jdk/Contents/Home/bin/java'
    env['JAVA_HOME'] = str(java.parents[1])
    env['ANDROID_HOME'] = str(ROOT / '.tools/android-sdk')
    env['ANDROID_SDK_ROOT'] = env['ANDROID_HOME']
    env['GRADLE_USER_HOME'] = str(ROOT / '.tools/gradle-home')
    env['PATH'] = os.pathsep.join([str(ROOT / '.tools/node/bin'), str(ROOT / '.tools/pnpm/bin'), str(java.parent), env.get('PATH', '')])
    command = [ROOT / 'android/gradlew', '-p', ROOT / 'android', ':hypergolic-signer-core:dependencyInsight',
               '--dependency', 'kotlinx-coroutines-core-jvm', '--configuration', 'releaseCompileClasspath',
               '--single-path', '--offline', '--console=plain']
    report = subprocess.check_output([str(value) for value in command], env=env, stderr=subprocess.STDOUT,
                                     text=True, timeout=120)
    (out / 'resolved-dependency.log').write_text(report)
    match = re.search(r'^org\.jetbrains\.kotlinx:kotlinx-coroutines-core-jvm:([0-9.]+)\s*$', report, re.MULTILINE)
    if not match or match.group(1) != '1.8.1':
        raise RuntimeError('Recheck panel callback contracts against the newly resolved coroutines version')
    cache = ROOT / '.tools/gradle-home/caches/modules-2/files-2.1'

    def jar(group, name, version):
        values = list((cache / group / name / version).glob('*/*.jar'))
        if len(values) != 1:
            raise RuntimeError('Required pinned host artifact unavailable: ' + name)
        return values[0]

    compiler = jar('org.jetbrains.kotlin', 'kotlin-compiler-embeddable', '2.1.20')
    stdlib = jar('org.jetbrains.kotlin', 'kotlin-stdlib', '2.1.20')
    script = jar('org.jetbrains.kotlin', 'kotlin-script-runtime', '2.1.20')
    reflect = jar('org.jetbrains.kotlin', 'kotlin-reflect', '2.1.20')
    coroutines = jar('org.jetbrains.kotlinx', 'kotlinx-coroutines-core-jvm', match.group(1))
    annotations = jar('org.jetbrains', 'annotations', '13.0')
    trove = jar('org.jetbrains.intellij.deps', 'trove4j', '1.0.20200330')
    dependencies = [compiler, stdlib, script, reflect, coroutines, annotations, trove]
    inputs = [Path(__file__).resolve(), HERE / 'ResumeCancellationProof.kt.in', *[BASE / name for name in PANEL_NAMES], *dependencies]
    before = {str(path): digest(path) for path in inputs}
    statements = []
    for name in PANEL_NAMES:
        source = (BASE / name).read_text()
        lines = [line.strip() for line in source.splitlines() if 'continuation.resume(key' in line]
        if len(lines) != 1 or CALLBACK not in lines[0] or OPT_IN not in source:
            raise RuntimeError('Review the changed panel transfer before adjusting this owning contract')
        statements.append(lines[0])
    classpath = os.pathsep.join(map(str, [stdlib, coroutines, annotations]))
    compilerpath = os.pathsep.join(map(str, dependencies))
    results = {}
    for mode in ('without-cleanup-control', 'production'):
        directory = out / mode
        directory.mkdir()
        current = [line.replace(CALLBACK, '') for line in statements] if mode == 'without-cleanup-control' else statements
        fixture = (HERE / 'ResumeCancellationProof.kt.in').read_text().replace('__OPT_IN__', OPT_IN)
        fixture = fixture.replace('__IMPORT_STATEMENT__', current[0]).replace('__CONNECTION_STATEMENT__', current[1])
        file = directory / 'ResumeCancellationProof.kt'
        file.write_text(fixture)
        compile_command = [java, '-cp', compilerpath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-Werror',
                           '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-classpath', classpath,
                           '-d', directory / 'classes', file]
        compiled = subprocess.run([str(value) for value in compile_command], text=True, capture_output=True, timeout=60)
        (directory / 'compile.log').write_text(compiled.stdout + compiled.stderr)
        if compiled.returncode:
            raise RuntimeError('Host contract compilation failed; inspect compile.log')
        runtime = [str(java), '-cp', str(directory / 'classes') + os.pathsep + classpath,
                   'org.nostrocket.hypergolic.signercore.ResumeCancellationProofKt']
        if mode == 'without-cleanup-control':
            rows = []
            for kind, name in enumerate(PANEL_NAMES):
                run = subprocess.run([*runtime, str(kind)], text=True, capture_output=True, timeout=15)
                if run.returncode == 0 or 'resource-must-close-after-resume' not in run.stderr:
                    raise RuntimeError('The removed-cleanup control did not expose the intended ownership loss')
                rows.append({'panel': name, 'expectedFailure': 'resource-not-closed-after-resume-before-dispatch'})
            results[mode] = rows
        else:
            run = subprocess.run(runtime, text=True, capture_output=True, timeout=15)
            if run.returncode:
                raise RuntimeError('Production transfer contract failed')
            results[mode] = json.loads(run.stdout)
    after = {str(path): digest(path) for path in inputs}
    if after != before:
        raise RuntimeError('Source or host artifact changed during the proof')
    receipt = {'status': 'passed', 'results': results, 'inputs': before, 'inputsUnchanged': True,
               'resolvedCoroutines': match.group(1), 'deviceAccess': False,
               'scope': 'Actual production resume statements with real coroutine dispatch and resource doubles; no Android UI, JNI teardown or phase acceptance.'}
    (out / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'status': 'passed', 'assertions': results['production']['assertions'],
                      'removedCleanupControls': len(results['without-cleanup-control']), 'deviceAccess': False}))


if __name__ == '__main__':
    main()
