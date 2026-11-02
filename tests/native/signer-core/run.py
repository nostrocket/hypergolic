#!/usr/bin/env python3
"""Compose owning native fixture suites; missing inputs, cases or receipts fail."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile

BASE = Path(__file__).resolve().parent


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def cases(args):
    selected = ['core', 'migration', 'nip46', 'nip55'] if args.suite == 'all' else [args.suite]
    rows = []
    for suite in selected:
        if suite == 'nip55' and args.platform == 'ios':
            rows.append({'suite': suite, 'name': suite, 'applicable': False,
                         'status': 'not-applicable' if args.suite == 'all' else 'unsupported',
                         'reason': 'NIP-55 is Android-only'})
            continue
        paths = {
            'core': args.platform + '/run.py',
            'migration': 'ios/run-persistence.py' if args.platform == 'ios' else 'android/migration.py',
            'nip46': 'ios/run-nip46.py' if args.platform == 'ios' else 'nip46/android/run.py',
        }
        drivers = [('nip55-validators', 'android/migration.py', ['--validator-only'], 'result.json', ['assertions']),
                   ('nip55-controller', 'nip55/android/run-controller.py', [], 'receipt.json', ['nativeAssertions', 'independentAssertions'])] if suite == 'nip55' else [
                       (suite, paths[suite], [], 'receipt.json' if args.platform == 'ios' else 'result.json',
                        ['cases', 'assertions'] if args.platform == 'ios' else ['assertions', 'independentAssertions'])]
        for name, driver, extra, receipt, metrics in drivers:
            rows.append({'suite': suite, 'name': name, 'applicable': True,
                         'driver': driver, 'extra': extra, 'receipt': receipt,
                         'metrics': metrics, 'status': 'not-run'})
    return rows


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--platform', choices=['android', 'ios'], required=True)
    parser.add_argument('--suite', choices=['core', 'migration', 'nip46', 'nip55', 'all'], required=True)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--udid', help='Explicit booted iOS Simulator for installed native checks')
    parser.add_argument('--serial', help='Explicit Android emulator for installed native checks')
    parser.add_argument('--provider', type=Path, help='Reviewed disposable provider build directory for Android nip55/all')
    arguments = sys.argv[1:] if argv is None else argv
    if arguments[:1] == ['--']:
        arguments = arguments[1:]
    args = parser.parse_args(arguments)
    if args.udid and args.platform != 'ios':
        parser.error('--udid applies only to iOS')
    if args.serial and args.platform != 'android':
        parser.error('--serial applies only to Android')
    if args.serial and not re.fullmatch(r'emulator-[0-9]+', args.serial):
        parser.error('--serial must name a disposable Android emulator')
    if args.provider and (args.platform != 'android' or args.suite not in ('nip55', 'all')):
        parser.error('--provider applies only to Android nip55/all')
    out = args.output.resolve() if args.output else Path(tempfile.mkdtemp(prefix='hypergolic-signer-')) / args.suite
    if out.exists():
        parser.error('Output already exists; choose a fresh evidence directory')
    out.mkdir(parents=True, mode=0o700)
    rows = cases(args)
    report = {'passed': False, 'platform': args.platform, 'suite': args.suite, 'cases': rows,
              'scope': 'Defined native fixture suite composition only; full ordinary-app, physical, interoperability, route and Phase 3 acceptance remain separate.'}
    try:
        # Preflight the whole selection before starting any child/device/peer.
        for row in rows:
            if not row['applicable']:
                continue
            reason = None
            if not (BASE / row['driver']).is_file():
                reason = 'Owning driver is unavailable'
            elif not (args.serial if args.platform == 'android' else args.udid):
                reason = 'Explicit emulator serial or Simulator UDID is required'
            elif row['name'] == 'nip55-controller' and (args.provider is None or
                    not all((args.provider / name).is_file() for name in ['build.json', 'provider.apk'])):
                reason = 'Reviewed provider build.json and provider.apk are required'
            if reason:
                row.update(status='blocked', reason=reason)
        if not any(row['status'] in ('blocked', 'unsupported') for row in rows):
            for row in rows:
                if not row['applicable']:
                    continue
                driver = BASE / row['driver']
                child = out / row['name']
                row['driverSha256'] = digest(driver)
                command = [sys.executable, str(driver), '--output', str(child), *row['extra']]
                command += ['--serial', args.serial] if args.platform == 'android' else ['--udid', args.udid]
                if row['name'] == 'nip55-controller':
                    command += ['--provider', str(args.provider.resolve())]
                row['command'] = command
                row['status'] = 'failed'
                with (out / (row['name'] + '.log')).open('wb') as log:
                    result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=False)
                row['exitCode'] = result.returncode
                if result.returncode != 0:
                    row['reason'] = 'Owning driver failed; reconcile its effects before another run'
                    break
                receipt = child / row['receipt']
                value = json.loads(receipt.read_text())
                row['receiptSha256'] = digest(receipt)
                success = ('passed' in value or 'status' in value) and (
                    'passed' not in value or value['passed'] is True) and (
                    'status' not in value or value['status'] == 'passed')
                counts = {key: value.get(key) for key in row['metrics']}
                if (not success or any(type(n) is not int or n <= 0 for n in counts.values()) or
                        (row['name'] == 'nip55-controller' and
                         (type(value.get('cases')) is not list or not value['cases'])) or
                        digest(driver) != row['driverSha256']):
                    row['reason'] = 'Missing/nonpassing receipt, zero relevant count or driver drift'
                    break
                row.update(status='passed', counts=counts)
    except BaseException as error:
        report['errorClass'] = type(error).__name__
    finally:
        for row in rows:
            if row['status'] == 'not-run':
                row['reason'] = 'Selection preflight incomplete or earlier child failed; not dispatched'
        required = [row for row in rows if row['applicable']]
        report['counts'] = {status: sum(row['status'] == status for row in rows) for status in
                            ['passed', 'failed', 'blocked', 'not-run', 'unsupported', 'not-applicable']}
        report['requiredCases'] = len(required)
        report['passed'] = bool(required) and all(row['status'] == 'passed' for row in required) and not report.get('errorClass')
        (out / 'receipt.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps({'passed': report['passed'], 'requiredCases': report['requiredCases'],
                          'counts': report['counts'], 'receipt': str(out / 'receipt.json')}))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
