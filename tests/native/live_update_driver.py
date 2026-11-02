#!/usr/bin/env python3
"""Exercise a signed public relay/Blossom update on the isolated Android app."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import time

import driver as base
import published_update_driver as embedded
from driver import CheckFailed, exactly_one, label

PACKAGE = 'org.nostrocket.hypergolic.livepublishedfixture'
SOURCE_PATHS = (
    'tests/native/live-published-fixture/index.tsx',
    'tests/native/live-update-publication/cli.mjs',
    'tests/native/live-update-publication/release-pair.mjs',
    'tests/native/live-update-publication/network.mjs',
    'tests/native/live_update_driver.py',
    'tests/native/published_update_driver.py',
    'tests/native/driver.py',
    'src/napplets/loader.ts',
    'src/napplets/verified-artifact.ts',
    'src/napplets/published-source.ts',
    'src/napplets/native-published-source-port.ts',
    'src/napplets/first-open-consent.ts',
    'src/runtime/runtime-owner.ts',
    'src/shell/IdentityShell.tsx',
    'src/shell/IdentitySettings.tsx',
    'src/shell/OpenPublishedNapplet.tsx',
    'src/shell/UpdatePublishedNapplet.tsx',
    'modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host/NappletHostView.kt',
)


def source_hashes(root):
    result = {}
    for name in SOURCE_PATHS:
        path = root / name
        if not path.is_file():
            raise CheckFailed('Frozen source file is missing: ' + name)
        result[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def source_digest(hashes):
    return embedded.source_digest(hashes)


class LiveUpdateDriver(embedded.PublishedUpdateDriver):
    def __init__(self, args):
        base.ROOT = Path(args.source).resolve()
        base.Driver.__init__(self, args)
        self.result['scope'] = ('Actual Android public-only relay/Blossom v1 to v2 update through '
                                'native Settings, exact review, and published workspace replacement')
        self.apk = Path(args.apk).resolve()
        if not self.apk.is_file():
            raise CheckFailed('Explicit fixture APK is missing')
        self.apk_sha256 = hashlib.sha256(self.apk.read_bytes()).hexdigest()
        self.result['apk'] = {'path': str(self.apk), 'sha256': self.apk_sha256}
        bundle_path = Path(args.bundle).resolve()
        inspect = subprocess.run(['node', str(base.ROOT / 'tests/native/live-update-publication/cli.mjs'),
                                  'inspect', '--bundle', str(bundle_path)], cwd=base.ROOT,
                                 capture_output=True, text=True, timeout=20, check=False)
        if inspect.returncode:
            raise CheckFailed('Signed QA handoff validation failed: ' + inspect.stderr[:250])
        self.fixture = json.loads(inspect.stdout)
        if self.fixture.get('action') != 'inspected' or self.fixture.get('relays') != ['wss://relay.damus.io']:
            raise CheckFailed('QA bundle is not bound to the configured app lookup relay')
        self.result['fixture'] = self.fixture
        self.bundle_path = bundle_path

    def source_snapshot(self):
        hashes = source_hashes(base.ROOT)
        return {'files': hashes, 'sha256': source_digest(hashes)}

    def check_review(self, nodes, update):
        expected = ((self.fixture['publisher'], 'publisher'), (self.fixture['identifier'], 'napplet'),
                    (self.fixture['v1'], 'current event'), (self.fixture['v2'], 'new event')) if update else (
                    (self.fixture['publisher'], 'publisher'), (self.fixture['identifier'], 'napplet'),
                    (self.fixture['v1'], 'signed event'))
        for value, field in expected:
            if not any(label(node) == value for node in nodes):
                raise CheckFailed('Live review did not show exact ' + field)
        if not any(label(node) == 'Requested access: theme' for node in nodes):
            raise CheckFailed('Live review did not show exact theme access')
        if update:
            identifiers = [embedded.resource_id_suffix(node) for node in nodes if re.fullmatch(
                r'published-update-review-' + embedded.UUID.pattern, embedded.resource_id_suffix(node))]
            if len(identifiers) != 1:
                raise CheckFailed('Expected one session-bound live update review')
            return identifiers[0].removeprefix('published-update-review-')
        return exactly_one(nodes, lambda node: embedded.resource_id_is(node, 'settings-napplet-approve'),
                           'explicit first-open approval')

    def publish_v2(self):
        command = ['node', str(base.ROOT / 'tests/native/live-update-publication/cli.mjs'),
                   'publish', '--bundle', str(self.bundle_path), '--revision', 'v2']
        result = subprocess.run(command, cwd=base.ROOT, capture_output=True, text=True,
                                timeout=75, check=False)
        if result.returncode:
            raise CheckFailed('Live v2 relay publication failed: ' + result.stderr[:400])
        receipt = json.loads(result.stdout)
        if receipt.get('eventId') != self.fixture['v2'] or not any(
                row.get('relay') == 'wss://relay.damus.io' for row in receipt.get('accepted', [])):
            raise CheckFailed('Live v2 publication was not acknowledged by the app lookup relay')
        self.result['v2Publication'] = receipt
        self.check('live-v2-published', {'event': receipt['eventId'], 'relay': 'wss://relay.damus.io'})

    def run_scenario(self):
        if self.args.package != PACKAGE or not re.fullmatch(r'[a-f0-9]{64}', self.args.expected_source_sha256):
            raise CheckFailed('The isolated package and exact source handoff are required')
        if self.args.reset_fixture:
            self.adb_run('shell', 'pm', 'clear', PACKAGE)
            self.result['fixtureDataReset'] = True
        self.metadata()
        if self.result['app']['installedBaseApkSha256'] != self.apk_sha256:
            raise CheckFailed('Installed app differs from the explicit fixture APK')
        self.result['sourceBefore'] = self.source_snapshot()
        if self.result['sourceBefore']['sha256'] != self.args.expected_source_sha256:
            raise CheckFailed('Source differs from the frozen handoff')
        launched = self.adb_run('shell', 'am', 'start', '-W', '-n',
                                PACKAGE + '/org.nostrocket.hypergolic.dev.MainActivity')
        if 'Status: ok' not in launched:
            raise CheckFailed('Fixture app did not launch')
        _, nodes = self.wait(lambda observed: any(embedded.resource_id_is(node, 'live-fixture-label')
                                                  for node in observed), 'public-only live fixture banner')
        if not any('public identity' in label(node) for node in nodes):
            raise CheckFailed('Public-only fixture banner absent')
        self.capture('01-public-fixture')
        nodes = self.open_settings()
        identity_nodes = [node for node in nodes if embedded.resource_id_is(node, 'settings-full-npub')]
        if len(identity_nodes) != 1 or not label(identity_nodes[0]).startswith('npub1'):
            raise CheckFailed('Public fixture selected npub missing')
        self.result['identityNpub'] = label(identity_nodes[0])
        self.scroll_until(lambda node: embedded.resource_id_is(node, 'settings-napplet-address'),
                          'trusted naddr field')
        self.tap_id('settings-napplet-address', 'trusted naddr field')
        self.adb_run('shell', 'input', 'text', self.fixture['naddr'])
        self.adb_run('shell', 'input', 'keyevent', '4')
        self.scroll_until(lambda node: embedded.resource_id_is(node, 'settings-open-napplet'),
                          'verify and open action')
        self.tap_id('settings-open-napplet', 'verify and open live QA napplet')
        _, nodes = self.wait(lambda observed: any(embedded.resource_id_is(node, 'settings-napplet-review')
                                                  for node in observed), 'live v1 first-open review', timeout=150)
        approve = self.check_review(nodes, update=False)
        self.check('live-first-open-review', {'publisher': self.fixture['publisher'],
                   'event': self.fixture['v1'], 'access': 'theme'})
        self.capture('02-first-open-review')
        self.tap(approve)
        _, nodes = self.wait(lambda observed: embedded.guest_marker(observed, 'update-v1') and any(
            label(node) == 'Runtime connected' for node in observed), 'live v1 guest connected', timeout=90)
        if embedded.guest_marker(nodes, 'update-v2'):
            raise CheckFailed('v2 was visible before publication')
        self.check('live-v1-connected', 'Native guest rendered v1 from relay and Blossom bytes')
        self.capture('03-live-v1')
        self.publish_v2()
        self.open_settings()
        nodes = self.scroll_until(lambda node: embedded.resource_id_suffix(node).startswith('published-update-check-'),
                                  'live update check')
        self.tap(embedded.find_update_control(nodes, 'published-update-check-'))
        _, nodes = self.wait(lambda observed: any(embedded.resource_id_suffix(node).startswith('published-update-review-')
                                                  for node in observed), 'live v2 update review', timeout=150)
        nodes = self.scroll_until(lambda node: label(node) == self.fixture['v1'], 'visible old signed event')
        session = self.check_review(nodes, update=True)
        self.result['sessionId'] = session
        self.check('live-update-review', {'oldEvent': self.fixture['v1'], 'newEvent': self.fixture['v2'],
                   'publisher': self.fixture['publisher'], 'access': 'theme'})
        self.capture('04-live-update-review')
        nodes = self.scroll_until(lambda node: embedded.resource_id_suffix(node) == 'published-update-cancel-' + session,
                                  'decline live update')
        self.tap(exactly_one(nodes, lambda node: embedded.resource_id_suffix(node) ==
                             'published-update-cancel-' + session, 'decline live update'))
        self.tap_id('settings-done', 'close Settings after declining')
        _, nodes = self.wait(lambda observed: embedded.guest_marker(observed, 'update-v1') and any(
            label(node) == 'Runtime connected' for node in observed),
                             'old live guest connected after declined update')
        if embedded.guest_marker(nodes, 'update-v2'):
            raise CheckFailed('Declining live update changed the guest')
        self.check('live-decline-retains-v1', 'Old signed guest stays connected after decline')
        self.capture('05-declined-v1')
        self.open_settings()
        nodes = self.scroll_until(lambda node: embedded.resource_id_suffix(node).startswith('published-update-check-'),
                                  'check live update again')
        self.tap(embedded.find_update_control(nodes, 'published-update-check-'))
        _, nodes = self.wait(lambda observed: any(embedded.resource_id_suffix(node).startswith('published-update-review-')
                                                  for node in observed), 'second live update review', timeout=150)
        nodes = self.scroll_until(lambda node: label(node) == self.fixture['v1'], 'visible old event again')
        if self.check_review(nodes, update=True) != session:
            raise CheckFailed('Session changed after declining the live update')
        nodes = self.scroll_until(lambda node: embedded.resource_id_suffix(node) == 'published-update-accept-' + session,
                                  'accept live update')
        self.tap(exactly_one(nodes, lambda node: embedded.resource_id_suffix(node) ==
                             'published-update-accept-' + session, 'accept live update'))
        _, nodes = self.wait(lambda observed: embedded.guest_marker(observed, 'update-v2') and any(
            label(node) == 'Runtime connected' for node in observed), 'live v2 guest connected', timeout=90)
        if embedded.guest_marker(nodes, 'update-v1'):
            raise CheckFailed('Old guest remained after accepted live update')
        self.check('live-accept-renders-v2', 'New signed guest replaced the native host after explicit approval')
        self.capture('06-live-v2')
        self.adb_run('shell', 'am', 'force-stop', PACKAGE)
        launched = self.adb_run('shell', 'am', 'start', '-W', '-n',
                                PACKAGE + '/org.nostrocket.hypergolic.dev.MainActivity')
        if 'Status: ok' not in launched or 'LaunchState: COLD' not in launched:
            raise CheckFailed('Expected a cold relaunch after accepting v2')
        _, nodes = self.wait(lambda observed: embedded.guest_marker(observed, 'update-v2') and any(
            label(node) == 'Runtime connected' for node in observed), 'pinned live v2 after cold restart', timeout=90)
        if embedded.guest_marker(nodes, 'update-v1'):
            raise CheckFailed('Old v1 guest returned after cold restart')
        self.check('live-cold-restart-retains-v2', 'Exact accepted v2 event restored after process death')
        self.capture('07-restarted-v2')
        self.result['sourceAfter'] = self.source_snapshot()
        if self.result['sourceAfter'] != self.result['sourceBefore']:
            raise CheckFailed('Frozen source changed during live native evidence')
        self.check('source-freeze-preserved', self.result['sourceBefore']['sha256'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--package', default=PACKAGE)
    parser.add_argument('--apk', required=True)
    parser.add_argument('--bundle', required=True, help='Prepared public signed QA release pair')
    parser.add_argument('--expected-source-sha256', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--adb')
    parser.add_argument('--timeout', type=float, default=35)
    parser.add_argument('--reset-fixture', action='store_true', help='Clear only the disposable fixture package')
    args = parser.parse_args()
    args.scenario = 'live-published-update'
    args.launch = True
    args.cold_launch = False
    driver = None
    try:
        driver = LiveUpdateDriver(args)
        driver.run_scenario()
        driver.result['status'] = 'passed'
        return 0
    except Exception as error:
        if driver:
            driver.result['status'] = 'failed'
            driver.result['error'] = str(error)[:1200]
            try:
                driver.capture('failure')
            except Exception as capture_error:
                driver.result['captureError'] = str(capture_error)[:400]
        print('FAILED: ' + str(error), file=sys.stderr)
        return 1
    finally:
        if driver:
            driver.result['finishedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
            (driver.out / 'result.json').write_text(json.dumps(driver.result, indent=2) + '\n')
            print(json.dumps({'status': driver.result['status'], 'checks': len(driver.result['checks']),
                              'result': str(driver.out / 'result.json')}))


if __name__ == '__main__':
    sys.exit(main())
