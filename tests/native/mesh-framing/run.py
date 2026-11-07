#!/usr/bin/env python3
"""Compile actual Mesh framing and pairing encoding; no network, keys or devices."""
from pathlib import Path
import argparse, hashlib, json, struct, subprocess

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--out', type=Path, required=True)
    args = p.parse_args()
    root = Path(__file__).resolve().parents[3]
    out = args.out.resolve()
    if out.exists():
        raise SystemExit('Use a new output directory to preserve earlier results.')
    out.mkdir(parents=True)
    shared = root / 'modules/mesh-core/shared'
    sources = [shared/f'hypergolic_mesh_{name}.{suffix}'
               for name in ['frame', 'pairing'] for suffix in ['c', 'h']]
    sources += [Path(__file__).with_name(f'{name}_test.c') for name in ['frame', 'pairing']]
    receipt = {'sourceHashes': {str(s.relative_to(root)): hashlib.sha256(s.read_bytes()).hexdigest() for s in sources},
               'scope': 'Host ASan/UBSan actual plaintext framing and pairing encoding; no TLS, authorization, signing, native platform or device acceptance.',
               'commands': [], 'results': {}, 'status': 'started'}
    try:
        for name in ['frame', 'pairing']:
            command = ['clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-pedantic',
                       '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-O1', '-g',
                       '-I', str(shared), str(shared/f'hypergolic_mesh_{name}.c'),
                       str(Path(__file__).with_name(f'{name}_test.c')), '-o', str(out/f'{name}-test')]
            receipt['commands'].append(command)
            compile_result = subprocess.run(command, capture_output=True, text=True)
            (out/f'{name}-compile.log').write_text(compile_result.stdout+compile_result.stderr)
            compile_result.check_returncode()
            result = subprocess.run([str(out/f'{name}-test')], capture_output=True, text=True)
            (out/f'{name}-test.log').write_text(result.stdout+result.stderr)
            result.check_returncode()
            parsed = json.loads(result.stdout)
            if name == 'pairing':
                expected = (b'hypergolic.mesh.pairing.v1\0' + b'\x01' + bytes(range(1, 17)) +
                            b''.join(bytes(range(1+f*32, 33+f*32)) for f in range(7)) +
                            struct.pack('>Q', 1794090000))
                assert len(expected) == 276 and parsed.pop('vector') == expected.hex()
                parsed.update(independentPythonVector=True, transcriptBytes=len(expected),
                              transcriptSha256=hashlib.sha256(expected).hexdigest())
            receipt['results'][name] = parsed
        receipt['status'] = 'passed'
    except BaseException as error:
        receipt.update(status='failed', error=str(error))
        raise
    finally:
        (out/'receipt.json').write_text(json.dumps(receipt, indent=2)+'\n')
    print(json.dumps(receipt))

if __name__ == '__main__':
    main()
