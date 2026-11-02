#!/usr/bin/env python3
"""Compile the owning native approval core directly and retain a sealed JVM receipt."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[3]
SOURCE = 'modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host/NativeApprovalAuthority.java'
TRANSPORT_SOURCES = [
    'modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host/NativeSigningHold.java',
    'modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host/ApprovalLeaseRegistry.java',
    'modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host/CapabilityLeaseRegistry.java',
]
PROOF = 'tests/native/android-approval-authority/AuthorityProof.java'
TRANSPORT_PROOF = 'tests/native/android-approval-authority/TransportProof.java'


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
    sources = [SOURCE, *TRANSPORT_SOURCES, PROOF, TRANSPORT_PROOF, str(Path(__file__).resolve().relative_to(ROOT))]
    before = {path: digest(ROOT / path) for path in sources}
    receipt = {'status': 'failed', 'sourceSha256': before,
               'scope': 'Owning native JVM approval lifetime with explicit clock double; no bridge, signer, network or device proof.'}
    try:
        commands = [
            ['javac', '-Xlint:all', '-Werror', '-d', str(output / 'classes'),
             *(str(ROOT / path) for path in [SOURCE, *TRANSPORT_SOURCES, PROOF, TRANSPORT_PROOF])],
            ['sh', '-c', 'java -cp "$1" org.nostrocket.hypergolic.host.AuthorityProof && java -cp "$1" org.nostrocket.hypergolic.host.TransportProof', 'runner', str(output / 'classes')],
        ]
        for name, command in zip(['compile', 'run'], commands):
            result = subprocess.run(command, text=True, capture_output=True, timeout=60)
            (output / (name + '.log')).write_text(result.stdout + result.stderr)
            if result.returncode:
                raise RuntimeError(name + ' failed; inspect retained log')
        proof_lines = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
        if len(proof_lines) != 2 or any(proof.get('status') != 'passed' or not isinstance(proof.get('assertions'), int) or proof['assertions'] < 1 for proof in proof_lines):
            raise RuntimeError('Incomplete owning proof')
        if before != {path: digest(ROOT / path) for path in sources}:
            raise RuntimeError('Owning source changed during execution')
        receipt.update(status='passed', assertions=sum(proof['assertions'] for proof in proof_lines), proofs=proof_lines)
    finally:
        (output / 'result.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
