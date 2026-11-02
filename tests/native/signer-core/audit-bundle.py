#!/usr/bin/env python3
"""Check an actual Metro export's composition and match its source to this checkout."""
import argparse
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[3]
RETIRED = {
    'src/security/identity-vault.ts',
    'src/security/identity-crypto.ts',
    'src/security/android-encrypted-secrets.ts',
    'src/security/ios-encrypted-secrets.ts',
    'src/security/identity-store-native.ts',
    'src/security/identity-actions-native.ts',
}
REQUIRED = {
    'src/security/native-identity-vault.ts',
    'src/security/native-identity-actions.ts',
    'src/security/trusted-identity-owner.ts',
    'src/security/identity-transition.ts',
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def audit(source_map):
    encoded = source_map.read_bytes()
    value = json.loads(encoded)
    sources, content = value['sources'], value['sourcesContent']
    if value.get('version') != 3 or len(sources) != len(content):
        raise ValueError('Invalid Metro source map')
    bundled = {}
    for name, text in zip(sources, content):
        if not isinstance(name, str):
            raise ValueError('Invalid source name')
        # Metro exports project paths from its virtual root.
        if not name.startswith('/src/'):
            continue
        relative = name[1:]
        path = (ROOT / relative).resolve()
        if not path.is_relative_to(ROOT / 'src') or relative in bundled:
            raise ValueError('Ambiguous project source: ' + relative)
        if not isinstance(text, str) or not path.is_file():
            raise ValueError('Missing project source: ' + relative)
        data = text.encode('utf-8')
        if path.read_bytes() != data:
            raise ValueError('Export contains stale project source: ' + relative)
        bundled[relative] = digest(data)
    if RETIRED & bundled.keys():
        raise ValueError('Retired key-handling source is bundled: ' + ', '.join(sorted(RETIRED & bundled.keys())))
    if not REQUIRED <= bundled.keys():
        raise ValueError('Native vault composition is missing: ' + ', '.join(sorted(REQUIRED - bundled.keys())))
    bundle = source_map.with_suffix('')
    if not bundle.is_file() or bundle.stat().st_size == 0:
        raise ValueError('Matching exported bundle is missing')
    return {
        'scope': 'Production Metro composition; not native bridge or physical protection proof',
        'bundle': bundle.name,
        'bundleSha256': digest(bundle.read_bytes()),
        'sourceMapSha256': digest(encoded),
        'totalSources': len(sources),
        'currentProjectSources': len(bundled),
        'retiredModulesAbsent': sorted(RETIRED),
        'projectSourceSha256': dict(sorted(bundled.items())),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-map', type=Path, required=True)
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    if args.receipt.exists():
        parser.error('Receipt already exists; choose a fresh output path')
    try:
        result = audit(args.source_map.resolve())
        args.receipt.parent.mkdir(parents=True, exist_ok=True)
        with args.receipt.open('x') as output:
            output.write(json.dumps(result, indent=2) + '\n')
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(str(error), file=sys.stderr)
        return 1
    print(json.dumps({'currentProjectSources': result['currentProjectSources'],
        'retiredModulesAbsent': len(result['retiredModulesAbsent']), 'bundleSha256': result['bundleSha256']}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
