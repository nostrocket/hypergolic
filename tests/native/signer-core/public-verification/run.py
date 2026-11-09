#!/usr/bin/env python3
"""Host-only actual public verifier/JNI/C proof; no Gradle, device, keys or network."""
import argparse
import csv
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
SIGNER = ROOT / 'modules/signer-core'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--tuples', type=Path, help='Optional public-only compact tuple batch for timing')
    parser.add_argument('--classes', type=Path, default=SIGNER / 'android/build/intermediates/javac/release/compileReleaseJavaWithJavac/classes',
                        help='Existing compiled Android ABI for NativeSigningKey references; never builds it')
    args = parser.parse_args()
    out = args.output.resolve()
    if out.exists():
        parser.error('Choose fresh output')
    if sys.platform != 'darwin' or not args.classes.is_dir():
        parser.error('macOS and existing compiled Android ABI required; this runner never installs/builds an app')
    jdk = Path(os.environ.get('JAVA_HOME', ROOT / '.tools/jdk/Contents/Home'))
    out.mkdir(parents=True)
    commands = []

    def run(command, name):
        commands.append(list(map(str, command)))
        with (out / (name + '.log')).open('w') as log:
            subprocess.run(list(map(str, command)), cwd=out, stdout=log, stderr=subprocess.STDOUT, check=True)

    vectors = []
    with (SIGNER / 'tests/bip340-test-vectors.csv').open() as stream:
        for row in csv.DictReader(stream):
            if len(row['message']) == 64:
                vectors.append([row['public key'].lower(), row['message'].lower(), row['signature'].lower(), row['verification result']])
    (out / 'vectors.tsv').write_text(''.join('\t'.join(row) + '\n' for row in vectors))
    tuples = json.loads(args.tuples.read_text()) if args.tuples else [vectors[0][:3]] * 80
    (out / 'tuples.json').write_text(json.dumps(tuples, separators=(',', ':')))
    run(['cmake', '-S', SIGNER / 'shared', '-B', out / 'c', '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_OSX_DEPLOYMENT_TARGET=15.0'], 'cmake')
    run(['cmake', '--build', out / 'c', '-j', '2'], 'c-build')
    java = SIGNER / 'android/src/main/java/org/nostrocket/hypergolic/signercore'
    run([jdk / 'bin/javac', '-Xlint:all', '-Werror', '-cp', args.classes, '-d', out / 'classes',
         java / 'NativeSigningKey.java', java / 'NativePublicVerification.java', HERE / 'PublicVerificationProof.java'], 'javac')
    run(['clang', '-dynamiclib', '-O2', '-I', jdk / 'include', '-I', jdk / 'include/darwin', '-I', SIGNER / 'shared/include',
         SIGNER / 'android/src/main/cpp/signer_jni.c', out / 'c/libhypergolic_signer.a', '-o', out / 'libhypergolic_signer_jni.dylib'], 'jni')
    run([jdk / 'bin/java', '-Djava.library.path=' + str(out), '-cp', str(out / 'classes') + os.pathsep + str(args.classes),
         'org.nostrocket.hypergolic.signercore.PublicVerificationProof', out / 'tuples.json', out / 'vectors.tsv'], 'java-proof')
    sdk = subprocess.check_output(['xcrun', '--sdk', 'macosx', '--show-sdk-path'], text=True).strip()
    (out / 'module.modulemap').write_text('module CHypergolicSigner { header "' + str(SIGNER / 'shared/include/hypergolic_signer.h') + '" export * }\n')
    run(['xcrun', 'swiftc', '-sdk', sdk, '-target', 'arm64-apple-macos15.0', '-module-cache-path', out / 'cache', '-swift-version', '6',
         '-warnings-as-errors', '-O', '-I', out, SIGNER / 'ios/NativePublicVerification.swift', HERE / 'PublicVerificationProof.swift',
         out / 'c/libhypergolic_signer.a', '-o', out / 'swift-proof'], 'swiftc')
    run([out / 'swift-proof', out / 'tuples.json', out / 'vectors.tsv'], 'swift-proof')
    inputs = [java / 'NativePublicVerification.java', java / 'NativeSigningKey.java', SIGNER / 'ios/NativePublicVerification.swift',
              SIGNER / 'shared/hypergolic_signer.c', HERE / 'PublicVerificationProof.java', HERE / 'PublicVerificationProof.swift']
    receipt = {'scope': __doc__, 'passed': True, 'commands': commands,
               'sourceSHA256': {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in inputs},
               'java': json.loads((out / 'java-proof.log').read_text()), 'swift': json.loads((out / 'swift-proof.log').read_text())}
    (out / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt, indent=2))


if __name__ == '__main__':
    main()
