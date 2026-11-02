#!/usr/bin/env python3
"""Compile the owning Android deletion authority and run its isolated JVM regressions."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path, help='Fresh private evidence directory')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    source = root / 'modules/identity-owner/android/src/main/java/org/nostrocket/hypergolic/identityowner/DeletionAuthority.java'
    proof = root / 'tests/native/android-identity-actions/DeletionAuthorityProof.java'
    registry = source.with_name('IdentityOwnerContextRegistry.java')
    codec = source.with_name("BackupNsec.java")
    backup_proof = proof.with_name("BackupAuthorityProof.java")
    codec_proof = proof.with_name("BackupNsecProof.java")
    inputs = [source, registry, proof, codec, backup_proof, codec_proof, Path(__file__).resolve()]
    for path in inputs:
        if not path.is_file() or path.is_symlink():
            raise RuntimeError('Missing or redirected owning input')
    before = {str(p.relative_to(root)): sha(p) for p in inputs}
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    commands = [
        ['javac', '-d', str(output / 'classes'), str(source), str(registry), str(proof), str(codec), str(backup_proof), str(codec_proof)],
        ['java', '-cp', str(output / 'classes'), 'org.nostrocket.hypergolic.identityowner.DeletionAuthorityProof'],
        ['java', '-cp', str(output / 'classes'), 'org.nostrocket.hypergolic.identityowner.BackupAuthorityProof'],
        ['java', '-cp', str(output / 'classes'), 'org.nostrocket.hypergolic.identityowner.BackupNsecProof'],
    ]
    for index, command in enumerate(commands):
        with (output / f'{index}.log').open('w') as log:
            subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
    result = json.loads((output / '1.log').read_text())
    if result.get('status') != 'passed' or not isinstance(result.get('assertions'), int) or result['assertions'] < 126:
        raise RuntimeError('Incomplete authority regression result')
    result['backup'] = json.loads((output / '2.log').read_text())
    result['encoding'] = json.loads((output / '3.log').read_text())
    for name in ('backup', 'encoding'):
        if result[name].get('status') != 'passed' or result[name].get('assertions', 0) < 1:
            raise RuntimeError('Incomplete backup regression result')
    after = {str(p.relative_to(root)): sha(p) for p in inputs}
    if after != before:
        raise RuntimeError('Owning inputs changed during the run')
    result['sourceSha256'] = before
    result['policySourceCopies'] = 0
    (output / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
