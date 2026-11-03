#!/usr/bin/env python3
"""Check exact native-panel resource transfers with resolved coroutines; no Android UI or device."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import shutil

ROOT = Path(__file__).resolve().parents[4]
BASE = ROOT / 'modules/signer-core/android/src/main/java/org/nostrocket/hypergolic/signercore'
HERE = Path(__file__).resolve().parent
PANEL_NAMES = ('NativeImportPanel.kt', 'NativeConnectionPanel.kt')
OPT_IN = '@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)'
CALLBACK = ', onCancellation = { _, value, _ -> value?.close() }'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    env = os.environ.copy()
    default_java_home = ROOT / '.tools/jdk/Contents/Home'
    if 'JAVA_HOME' not in env and default_java_home.is_dir():
        env['JAVA_HOME'] = str(default_java_home)
    java = Path(env['JAVA_HOME']) / 'bin/java' if env.get('JAVA_HOME') else Path(shutil.which('java') or '')
    if not java.is_file():
        raise RuntimeError('Configure JAVA_HOME or java on PATH for the reviewed toolchain')
    env.setdefault('ANDROID_HOME', env.get('ANDROID_SDK_ROOT', str(ROOT / '.tools/android-sdk')))
    env.setdefault('ANDROID_SDK_ROOT', env['ANDROID_HOME'])
    env.setdefault('GRADLE_USER_HOME', str(ROOT / '.tools/gradle-home'))
    env['PATH'] = os.pathsep.join([env.get('PATH', ''), str(java.parent),
                                 str(ROOT / '.tools/node/bin'), str(ROOT / '.tools/pnpm/bin')])
    command = [ROOT / 'android/gradlew', '-p', ROOT / 'android', ':hypergolic-signer-core:reportPanelProofInputs',
               '--init-script', HERE / 'inputs.gradle', '--offline', '--no-daemon', '--max-workers=1', '--console=plain']
    report = subprocess.run([str(value) for value in command], env=env, capture_output=True,
                            text=True, timeout=180)
    (out / 'resolved-dependency.log').write_text(report.stdout + report.stderr)
    if report.returncode:
        raise RuntimeError('Production dependency/compiler report failed; inspect resolved-dependency.log')
    rows = [line.removeprefix('PANEL_PROOF_INPUTS=') for line in report.stdout.splitlines()
            if line.startswith('PANEL_PROOF_INPUTS=')]
    if len(rows) != 1:
        raise RuntimeError('Expected one production signer dependency/compiler report')
    selected = json.loads(rows[0])
    (out / 'resolved-inputs.json').write_text(json.dumps(selected, indent=2) + '\n')
    compiler_files = [Path(value) for value in selected['compilerClasspath']]
    libraries = [Path(value) for value in selected['libraries']]
    compiler_versions = [re.fullmatch(r'kotlin-compiler-embeddable-(.+)\.jar', path.name).group(1)
                         for path in compiler_files if path.name.startswith('kotlin-compiler-embeddable-')]
    coroutines_versions = [item['version'] for item in selected['releaseComponents']
                           if item['group'] == 'org.jetbrains.kotlinx' and item['name'] == 'kotlinx-coroutines-core-jvm']
    if compiler_versions != ['2.2.10'] or coroutines_versions != ['1.10.2']:
        raise RuntimeError('Recheck panel ownership against the changed production Kotlin/coroutines selection')
    if not all(path.is_file() for path in compiler_files + libraries):
        raise RuntimeError('A selected production host artifact is missing')
    inputs = [Path(__file__).resolve(), HERE / 'inputs.gradle', HERE / 'ResumeCancellationProof.kt.in',
              *[BASE / name for name in PANEL_NAMES], *compiler_files, *libraries]
    before = {str(path): digest(path) for path in inputs}
    statements = []
    for name in PANEL_NAMES:
        source = (BASE / name).read_text()
        lines = [line.strip() for line in source.splitlines() if 'continuation.resume(key' in line]
        if len(lines) != 1 or CALLBACK not in lines[0] or OPT_IN not in source:
            raise RuntimeError('Review the changed panel transfer before adjusting this owning contract')
        statements.append(lines[0])
    classpath = os.pathsep.join(map(str, libraries))
    compilerpath = os.pathsep.join(map(str, compiler_files))
    results = {}
    for mode in ('without-cleanup-control', 'production'):
        directory = out / mode
        directory.mkdir()
        current = [line.replace(CALLBACK, '') for line in statements] if mode == 'without-cleanup-control' else statements
        fixture = (HERE / 'ResumeCancellationProof.kt.in').read_text().replace('__OPT_IN__', OPT_IN)
        fixture = fixture.replace('__IMPORT_STATEMENT__', current[0]).replace('__CONNECTION_STATEMENT__', current[1])
        fixture = fixture.replace('__COROUTINES_VERSION__', coroutines_versions[0])
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
                (directory / (name + '.run.log')).write_text(run.stdout + run.stderr)
                if run.returncode == 0 or 'resource-must-close-after-resume' not in run.stderr:
                    raise RuntimeError('The removed-cleanup control did not expose the intended ownership loss')
                rows.append({'panel': name, 'exitCode': run.returncode,
                             'expectedFailure': 'resource-not-closed-after-resume-before-dispatch'})
            results[mode] = rows
        else:
            run = subprocess.run(runtime, text=True, capture_output=True, timeout=15)
            (directory / 'run.log').write_text(run.stdout + run.stderr)
            if run.returncode:
                raise RuntimeError('Production transfer contract failed')
            results[mode] = json.loads(run.stdout)
            if results[mode].get('assertions') != 36 or results[mode].get('panelStatements') != 2:
                raise RuntimeError('Expected all production ownership scenarios and both panels')
    after = {str(path): digest(path) for path in inputs}
    if after != before:
        raise RuntimeError('Source or host artifact changed during the proof')
    receipt = {'status': 'passed', 'results': results, 'inputs': before, 'inputsUnchanged': True,
               'resolvedCoroutines': coroutines_versions[0], 'resolvedKotlinCompiler': compiler_versions[0],
               'compilerClasspath': selected['compilerClasspath'], 'runtimeClasspath': selected['libraries'],
               'callerToolEnvironment': {key: env.get(key) for key in ('JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'GRADLE_USER_HOME')},
               'deviceAccess': False,
               'scope': 'Actual production resume statements with real coroutine dispatch and resource doubles; no Android UI, JNI teardown or phase acceptance.'}
    (out / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'status': 'passed', 'assertions': results['production']['assertions'],
                      'removedCleanupControls': len(results['without-cleanup-control']), 'deviceAccess': False}))


if __name__ == '__main__':
    main()
