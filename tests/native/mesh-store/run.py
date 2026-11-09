#!/usr/bin/env python3
"""Focused desktop filesystem proofs; no devices or real signature acceptance."""
import argparse
import json
import os
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--out', type=Path, required=True)
parser.add_argument('--jdk', type=Path, required=True)
parser.add_argument('--android-jar', type=Path, required=True)
parser.add_argument('--kotlin-classpath', required=True)
parser.add_argument('--kotlin-stdlib', type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[3]
out = args.out.resolve()
out.mkdir(parents=True, exist_ok=False)
classes = out / 'classes'
classes.mkdir()
steps = []
def step(name, command):
    with (out / (name + '.log')).open('w') as log:
        try:
            code = subprocess.run([str(x) for x in command], cwd=root, stdout=log, stderr=subprocess.STDOUT, timeout=90).returncode
        except subprocess.TimeoutExpired:
            code = 124
    steps.append({'name': name, 'exitCode': code, 'command': [str(x) for x in command]})
    return code == 0
java_dir = root / 'modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host'
kotlin_ok = step('kotlin-helper', [args.jdk / 'bin/java', '-cp', args.kotlin_classpath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-Werror', '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-classpath', args.kotlin_stdlib, '-d', classes, java_dir / 'NativeCanonicalJSON.kt'])
cp = os.pathsep.join(str(p) for p in [classes, args.kotlin_stdlib, args.android_jar])
if kotlin_ok and step('java-compile', [args.jdk / 'bin/javac', '--release', '17', '-Xlint:all', '-Werror', '-cp', cp, '-d', classes, java_dir / 'NativeMeshStore.java', root / 'tests/native/mesh-store/StoreProof.java']):
    step('java-proof', [args.jdk / 'bin/java', '-cp', cp, 'org.nostrocket.hypergolic.host.StoreProof', out / 'java-files'])
if step('swift-compile', ['xcrun', 'swiftc', '-swift-version', '6', '-warnings-as-errors', '-parse-as-library', '-module-cache-path', out / 'swift-cache', root / 'modules/napplet-host/ios/NativeCanonicalJSON.swift', root / 'modules/napplet-host/ios/NativeMeshStore.swift', root / 'tests/native/mesh-store/StoreProof.swift', '-o', out / 'swift-proof']):
    step('swift-proof', [out / 'swift-proof', out / 'swift-files'])
passed = all(s['exitCode'] == 0 for s in steps) and {s['name'] for s in steps} >= {'java-proof', 'swift-proof'}
receipt = {'status': 'passed' if passed else 'failed', 'scope': 'Host filesystem fixture proofs; injected fixture signature verifier; no real BIP340, app or device acceptance.', 'steps': steps}
(out / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
for s in steps:
    print(s['name'], s['exitCode'])
    if s['exitCode'] or s['name'].endswith('-proof'):
        print((out / (s['name'] + '.log')).read_text()[-6000:])
raise SystemExit(0 if passed else 1)
