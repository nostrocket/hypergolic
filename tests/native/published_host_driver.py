#!/usr/bin/env python3
"""Exercise the signed embedded published-artifact QA route on an existing Android install."""
from __future__ import annotations
import argparse
import hashlib
from pathlib import Path
import re
import sys
import time
import driver as base
from driver import CheckFailed, exactly_one, label

HERE = Path(__file__).resolve().parent
FIXTURE = {
    'publisher': 'cb9e62b0a9bdb390be102d17ecd9f1c652824723229577066d938d5cbee4a6e3',
    'app': 'hypergolic-qa-embedded',
    'event': 'abc35c0b0d09e6934d94321f66fd309b62a2d92031d5501cbbdf175bddf049f6',
    'access': 'Theme only',
}


def resource_id_is(node, identifier):
    value = node.get('resource-id', '')
    return value == identifier or value.endswith('/' + identifier)


def verify_review(nodes):
    """Require the exact public signed metadata and an explicit Open action."""
    if not any(resource_id_is(node, 'published-lab-publisher') for node in nodes):
        raise CheckFailed('Published fixture review fields are not visible')
    for field, value in FIXTURE.items():
        if not any(value == label(node) for node in nodes):
            raise CheckFailed('Signed fixture review did not show expected ' + field)
    open_button = exactly_one(nodes, lambda node: resource_id_is(node, 'published-lab-open'),
                              'explicit Open signed test button')
    return open_button


class PublishedHostDriver(base.Driver):
    def __init__(self, args):
        base.ROOT = Path(args.source).resolve()
        super().__init__(args)
        self.result['scope'] = 'Actual Android native Settings-to-signed-embedded-host QA route; no publishing or signing key'
        self.result['fixture'] = FIXTURE.copy()

    def check(self, name, details):
        super().check(name, details)
        print('PASS ' + name, flush=True)

    def source_hashes(self):
        paths = (
            'src/napplets/embedded-test-fixture.ts', 'src/napplets/verified-artifact.ts',
            'src/napplets/native-transfer.ts', 'src/shell/PublishedHostLab.tsx',
            'src/shell/IdentitySettings.tsx', 'modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host/NappletHostView.kt',
            'runtime/dist/index.html', 'runtime/dist/host.js',
        )
        return {name: hashlib.sha256((base.ROOT / name).read_bytes()).hexdigest()
                for name in paths if (base.ROOT / name).is_file()}

    def tap_test_id(self, suffix, description):
        _, nodes = self.nodes()
        return self.tap(exactly_one(nodes, lambda node: resource_id_is(node, suffix), description))

    def scroll_until(self, predicate, description):
        for _ in range(12):
            _, nodes = self.nodes()
            if any(predicate(node) for node in nodes):
                return nodes
            scrollables = [node for node in nodes if node.get('scrollable') == 'true']
            if not scrollables:
                raise CheckFailed('No observed scrollable Settings container while looking for ' + description)
            node = scrollables[-1]
            x1, y1, x2, y2 = base.node_bounds(node)
            self.adb_run('shell', 'input', 'swipe', str((x1+x2)//2), str(y1+(y2-y1)*4//5),
                         str((x1+x2)//2), str(y1+(y2-y1)//3), '350')
        raise CheckFailed(description + ' was not reached by native Settings scrolling')

    def run_scenario(self):
        self.metadata()
        if not self.args.expected_apk_sha256:
            raise CheckFailed('Exact installed APK SHA-256 is required')
        if self.result['app']['installedBaseApkSha256'] != self.args.expected_apk_sha256:
            raise CheckFailed('Installed APK differs from explicit native-build handoff hash')
        self.result['sourceBefore'] = self.source_hashes()
        if self.args.launch:
            launch = self.adb_run('shell', 'am', 'start', '-W', '-n', self.args.package + '/.MainActivity')
            if 'Status: ok' not in launch:
                raise CheckFailed('Android did not report successful app launch')
        _, initial_nodes = self.wait(lambda nodes: bool(nodes), 'initial app screen')
        if not any(label(node) == 'Settings' for node in initial_nodes):
            self.wait(lambda nodes: any(resource_id_is(node, 'shell-settings') for node in nodes),
                      'shell settings avatar')
            self.tap_test_id('shell-settings', 'shell settings avatar')
            self.wait(lambda nodes: any(label(node) == 'Settings' for node in nodes), 'Settings screen')
        self.capture('01-settings')
        self.scroll_until(lambda node: resource_id_is(node, 'settings-inspect-signed-test'),
                          'signed fixture action')
        self.tap_test_id('settings-inspect-signed-test', 'Inspect signed test napplet')
        _, nodes = self.wait(lambda observed: any(label(node) == 'Signed test napplet' for node in observed),
                             'signed test review')
        open_button = verify_review(nodes)
        self.check('signed-fixture-review', {'publisher': FIXTURE['publisher'], 'app': FIXTURE['app'],
                   'event': FIXTURE['event'], 'access': FIXTURE['access'],
                   'explicitOpenRequired': True})
        self.capture('02-review')
        self.tap(open_button)
        _, nodes = self.wait(lambda observed: any(label(node) == 'Signed test napplet connected' for node in observed),
                             'native published host ready')
        self.check('native-published-host-connected', 'Native host reported readiness for the reviewed signed fixture')
        self.capture('03-connected')
        fixture_text = any('fixture-loaded' in label(node) for node in nodes)
        self.result['fixtureTextInAccessibilityHierarchy'] = fixture_text
        if fixture_text:
            self.check('fixture-loaded-visible', 'Actual Android accessibility hierarchy contains fixture-loaded')
        else:
            self.result['limitations'].append('Android accessibility hierarchy did not expose fixture-loaded; connected state and screenshot are recorded, but visible page text needs manual screenshot review.')
        self.tap_test_id('published-lab-close', 'Close test')
        _, nodes = self.wait(lambda observed: any(label(node) == 'Settings' for node in observed),
                             'return to Settings after closing signed test')
        if any(resource_id_is(node, 'published-lab-host') for node in nodes):
            raise CheckFailed('Native host view remained after Close test')
        if any(label(node) == 'Signed test napplet connected' for node in nodes):
            raise CheckFailed('Connected signed test status remained after Close test')
        self.check('close-revokes-host-view', 'Close returned to Settings and removed the published host view')
        self.capture('04-closed')
        self.result['sourceAfter'] = self.source_hashes()
        if self.result['sourceAfter'] != self.result['sourceBefore']:
            raise CheckFailed('Application source changed during native evidence run')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--package', default='org.nostrocket.hypergolic.dev')
    parser.add_argument('--adb')
    parser.add_argument('--timeout', type=float, default=30)
    parser.add_argument('--expected-apk-sha256', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--launch', action='store_true', help='Launch existing app; never reinstalls or clears data')
    args = parser.parse_args()
    args.scenario = 'published-host'
    args.cold_launch = False
    if not re.fullmatch('[a-f0-9]{64}', args.expected_apk_sha256):
        parser.error('Exact installed APK SHA-256 required')
    if not re.fullmatch('[A-Za-z0-9_.]+', args.package):
        parser.error('Invalid package')
    active = None
    exit_code = 1
    try:
        active = PublishedHostDriver(args)
        active.run_scenario()
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
        print('FAILED: ' + str(error), file=sys.stderr)
    finally:
        if active:
            active.save()
            print({'status': active.result['status'], 'result': str(active.out / 'result.json')})
    return exit_code


if __name__ == '__main__':
    sys.exit(main())
