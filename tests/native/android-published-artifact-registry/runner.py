#!/usr/bin/env python3
"""Compile the production Android artifact registry directly and retain a JVM receipt."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[3]
SOURCE = 'modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host/PublishedArtifactRegistry.java'
TRANSFER = 'modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host/PublishedArtifactTransfer.java'
READ_OWNER = 'modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host/PublishedArtifactReadOwner.java'
PROOF = 'tests/native/android-published-artifact-registry/PublishedArtifactRegistryProof.java'
TRANSFER_PROOF = 'tests/native/android-published-artifact-registry/PublishedArtifactTransferProof.java'
READ_OWNER_PROOF = 'tests/native/android-published-artifact-registry/PublishedArtifactReadOwnerProof.java'
RUNNER = 'tests/native/android-published-artifact-registry/runner.py'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    if output.is_relative_to(ROOT) and not output.is_relative_to(ROOT / '.tools'):
        raise RuntimeError('Evidence must be outside source or under ignored .tools')
    output.mkdir(parents=True, exist_ok=False)
    sources = [SOURCE, TRANSFER, READ_OWNER, PROOF, TRANSFER_PROOF, READ_OWNER_PROOF, RUNNER]
    before = {path: digest(ROOT / path) for path in sources}
    receipt = {'status': 'failed', 'sourceSha256': before,
               'scope': 'Owning Android JVM registry, transfer and read-owner proofs; native view compile only, no device proof.'}
    try:
        result = subprocess.run(
            ['javac', '-Xlint:all', '-Werror', '-d', str(output / 'classes'),
             str(ROOT / SOURCE), str(ROOT / TRANSFER), str(ROOT / READ_OWNER),
             str(ROOT / PROOF), str(ROOT / TRANSFER_PROOF), str(ROOT / READ_OWNER_PROOF)],
            text=True, capture_output=True, timeout=60)
        (output / 'compile.log').write_text(result.stdout + result.stderr)
        if result.returncode:
            raise RuntimeError('javac failed; inspect retained compile log')
        proofs = []
        logs = []
        for proof_class in ('PublishedArtifactRegistryProof', 'PublishedArtifactTransferProof',
                            'PublishedArtifactReadOwnerProof'):
            result = subprocess.run(
                ['java', '-cp', str(output / 'classes'), 'org.nostrocket.hypergolic.host.' + proof_class],
                text=True, capture_output=True, timeout=60)
            logs.append(proof_class + ':\n' + result.stdout + result.stderr)
            if result.returncode:
                (output / 'run.log').write_text('\n'.join(logs))
                raise RuntimeError('Proof failed; inspect retained run log')
            proof = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
            if len(proof) != 1 or proof[0].get('status') != 'passed' or not isinstance(proof[0].get('assertions'), int):
                raise RuntimeError('Incomplete owning proof receipt')
            proofs.append({'name': proof_class, **proof[0]})
        (output / 'run.log').write_text('\n'.join(logs))
        if before != {path: digest(ROOT / path) for path in sources}:
            raise RuntimeError('Owning source changed during execution')
        receipt.update(status='passed', assertions=sum(proof['assertions'] for proof in proofs), proofs=proofs)
    finally:
        (output / 'result.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
