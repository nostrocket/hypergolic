#!/usr/bin/env python3
"""Minify actual signer transport sources with/without their consumer rule."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import zipfile
from audit import audit, member, CLASS, SIGNATURE

ROOT = Path(__file__).resolve().parents[4]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    root, output = args.root.resolve(), args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    sdk, java = Path(os.environ['ANDROID_HOME']), Path(os.environ['JAVA_HOME']) / 'bin/java'
    platform = sdk / 'platforms/android-37.0/android.jar'
    r8 = sdk / 'build-tools/37.0.0/lib/d8.jar'
    owner = root / 'modules/signer-core/android'
    rules = owner / 'consumer-rules.pro'
    if "consumerProguardFiles 'consumer-rules.pro'" not in (owner / 'build.gradle').read_text():
        raise ValueError('Owning consumer rule is not registered')
    source = owner / 'src/main/java'
    inputs = {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
              for path in source.rglob('*.java')}
    classes = output / 'classes'
    classes.mkdir()

    def run(command, name):
        result = subprocess.run(list(map(str, command)), capture_output=True, text=True, timeout=120)
        (output / (name + '.log')).write_text(result.stdout + result.stderr)
        result.check_returncode()

    run([java.parent / 'javac', '--release', '17', '-cp', platform, '-sourcepath', source,
         '-d', classes, Path(__file__).with_name('TransportProof.java'),
         source / 'org/nostrocket/hypergolic/signercore/NativeTransportCrypto.java'], 'javac')
    jar = output / 'input.jar'
    with zipfile.ZipFile(jar, 'w') as archive:
        for path in sorted(classes.rglob('*.class')):
            archive.write(path, str(path.relative_to(classes)))
    base = output / 'entry.pro'
    base.write_text('-keep class org.nostrocket.hypergolic.signercore.TransportProof { public static void main(java.lang.String[]); }\n'
                    '-keepclasseswithmembernames,includedescriptorclasses class * { native <methods>; }\n')
    result = {'scope': 'Actual R8 DEX packaging; execute each probe with the same JNI library separately',
              'inputs': inputs, 'consumerRuleSha256': hashlib.sha256(rules.read_bytes()).hexdigest()}
    for name, consumer in [('without-consumer', False), ('with-consumer', True)]:
        target = output / name
        target.mkdir()
        command = [java, '-cp', r8, 'com.android.tools.r8.R8', '--release', '--min-api', '36',
                   '--lib', platform, '--pg-conf', base, '--output', target, jar]
        if consumer:
            command += ['--pg-conf', rules]
        run(command, name)
        if consumer:
            proof = audit(target / 'classes.dex')
        else:
            data = (target / 'classes.dex').read_bytes()
            for owner_class, member_name, signature, is_static in [
                    (CLASS, 'hmac', SIGNATURE, True),
                    ('Lorg/nostrocket/hypergolic/signercore/NativeSignerCore$Denied;',
                     '<init>', '(Ljava/lang/String;)V', False)]:
                try:
                    member(data, owner_class, member_name, signature, is_static)
                except ValueError as error:
                    if str(error) != 'JNI named class is absent':
                        raise
                else:
                    raise AssertionError('Negative control retained JNI class')
            proof = {'callbackAbsent': True, 'denialClassAbsent': True}
        result[name] = proof
        with zipfile.ZipFile(target / 'probe.jar', 'w') as archive:
            archive.write(target / 'classes.dex', 'classes.dex')
    if any(hashlib.sha256((root / name).read_bytes()).hexdigest() != digest
           for name, digest in inputs.items()):
        raise ValueError('Owning sources changed during proof')
    (output / 'receipt.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({name: result[name] for name in ['without-consumer', 'with-consumer']}))


if __name__ == '__main__':
    main()
