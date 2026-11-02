#!/usr/bin/env python3
"""Exercise the public-only published-update fixture through the real Android shell."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
import time

import driver as base
from driver import CheckFailed, exactly_one, label

PACKAGE = 'org.nostrocket.hypergolic.publishedupdatefixture'
FIXTURE = {
    'identityNpub': 'npub1qdy7xywj7luwyagwz6gz2u52t026eqzv9pvg9y5t7zvvlzc7nzlqnsqte4',
    'publisher': '638cd26c28fb52d057f424d11a14e24526ac4b5e08cbad5d6c36f8f57cacce2f',
    'app': 'hypergolic-update-qa',
    'oldEvent': 'dc078ef5973560de09933f39f19dddc28c51b2b30c7ec505157442db665a48b1',
    'newEvent': 'df50ad4aa2bcbc0514f75a63ca72c0dfb12da1b1e9e199f551bd6d2d98a71640',
}
SOURCE_PATHS = (
    'tests/native/published-update-fixtures/index.tsx',
    'tests/native/published-update-fixtures/source.ts',
    'src/napplets/embedded-update-fixture.ts',
    'tests/napplets/fixtures/changed-access-fixture.ts',
    'src/napplets/embedded-update-source.ts',
    'src/napplets/published-session.ts',
    'src/napplets/first-open-consent.ts',
    'src/runtime/runtime-owner.ts',
    'src/runtime/native-capability-port.ts',
    'src/security/approval-owner.ts',
    'src/security/approval-service.ts',
    'src/shell/workspace.ts',
    'src/shell/Shell.tsx',
    'src/shell/IdentityShell.tsx',
    'src/shell/IdentitySettings.tsx',
    'src/shell/OpenPublishedNapplet.tsx',
    'src/shell/UpdatePublishedNapplet.tsx',
    'modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host/NappletHostView.kt',
)
UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}')


def resource_id_is(node, identifier):
    value = node.get('resource-id', '')
    return value == identifier or value.endswith('/' + identifier)


def resource_id_suffix(node):
    return node.get('resource-id', '').rsplit('/', 1)[-1]


def verify_fixture_screen(nodes):
    """Admit only the expected public QA banner, naddr, and release control."""
    if not any(resource_id_is(n, 'update-fixture-label') for n in nodes):
        raise CheckFailed('Published update fixture banner is not visible')
    address_node = exactly_one(nodes, lambda n: resource_id_is(n, 'update-fixture-address'),
                               'fixture public naddr')
    address = label(address_node).strip()
    if not re.fullmatch(r'naddr1[023456789acdefghjklmnpqrstuvwxyz]{20,}', address):
        raise CheckFailed('Fixture did not expose a syntactically plausible public naddr')
    release = exactly_one(nodes, lambda n: resource_id_is(n, 'update-fixture-release'),
                          'fixture release control')
    return address, release


def verify_consent_review(nodes):
    if not any(resource_id_is(n, 'settings-napplet-review') for n in nodes):
        raise CheckFailed('First-open consent review is not visible')
    expected = (FIXTURE['publisher'], FIXTURE['app'], FIXTURE['oldEvent'])
    for value, field in zip(expected, ('publisher', 'app', 'old event')):
        if not any(label(n) == value for n in nodes):
            raise CheckFailed('Consent review did not show the expected ' + field)
    return exactly_one(nodes, lambda n: resource_id_is(n, 'settings-napplet-approve'),
                       'explicit first-open approval')


def find_update_control(nodes, prefix):
    pattern = re.compile(re.escape(prefix) + UUID.pattern)
    return exactly_one(nodes, lambda n: pattern.fullmatch(resource_id_suffix(n)) is not None,
                       'one UUID-scoped ' + prefix.rstrip('-') + ' control')


def verify_update_review(nodes):
    review_ids = [resource_id_suffix(n) for n in nodes
                  if re.fullmatch(r'published-update-review-' + UUID.pattern,
                                  resource_id_suffix(n))]
    if len(review_ids) != 1:
        raise CheckFailed('Expected one visible UUID-scoped update review')
    for value, field in ((FIXTURE['publisher'], 'publisher'), (FIXTURE['app'], 'napplet'),
                         (FIXTURE['oldEvent'], 'current event'), (FIXTURE['newEvent'], 'new event'),
                         ('Requested access: theme', 'requested access')):
        if not any(label(n) == value for n in nodes):
            raise CheckFailed('Update review did not show the expected ' + field)
    session_id = review_ids[0].removeprefix('published-update-review-')
    return session_id


def guest_marker(nodes, marker):
    return any(marker in label(n) for n in nodes)


def source_hashes(root):
    hashes = {}
    for name in SOURCE_PATHS:
        path = root / name
        if not path.is_file():
            raise CheckFailed('Frozen source file is missing: ' + name)
        hashes[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return hashes


def source_digest(hashes):
    payload = json.dumps(hashes, sort_keys=True, separators=(',', ':')).encode()
    return hashlib.sha256(payload).hexdigest()


class PublishedUpdateDriver(base.Driver):
    def __init__(self, args):
        base.ROOT = Path(args.source).resolve()
        super().__init__(args)
        self.result['scope'] = ('Actual Android public-only published-update fixture journey through native '
                                'Settings, consent, process-owned update coordinator, and workspace')
        self.result['fixture'] = dict(FIXTURE)

    def check(self, name, details):
        super().check(name, details)
        print('PASS ' + name, flush=True)

    def tap_id(self, identifier, description):
        _, nodes = self.nodes()
        node = exactly_one(nodes, lambda n: resource_id_is(n, identifier), description)
        self.tap(node)

    def scroll_until(self, predicate, description):
        for _ in range(14):
            _, nodes = self.nodes()
            matches = [node for node in nodes if predicate(node)]
            if matches:
                visible = []
                for node in matches:
                    try:
                        base.node_bounds(node)
                        visible.append(node)
                    except CheckFailed:
                        pass
                if visible:
                    return nodes
            scrollables = [node for node in nodes if node.get('scrollable') == 'true']
            if not scrollables:
                raise CheckFailed('No observed scrollable native container while looking for ' + description)
            node = scrollables[-1]
            x1, y1, x2, y2 = base.node_bounds(node)
            x = (x1 + x2) // 2
            self.adb_run('shell', 'input', 'swipe', str(x), str(y1 + (y2-y1)*4//5),
                         str(x), str(y1 + (y2-y1)//3), '350')
        raise CheckFailed(description + ' was not reached by observed native scrolling')

    def open_settings(self):
        _, nodes = self.nodes()
        if any(label(n) == 'Settings' for n in nodes):
            return nodes
        self.tap_id('shell-settings', 'shell settings control')
        return self.wait(lambda observed: any(label(n) == 'Settings' for n in observed),
                         'native Settings screen')[1]

    def return_to_fixture(self):
        _, nodes = self.nodes()
        if any(label(n) != 'Settings' for n in nodes) and any(resource_id_is(n, 'shell-settings') for n in nodes):
            return nodes
        self.tap_id('settings-done', 'close Settings control')
        return self.wait(lambda observed: any(resource_id_is(n, 'update-fixture-label') for n in observed),
                         'published update fixture shell')[1]

    def source_snapshot(self):
        hashes = source_hashes(base.ROOT)
        return {'files': hashes, 'sha256': source_digest(hashes)}

    def run_scenario(self):
        if self.args.package != PACKAGE:
            raise CheckFailed('This driver accepts only the public update fixture package')
        if not re.fullmatch(r'[a-f0-9]{64}', self.args.expected_apk_sha256):
            raise CheckFailed('Exact installed APK SHA-256 handoff is required')
        if not re.fullmatch(r'[a-f0-9]{64}', self.args.expected_source_sha256):
            raise CheckFailed('Frozen source SHA-256 handoff is required')
        self.metadata()
        if self.result['app']['installedBaseApkSha256'] != self.args.expected_apk_sha256:
            raise CheckFailed('Installed APK differs from the exact native-build handoff hash')
        self.result['sourceBefore'] = self.source_snapshot()
        if self.result['sourceBefore']['sha256'] != self.args.expected_source_sha256:
            raise CheckFailed('Source differs from the exact frozen-source handoff hash')

        if self.args.launch:
            launch = self.adb_run('shell', 'am', 'start', '-W', '-n',
                                  PACKAGE + '/org.nostrocket.hypergolic.dev.MainActivity')
            if 'Status: ok' not in launch:
                raise CheckFailed('Android did not report successful fixture launch')
        _, nodes = self.wait(lambda observed: any(resource_id_is(n, 'update-fixture-label') for n in observed),
                             'public update fixture banner')
        address, release = verify_fixture_screen(nodes)
        shell_title = exactly_one(nodes, lambda n: resource_id_is(n, 'focused-napplet-name'),
                                  'empty shell title')
        if label(shell_title) != 'Hypergolic' or any(
                label(n) == 'Runtime connected' or guest_marker([n], 'update-v1') or
                guest_marker([n], 'update-v2') for n in nodes):
            raise CheckFailed('Published update fixture did not begin in its empty shell')
        self.result['fixtureAddress'] = address
        self.check('public-fixture-ready', {'package': PACKAGE, 'naddrObserved': True})
        self.check('empty-shell-before-open', 'No published guest was open before first consent')
        self.capture('01-fixture')

        nodes = self.open_settings()
        if not any(resource_id_is(n, 'settings-full-npub') and label(n) == FIXTURE['identityNpub']
                   for n in nodes):
            raise CheckFailed('Fixture selected identity is not the disposable public-only key')
        self.scroll_until(lambda n: resource_id_is(n, 'settings-napplet-address'),
                          'first-open naddr field')
        self.tap_id('settings-napplet-address', 'public naddr field')
        self.adb_run('shell', 'input', 'text', address)
        self.adb_run('shell', 'input', 'keyevent', '4')
        self.scroll_until(lambda n: resource_id_is(n, 'settings-open-napplet'),
                          'verify and open action')
        self.tap_id('settings-open-napplet', 'verify and open public napplet')
        _, nodes = self.wait(lambda observed: any(resource_id_is(n, 'settings-napplet-review') for n in observed),
                             'first-open consent review')
        approve = verify_consent_review(nodes)
        self.check('first-open-consent-exact', {'publisher': FIXTURE['publisher'], 'app': FIXTURE['app'],
                   'event': FIXTURE['oldEvent'], 'explicitApprovalRequired': True})
        self.capture('02-consent-review')
        self.tap(approve)
        _, nodes = self.wait(lambda observed: any(label(n) == 'Runtime connected' for n in observed)
                             and guest_marker(observed, 'update-v1'),
                             'native runtime connected with accessible update-v1 guest')
        if guest_marker(nodes, 'update-v2'):
            raise CheckFailed('Initial session rendered the new revision before approval')
        self.check('native-runtime-v1-connected',
                   'Target package hierarchy showed native Runtime connected and the update-v1 guest marker')
        self.capture('03-update-v1')

        _, nodes = self.nodes()
        release = exactly_one(nodes, lambda n: resource_id_is(n, 'update-fixture-release'),
                              'make-new-revision-available action')
        self.tap(release)
        _, nodes = self.wait(lambda observed: any('New revision available' in label(n) for n in observed),
                             'fixture release activated')
        self.check('fixture-release-activated', 'Fixture transport made the signed update available')
        self.open_settings()
        nodes = self.scroll_until(lambda n: resource_id_suffix(n).startswith('published-update-check-'),
                                  'published update check action')
        check = find_update_control(nodes, 'published-update-check-')
        self.tap(check)
        _, nodes = self.wait(lambda observed: any(
            re.fullmatch(r'published-update-review-' + UUID.pattern, resource_id_suffix(n)) for n in observed),
            'verified old/new update review')
        nodes = self.scroll_until(lambda n: label(n) == FIXTURE['oldEvent'], 'visible current event field')
        session_id = verify_update_review(nodes)
        self.result['sessionId'] = session_id
        self.check('update-review-exact', {'publisher': FIXTURE['publisher'], 'app': FIXTURE['app'],
                   'oldEvent': FIXTURE['oldEvent'], 'newEvent': FIXTURE['newEvent'],
                   'sessionId': session_id})
        self.capture('04-update-review-cancel')
        nodes = self.scroll_until(lambda n: resource_id_suffix(n) == 'published-update-cancel-' + session_id,
                                  'decline update action')
        cancel = exactly_one(nodes, lambda n: resource_id_suffix(n) == 'published-update-cancel-' + session_id,
                             'cancel button scoped to reviewed session')
        self.tap(cancel)
        self.wait(lambda observed: any(
            resource_id_suffix(n) == 'published-update-check-' + session_id for n in observed),
            'update review cancelled with session retained')
        self.check('cancel-keeps-old-session', 'Update was declined and the original published session remains')
        self.capture('05-cancelled-v1')
        self.tap_id('settings-done', 'close Settings after declining update')
        _, nodes = self.wait(lambda observed: guest_marker(observed, 'update-v1'),
                             'accessible update-v1 guest after declining')
        if guest_marker(nodes, 'update-v2'):
            raise CheckFailed('Declining the update changed the original guest revision')

        self.open_settings()
        nodes = self.scroll_until(lambda n: resource_id_suffix(n).startswith('published-update-check-'),
                                  'published update check action after decline')
        check = find_update_control(nodes, 'published-update-check-')
        self.tap(check)
        _, nodes = self.wait(lambda observed: any(
            re.fullmatch(r'published-update-review-' + UUID.pattern, resource_id_suffix(n)) for n in observed),
            'second verified update review')
        nodes = self.scroll_until(lambda n: label(n) == FIXTURE['oldEvent'], 'visible current event field')
        session_id2 = verify_update_review(nodes)
        if session_id2 != session_id:
            raise CheckFailed('Session identity changed after declining the update')
        self.capture('06-update-review-accept')
        nodes = self.scroll_until(lambda n: resource_id_suffix(n) == 'published-update-accept-' + session_id,
                                  'accept update action')
        accept = exactly_one(nodes, lambda n: resource_id_suffix(n) == 'published-update-accept-' + session_id,
                             'accept button scoped to reviewed session')
        self.tap(accept)
        _, nodes = self.wait(lambda observed: any(label(n) == 'Runtime connected' for n in observed)
                             and guest_marker(observed, 'update-v2'),
                             'native runtime connected with accessible update-v2 guest')
        if guest_marker(nodes, 'update-v1'):
            raise CheckFailed('Old guest remained after the approved update replaced its session')
        self.check('accept-replaces-session',
                   'Target package hierarchy showed native Runtime connected and update-v2 without update-v1')
        self.capture('07-update-v2')

        self.adb_run('shell', 'am', 'force-stop', PACKAGE)
        restart = self.adb_run('shell', 'am', 'start', '-W', '-n',
                               PACKAGE + '/org.nostrocket.hypergolic.dev.MainActivity')
        if 'Status: ok' not in restart or 'LaunchState: COLD' not in restart:
            raise CheckFailed('Android did not report a cold launch after the accepted update')
        _, nodes = self.wait(lambda observed: any(label(n) == 'Runtime connected' for n in observed)
                             and guest_marker(observed, 'update-v2'),
                             'accepted update-v2 guest restored after cold restart')
        if guest_marker(nodes, 'update-v1'):
            raise CheckFailed('Old guest returned after the accepted update and cold restart')
        self.check('cold-restart-retains-v2',
                   'Cold-launched fixture restored the accepted update-v2 native guest without update-v1')
        self.capture('08-restarted-update-v2')

        self.open_settings()
        nodes = self.scroll_until(lambda n: resource_id_suffix(n).startswith('published-update-check-'),
                                  'check older fixture revision after restart')
        check = find_update_control(nodes, 'published-update-check-')
        restarted_session_id = resource_id_suffix(check).removeprefix('published-update-check-')
        self.tap(check)
        _, nodes = self.wait(lambda observed: any(
            'current version remains open' in label(n) or 'latest verified version' in label(n)
            for n in observed), 'older fixture revision rejected without review')
        if any(resource_id_suffix(n).startswith('published-update-review-') for n in nodes) or not any(
                label(n) == 'Pinned event ' + FIXTURE['newEvent'] for n in nodes):
            raise CheckFailed('Older fixture revision changed the accepted pin or opened a review')
        self.tap_id('settings-done', 'close Settings after older revision check')
        _, nodes = self.wait(lambda observed: guest_marker(observed, 'update-v2'),
                             'accepted guest after older revision check')
        if guest_marker(nodes, 'update-v1'):
            raise CheckFailed('Older fixture revision replaced the accepted native guest')
        self.check('rollback-rejected-after-restart',
                   {'restoredSessionId': restarted_session_id,
                    'olderReviewOffered': False, 'pinnedEvent': FIXTURE['newEvent'], 'host': 'update-v2'})
        self.capture('09-older-revision-rejected')

        self.adb_run('shell', 'input', 'keyevent', 'KEYCODE_HOME')
        foreground = self.adb_run('shell', 'am', 'start', '-W', '-n',
                                  PACKAGE + '/org.nostrocket.hypergolic.dev.MainActivity')
        if 'Status: ok' not in foreground:
            raise CheckFailed('Android did not foreground the fixture after backgrounding')
        _, nodes = self.wait(lambda observed: guest_marker(observed, 'update-v2')
                             and any(label(n) == 'Runtime connected' for n in observed),
                             'verified published read view retained after background')
        if guest_marker(nodes, 'update-v1') or any(resource_id_suffix(n).startswith('published-retry-') for n in nodes):
            raise CheckFailed('Background changed the accepted native read view')
        self.check('background-retains-verified-v2',
                   {'retainedSessionId': restarted_session_id, 'pinnedEvent': FIXTURE['newEvent'],
                    'host': 'update-v2', 'scope': 'Loaded read view retention; stream reconnect is tested separately.'})
        self.capture('10-background-retained-v2')

        self.result['sourceAfter'] = self.source_snapshot()
        if self.result['sourceAfter'] != self.result['sourceBefore']:
            raise CheckFailed('Frozen application source changed during the native evidence run')
        self.check('source-freeze-preserved', self.result['sourceBefore']['sha256'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--package', default=PACKAGE)
    parser.add_argument('--adb')
    parser.add_argument('--timeout', type=float, default=35)
    parser.add_argument('--expected-apk-sha256', required=True)
    parser.add_argument('--expected-source-sha256', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--launch', action='store_true',
                        help='Launch existing fixture app; never reinstalls or clears data')
    args = parser.parse_args()
    args.scenario = 'published-update'
    args.cold_launch = False
    for value, name in ((args.expected_apk_sha256, 'APK'), (args.expected_source_sha256, 'source')):
        if not re.fullmatch(r'[a-f0-9]{64}', value):
            parser.error('Exact lowercase SHA-256 handoff required for ' + name)
    if args.package != PACKAGE:
        parser.error('Package must be ' + PACKAGE)
    active = None
    exit_code = 1
    try:
        active = PublishedUpdateDriver(args)
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
