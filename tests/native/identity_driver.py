#!/usr/bin/env python3
"""Native Android public identity continuity across explicit, data-preserving restarts."""
from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
NPUB = re.compile(r'npub1[023456789acdefghjklmnpqrstuvwxyz]{58}')
LIMITATIONS = [
    'Public identity display and process-restart continuity only; no private-key usability, storage encryption, authentication, import, backup or signing proof.',
    'Explicit force-stop/relaunch preserves stored app data but discards disposable live napplet state; no app install or data reset occurs.',
    'Source snapshots and cold launches do not attest the exact JavaScript bytes served by Metro.',
    'Full-value tap is native interaction evidence, not clipboard or selection verification. Screenshots require independent visual inspection.',
    'This Android run supplies no iOS, standalone release or physical-device evidence.',
]


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_snapshot(source: Path) -> dict:
    paths = set()
    for directory in ('src', 'modules', 'runtime/src', 'runtime/fixtures', 'runtime/dist', 'assets', 'scripts', 'plugins'):
        for path in (source / directory).rglob('*'):
            relative = path.relative_to(source)
            if path.is_file() and not {'node_modules', 'build', '.gradle', '.expo', '__pycache__'}.intersection(relative.parts):
                paths.add(path)
    for name in ('package.json', 'pnpm-lock.yaml', 'app.json', 'app.config.ts', 'index.ts', 'babel.config.js',
                 'babel.config.cjs', 'metro.config.js', 'metro.config.cjs', 'runtime/package.json', 'runtime/pnpm-lock.yaml'):
        path = source / name
        if path.is_file():
            paths.add(path)
    return {str(path.relative_to(source)): sha256(path) for path in sorted(paths)}


def harness_snapshot(source: Path) -> dict:
    paths = {'identity_driver.py': HERE / 'identity_driver.py',
             'identity-encoding.mjs': HERE / 'identity-encoding.mjs',
             'source/tests/native/driver.py': source / 'tests/native/driver.py',
             'source/tests/native/receiver.py': source / 'tests/native/receiver.py'}
    for name in ('workspace_restart.py', 'identity_switch.py', 'state_storage.py', 'state_close.py', 'identity_deletion.py', 'identity_biometric.py', 'identity_backup.py', 'public-test-identity.mjs'):
        additional = HERE / name
        if additional.is_file(): paths[name] = additional
    return {name: sha256(path) for name, path in paths.items()}


def require_equal(before, after, description: str) -> None:
    if before != after:
        raise RuntimeError(description + ' changed during the native run')


def single_pid(output: str) -> str:
    if not re.fullmatch(r'[1-9][0-9]*', output):
        raise RuntimeError('Expected exactly one live app PID')
    return output


def require_retired(result) -> None:
    if result.returncode != 1 or result.stdout != '' or result.stderr != '':
        raise RuntimeError('Expected a successful pidof query reporting no app process')


def require_new_pid(before: str, after: str) -> None:
    if single_pid(before) == single_pid(after):
        raise RuntimeError('Relaunch did not produce a distinct app process')


def native_control(nodes: list[dict], identifier: str, package: str) -> dict:
    found = [node for node in nodes if node.get('resource-id', '').split('/')[-1] == identifier
             and node.get('package') == package and node.get('_webview-depth') == 0]
    if len(found) != 1:
        raise RuntimeError(identifier + ': expected one native control outside WebView')
    node = found[0]
    match = re.fullmatch(r'\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]', node.get('bounds', ''))
    if not match or node.get('enabled') != 'true':
        raise RuntimeError(identifier + ': control is unavailable')
    x1, y1, x2, y2 = map(int, match.groups())
    if x2 <= x1 or y2 <= y1:
        raise RuntimeError(identifier + ': control has no visible area')
    return node


def header_identity(nodes: list[dict], package: str) -> tuple[dict, str]:
    node = native_control(nodes, 'shell-settings', package)
    value = node.get('content-desc', '')
    if node.get('class') != 'android.widget.Button' or not value.startswith('Settings for '):
        raise RuntimeError('Native header does not expose its selected identity')
    npub = value.removeprefix('Settings for ')
    if not NPUB.fullmatch(npub):
        raise RuntimeError('Header does not expose a full canonical-shaped npub')
    return node, npub


def settings_identity(nodes: list[dict], package: str, expected: str) -> dict:
    node = native_control(nodes, 'settings-full-npub', package)
    if node.get('class') != 'android.widget.TextView' or node.get('text') != expected:
        raise RuntimeError('Settings full npub differs from the observed native header')
    return node


def validate_encoding(observations: dict, source: Path, node: str) -> dict:
    process = subprocess.run([node, str(HERE / 'identity-encoding.mjs'), str(source)],
                             input=json.dumps(observations), text=True, capture_output=True, timeout=15)
    if process.returncode != 0:
        raise RuntimeError('Owning Nostr decoder rejected the public observations: ' + process.stderr.strip())
    result = json.loads(process.stdout)
    if (result.get('passed') is not True or type(result.get('validatedCount')) is not int
            or result.get('validatedCount') != 4 or result.get('npub') != observations.get('headerBefore')):
        raise RuntimeError('Owning Nostr decoder returned an incomplete receipt')
    return result


def load_base(source: Path):
    # Load the selected checkout's actual base driver; never copy or monkey-patch it.
    native = source / 'tests/native'
    spec = importlib.util.spec_from_file_location('hypergolic_identity_base_driver', native / 'driver.py')
    if spec is None or spec.loader is None:
        raise RuntimeError('The selected source has no native base driver')
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(native))
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path.pop(0)
    if module.ROOT.resolve() != source:
        raise RuntimeError('Native base driver belongs to a different checkout')
    return module


class IdentityRestart:
    scenario = 'identity-restart'
    def __init__(self, driver):
        self.driver = driver
        self.package = driver.args.package
        self.actions = driver.result.setdefault('actions', [])

    def adb(self, *arguments, **kwargs):
        self.actions.append({'operation': 'adb', 'arguments': list(arguments)})
        return self.driver.adb_run(*arguments, **kwargs)

    def tap(self, node, name):
        self.actions.append({'operation': 'native-tap', 'control': name, 'bounds': node['bounds']})
        self.driver.tap(node)

    def header(self):
        def available(nodes):
            try:
                header_identity(nodes, self.package)
                return True
            except RuntimeError:
                return False
        _, nodes = self.driver.wait(available, 'native full identity header')
        return header_identity(nodes, self.package)

    def settings(self, index):
        header, npub = self.header()
        self.driver.capture(index + '-header')
        self.tap(header, 'shell-settings')
        _, nodes = self.driver.wait(lambda rows: any(row.get('resource-id', '').split('/')[-1] == 'settings-full-npub' for row in rows),
                                    'Settings full public identity')
        full = settings_identity(nodes, self.package, npub)
        self.tap(full, 'settings-full-npub')
        _, nodes = self.driver.nodes()
        observed_full = settings_identity(nodes, self.package, npub)['text']
        self.driver.capture(index + '-settings')
        self.driver.check('header-settings-full-npub-' + index, {'npub': npub, 'fullValueTapped': True})
        self.tap(native_control(nodes, 'settings-done', self.package), 'settings-done')
        require_equal(npub, self.header()[1], 'Identity after Settings dismissal')
        return {'header': npub, 'settings': observed_full}

    def cold_launch(self):
        self.adb('shell', 'am', 'force-stop', self.package)
        arguments = [self.driver.adb, '-s', self.driver.args.serial, 'shell', 'pidof', self.package]
        self.actions.append({'operation': 'adb-process-retirement', 'arguments': arguments})
        retired = subprocess.run(arguments, text=True, capture_output=True, timeout=15)
        require_retired(retired)
        response = self.adb('shell', 'am', 'start', '-W', '-n', self.package + '/' + (getattr(self.driver.args, 'activity', None) or '.MainActivity'))
        if re.findall(r'^Status: (.+)$', response, re.MULTILINE) != ['ok']:
            raise RuntimeError('Native Activity Manager did not report a successful launch')
        return {'processRetirement': {'exitCode': retired.returncode, 'stdout': retired.stdout,
                                      'stderr': retired.stderr}, 'launchResponse': response}

    def run(self):
        self.driver.result['firstLaunch'] = self.cold_launch()
        first = self.settings('01')
        first_pid = single_pid(self.adb('shell', 'pidof', self.package))
        self.driver.result['secondLaunch'] = self.cold_launch()
        second = self.settings('02')
        second_pid = single_pid(self.adb('shell', 'pidof', self.package))
        require_new_pid(first_pid, second_pid)
        require_equal(first, second, 'Public identity after process restart')
        observations = {'headerBefore': first['header'], 'settingsBefore': first['settings'],
                        'headerAfter': second['header'], 'settingsAfter': second['settings']}
        self.driver.result['identityObservations'] = observations
        self.driver.result['canonicalNpubValidation'] = validate_encoding(observations, self.driver.args.source, self.driver.args.node)
        self.driver.check('same-identity-after-process-restart', {'firstPid': first_pid, 'secondPid': second_pid,
                          'stoppedPidOutput': '', 'sameFourFullValues': True})
        self.driver.result['finalPid'] = second_pid


def main(argv=None, scenario_type=None):
    scenario_type = scenario_type or IdentityRestart
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--package', default='org.nostrocket.hypergolic.dev')
    parser.add_argument('--activity', help='Verified fully qualified launch Activity; defaults to the package MainActivity')
    parser.add_argument('--adb', help='Explicit ADB executable; defaults to PATH or the checkout local tools')
    parser.add_argument('--node', default=shutil.which('node'), help='Node executable for the checkout-owned Nostr decoder')
    parser.add_argument('--timeout', type=float, default=90)
    parser.add_argument('--expected-apk-sha256', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('scenario', choices=(scenario_type.scenario,))
    args = parser.parse_args(argv)
    if not re.fullmatch(r'[a-f0-9]{64}', args.expected_apk_sha256):
        parser.error('An exact expected installed APK SHA-256 is required')
    if not re.fullmatch(r'[A-Za-z0-9_.-]+', args.serial) or not re.fullmatch(r'[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+', args.package):
        parser.error('Explicit device serial and package required')
    if args.activity is not None and not re.fullmatch(r'[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+', args.activity):
        parser.error('A fully qualified Activity is required')
    if args.node is None or not 1 <= args.timeout <= 120:
        parser.error('Node and a timeout from 1 to 120 seconds are required')
    args.source = args.source.resolve()
    args.output = args.output.expanduser().resolve()
    if args.output.exists():
        parser.error('Evidence output must be a new directory')
    args.launch = False
    active = None
    exit_code = 1
    try:
        base = load_base(args.source)
        active = base.Driver(args)
        active.result['limitations'] = LIMITATIONS
        active.result['sourceBefore'] = source_snapshot(args.source)
        active.result['harnessBefore'] = harness_snapshot(args.source)
        active.metadata()
        active.result['appBefore'] = copy.deepcopy(active.result['app'])
        require_equal(args.expected_apk_sha256, active.result['appBefore']['installedBaseApkSha256'], 'Expected installed APK')
        scenario_type(active).run()
        active.metadata()
        active.result['appAfter'] = copy.deepcopy(active.result['app'])
        require_equal(active.result['appBefore']['installedBaseApkSha256'], active.result['appAfter']['installedBaseApkSha256'], 'Installed APK')
        require_equal(active.result['finalPid'], single_pid(active.adb_run('shell', 'pidof', args.package)), 'Final app process')
        active.result['status'] = 'passed'
        exit_code = 0
    except Exception as error:
        if active:
            active.result['status'] = 'failed'
            active.result['error'] = str(error)
            try:
                active.capture('failure')
            except Exception as capture_error:
                active.result['captureError'] = str(capture_error)
        else:
            print('FAILED: ' + str(error), file=sys.stderr)
    finally:
        if active:
            try:
                active.result['sourceAfter'] = source_snapshot(args.source)
                active.result['harnessAfter'] = harness_snapshot(args.source)
                require_equal(active.result['sourceBefore'], active.result['sourceAfter'], 'Application source')
                require_equal(active.result['harnessBefore'], active.result['harnessAfter'], 'Native harness')
            except Exception as error:
                active.result['status'] = 'failed'
                active.result['snapshotError'] = str(error)
                exit_code = 1
            active.result['finishedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
            (active.out / 'result.json').write_text(json.dumps(active.result, indent=2) + '\n')
            print(json.dumps({'status': active.result['status'], 'result': str(active.out / 'result.json'), 'error': active.result.get('error')}))
    return exit_code


if __name__ == '__main__':
    sys.exit(main())
