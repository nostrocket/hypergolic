#!/usr/bin/env python3
"""Host-only selected-local-vault proof. Requires compiled Android Release modules and pinned local tools."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
SIGNER = ROOT / 'modules/signer-core'
HOST = ROOT / 'modules/napplet-host'
IDENTITY = ROOT / 'modules/identity-store/ios'
MESH = ROOT / 'modules/mesh-core'
JAVA_PACKAGE = Path('src/main/java/org/nostrocket/hypergolic/signercore')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    tools = ROOT / '.tools'
    java = tools / 'jdk/Contents/Home'
    cache = tools / 'gradle-home/caches/modules-2/files-2.1'
    android_jar = tools / 'android-sdk/platforms/android-37.0/android.jar'
    swift = [SIGNER / 'ios' / f'{name}.swift' for name in (
        'NativeLocalVaultLease', 'NativeVaultCore', 'NativeVaultMutationGate', 'NativeVaultRecord',
        'NativeVaultKey', 'NativeSignerCore', 'ExactSignerEvent', 'NativeNip46Protocol',
    )] + [IDENTITY / f'{name}.swift' for name in (
        'NativeSignerVaultStorage', 'Contracts', 'SystemKeychain', 'ExcludedAtomicFiles', 'IdentityStoreAvailability',
    )] + [HOST / 'ios/NativeSignerRelayPolicy.swift', MESH / 'ios/NativeMeshIdentityStore.swift']
    java_fixture = HERE.parent / 'vault-durability/fixtures'
    os_ports = sorted((java_fixture / 'android').rglob('*.java')) + [java_fixture / 'fixture/KeyStoreProvider.java']
    adapter = next((MESH / 'android').rglob('NativeMeshIdentityStore.java'))
    signer_jni = SIGNER / 'android/src/main/cpp/signer_jni.c'
    android = SIGNER / 'android' / JAVA_PACKAGE
    sources = sorted(set([
        *swift, *os_ports, adapter, signer_jni, *HERE.iterdir(),
        *(android / name for name in ('NativeVault.java', 'NativeVaultFile.java', 'NativeVaultSession.java',
                                     'NativeLocalVaultLease.java', 'NativeConnectionCandidate.java', 'SignerCoreModule.kt')),
        *(path for path in (SIGNER / 'shared').rglob('*') if path.is_file()),
    ]))
    source_pins = {str(path.relative_to(ROOT)): digest(path) for path in sources if path.is_file()}
    receipt = {
        'passed': False,
        'scope': 'Production vault owners, local lease issuers, typed Mesh adapters and native crypto. Host OS lifecycle, Keystore and file fault ports are controlled. No app, device, signing operation or network activation.',
        'sourcePins': source_pins,
        'steps': [],
    }

    def save():
        (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')

    def run(label, argv):
        command = [str(value) for value in argv]
        log = output / f'{label}.log'
        with log.open('w') as stream:
            result = subprocess.run(command, stdout=stream, stderr=subprocess.STDOUT, timeout=180)
        receipt['steps'].append({'label': label, 'command': command, 'exitCode': result.returncode, 'logSha256': digest(log)})
        save()
        if result.returncode:
            raise RuntimeError(f'{label} failed. See {log}')
        return log

    def jar(group, name, version):
        paths = sorted((cache / group / name / version).glob('*/*.jar'))
        if len(paths) != 1:
            raise RuntimeError(f'Expected one pinned cached {group}:{name}:{version} jar')
        return paths[0]

    def release_classes(module):
        directory = module / 'android/build/intermediates/javac/release/compileReleaseJavaWithJavac/classes'
        if not directory.is_dir():
            raise RuntimeError(f'Compile the pinned production Android Release module first: {module.name}')
        return directory

    try:
        signer_classes = release_classes(SIGNER)
        host_classes = release_classes(HOST)
        class_files = [signer_classes / 'org/nostrocket/hypergolic/signercore' / (name + '.class') for name in (
            'NativeLocalVaultLease', 'NativeVault', 'NativeVaultSession', 'NativeVaultFile',
            'NativeConnectionCandidate', 'NativeConnectionCandidate$Registry',
        )]
        receipt['compiledAndroidInputs'] = {str(path.relative_to(ROOT)): digest(path) for path in class_files}
        c_dir = output / 'c'
        options = ['-DCMAKE_OSX_DEPLOYMENT_TARGET=15.0'] if sys.platform == 'darwin' else []
        run('crypto-configure', ['cmake', '-S', SIGNER / 'shared', '-B', c_dir, '-DCMAKE_BUILD_TYPE=Release', *options])
        run('crypto-build', ['cmake', '--build', c_dir, '-j', '2'])
        library = c_dir / 'libhypergolic_signer.a'
        jni = output / ('libhypergolic_signer_jni.dylib' if sys.platform == 'darwin' else 'libhypergolic_signer_jni.so')
        jni_headers = java / ('include/darwin' if sys.platform == 'darwin' else 'include/linux')
        run('android-host-jni', ['clang', '-dynamiclib' if sys.platform == 'darwin' else '-shared', '-O2',
            '-I', java / 'include', '-I', jni_headers, '-I', SIGNER / 'shared/include', signer_jni, library, '-o', jni])
        java_out = output / 'java'
        java_out.mkdir()
        classpath = os.pathsep.join(map(str, [java_out, signer_classes, host_classes,
            jar('org.json', 'json', '20180813'), jar('com.google.code.gson', 'gson', '2.11.0'), android_jar]))
        run('android-host-compile', [java / 'bin/javac', '--release', '17', '-cp', classpath, '-d', java_out,
            *os_ports, adapter, HERE / 'MeshAccountLeaseProof.java', HERE / 'NativeVaultLeaseProof.java'])
        with tempfile.TemporaryDirectory(prefix='disposable-vaults-', dir=output) as scratch:
            android = run('android-host-proof', [java / 'bin/java', '-ea', '-Djava.library.path=' + str(output),
                '-cp', classpath, 'org.nostrocket.hypergolic.signercore.NativeVaultLeaseProof', scratch])
        bridge = output / 'SignerBridge.h'
        bridge.write_text('#include "hypergolic_signer.h"\n#include "hypergolic_nip44.h"\n')
        executable = output / 'local-vault-proof'
        run('swift-host-compile', ['xcrun', 'swiftc', '-swift-version', '6', '-warnings-as-errors', '-parse-as-library',
            '-target', 'arm64-apple-macosx15.0', '-module-cache-path', output / 'swift-cache',
            '-I', SIGNER / 'shared/include', '-import-objc-header', bridge, *swift,
            HERE / 'UnavailableTransports.swift', HERE / 'LocalVaultLeaseProof.swift', library, '-o', executable])
        ios = run('swift-host-proof', [executable])
        for platform, log in [('android', android), ('ios', ios)]:
            match = re.search(r'^NATIVE_LOCAL_VAULT_ASSERTIONS=(\d+)$', log.read_text(), flags=re.M)
            if not match or int(match[1]) < 20:
                raise RuntimeError(f'{platform} native assertions missing')
            receipt[platform] = {'assertions': int(match[1])}
        receipt['sourceUnchanged'] = all(digest(ROOT / path) == pinned for path, pinned in source_pins.items())
        if not receipt['sourceUnchanged']:
            raise RuntimeError('Owning sources changed during proof')
        receipt['passed'] = True
    finally:
        save()
    print(json.dumps({'passed': True, 'android': receipt['android'], 'ios': receipt['ios']}))


if __name__ == '__main__':
    main()
