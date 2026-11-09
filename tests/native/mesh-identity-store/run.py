#!/usr/bin/env python3
"""Host-only snapshot/storage proofs plus real native TLS credential callbacks; no OS-store/device writes."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--tls-build', type=Path, required=True)
    parser.add_argument('--tools-root', type=Path, default=Path(__file__).resolve().parents[3] / '.tools')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[3]
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    proof = root / 'tests/native/mesh-identity-store'
    android = root / 'modules/mesh-core/android/src/main/java/org/nostrocket/hypergolic/mesh'
    swift = root / 'modules/mesh-core/ios'
    local_java = root / 'modules/signer-core/android/src/main/java/org/nostrocket/hypergolic/signercore/NativeLocalVaultLease.java'
    local_swift = root / 'modules/signer-core/ios/NativeLocalVaultLease.swift'
    owned = sorted([*android.glob('*.java'), *swift.glob('*.swift'), *(p for p in proof.iterdir() if p.is_file())])
    tls = args.tls_build.resolve()
    upstream = json.loads((tls / 'receipt.json').read_text())
    if upstream['status'] != 'passed' or upstream['sourceBefore'] != upstream['sourceAfter']:
        raise RuntimeError('Final TLS dependency receipt is not passing/unchanged')
    libs = [tls / 'host' / name for name in ['libhypergolic_mesh_tls.a', 'upstream/library/libmbedtls.a', 'upstream/library/libmbedx509.a', 'upstream/tf-psa-crypto/core/libtfpsacrypto.a']]
    archived = {row['path']: row['sha256'] for row in upstream['archives']}
    for lib in libs:
        if digest(lib) != archived[str(lib.relative_to(tls))]:
            raise RuntimeError('TLS archive drift')
    for relative in ['modules/mesh-core/shared/hypergolic_mesh_tls.h', 'modules/mesh-core/shared/hypergolic_mesh_tls.c']:
        path = root / relative
        if digest(path) != upstream['sourceBefore'][relative]:
            raise RuntimeError('TLS source/header mismatch')
        owned.append(path)
    owned += [local_java, local_swift]
    before = {str(p.relative_to(root)): digest(p) for p in owned}
    steps = []
    receipt = {'status': 'running', 'scope': 'Host snapshots/real encrypted file faults/Keychain API ports and actual native TLS DER; Android/iPhoneOS adapter compilation, no OS-keystore/Keychain execution, device or pairing acceptance', 'sourceBefore': before, 'steps': steps, 'tlsReceiptSha256': digest(tls / 'receipt.json'), 'tlsArchives': {str(p): digest(p) for p in libs}}

    def save():
        (out / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')

    def run(name, argv):
        start = time.monotonic()
        with (out / (name + '.log')).open('w') as log:
            result = subprocess.run([str(x) for x in argv], stdout=log, stderr=subprocess.STDOUT, timeout=180)
        steps.append({'name': name, 'exitCode': result.returncode, 'seconds': time.monotonic() - start, 'command': [str(x) for x in argv], 'logSha256': digest(out / (name + '.log'))})
        save()
        if result.returncode:
            raise RuntimeError(name + ' failed; original log preserved')

    save()
    try:
        jdk = args.tools_root / 'jdk/Contents/Home'
        jar = args.tools_root / 'android-sdk/platforms/android-37.0/android.jar'
        classes = out / 'classes'
        run('android-production-compile', [jdk / 'bin/javac', '--release', '8', '-Xlint:all', '-Werror', '-cp', jar, '-d', classes, *sorted(android.glob('*.java')), local_java])
        run('java-proof-compile', [jdk / 'bin/javac', '--release', '17', '-Xlint:all', '-Werror', '-cp', os.pathsep.join([str(classes), str(jar)]), '-d', classes, proof / 'IdentityProof.java'])
        includes = ['-I', root / 'modules/mesh-core/shared']
        common = ['xcrun', 'clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-Wpedantic', *includes]
        run('jni-fixture-compile', [*common, '-fPIC', '-dynamiclib', '-DHG_MESH_STORE_JNI', '-I', jdk / 'include', '-I', jdk / 'include/darwin', proof / 'tls_fixture.c', *libs, '-o', out / 'libstorefixture.dylib'])
        run('java-proof', [jdk / 'bin/java', '-Dproof.output=' + str(out), '-cp', classes, 'org.nostrocket.hypergolic.mesh.IdentityProof', out / 'libstorefixture.dylib'])
        run('c-fixture-compile', [*common, '-c', proof / 'tls_fixture.c', '-o', out / 'tls_fixture.o'])
        swift_common = ['xcrun', 'swiftc', '-swift-version', '6', '-warnings-as-errors', '-parse-as-library', '-module-cache-path', out / 'swift-cache']
        run('swift-host-compile', [*swift_common, '-import-objc-header', proof / 'tls_fixture.h', *sorted(swift.glob('*.swift')), local_swift, proof / 'IdentityProof.swift', out / 'tls_fixture.o', *libs, '-o', out / 'swift-proof'])
        run('swift-proof', [out / 'swift-proof', out])
        sdk = subprocess.check_output(['xcrun', '--sdk', 'iphoneos', '--show-sdk-path'], text=True, timeout=20).strip()
        run('iphoneos-arm64-production-compile', [*swift_common, '-target', 'arm64-apple-ios18.4', '-sdk', sdk, '-whole-module-optimization', '-emit-object', '-module-name', 'MeshIdentity', *sorted(swift.glob('*.swift')), local_swift, '-o', out / 'mesh-identity-iphoneos.o'])
        for name in ['java', 'swift']:
            result = json.loads((out / (name + '-proof.log')).read_text().strip().splitlines()[-1])
            if result['status'] != 'passed' or not result['allCredentialsClosed']:
                raise RuntimeError('Invalid native proof completion')
            receipt[name] = result
        if receipt['java']['snapshotSHA256'] != receipt['swift']['snapshotSHA256']:
            raise RuntimeError('Native snapshot bytes differ')
        receipt['status'] = 'passed'
    except Exception:
        receipt['status'] = 'failed'
        raise
    finally:
        receipt['disposableFixtureFiles'] = {}
        for name in ['credential.fixture', 'java-snapshot.bin', 'swift-snapshot.bin']:
            path = out / name
            if path.exists():
                receipt['disposableFixtureFiles'][name] = {'sha256': digest(path), 'removedAfterProof': True}
                path.unlink()
        receipt['sourceAfter'] = {str(p.relative_to(root)): digest(p) for p in owned}
        receipt['sourceUnchanged'] = before == receipt['sourceAfter']
        if not receipt['sourceUnchanged']:
            receipt['status'] = 'failed'
        save()
    if receipt['status'] != 'passed':
        raise RuntimeError('Source changed')
    print(json.dumps({'status': receipt['status'], 'java': receipt['java']['checks'], 'swift': receipt['swift']['checks'], 'receipt': str(out / 'receipt.json')}))


if __name__ == '__main__':
    main()
