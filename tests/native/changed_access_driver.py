#!/usr/bin/env python3
"""Exercise the public-only changed-access update fixture through Android."""
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
    'publisher': '803d57d794cf576cbef909cd854a040bddd4a04fc6ea7a36f85a1daf0bc43799',
    'app': 'hypergolic-changed-access-qa',
    'oldEvent': '2bd6f1bfcfbbd1053735e98e9306664577334ecde33f8420f8cbaa638fb2a0ac',
    'newEvent': '1f7adba5c649f9ab5f5933d658e4aea76c23347d982bbdfe3fa9202155c17beb',
}
SOURCE_PATHS = (
    'tests/native/published-update-fixtures/index.tsx',
    'tests/native/published-update-fixtures/source.ts',
    'tests/napplets/fixtures/changed-access-fixture.ts',
    'src/napplets/embedded-update-fixture.ts',
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
    if not any(resource_id_is(n, 'changed-access-fixture-label') for n in nodes):
        raise CheckFailed('Changed-access fixture banner is not visible')
    address_node = exactly_one(nodes, lambda n: resource_id_is(n, 'changed-access-fixture-address'),
                               'changed-access public naddr')
    address = label(address_node).strip()
    if not re.fullmatch(r'naddr1[023456789acdefghjklmnpqrstuvwxyz]{20,}', address):
        raise CheckFailed('Fixture did not expose a syntactically plausible public naddr')
    release = exactly_one(nodes, lambda n: resource_id_is(n, 'changed-access-fixture-release'),
                          'changed-access release control')
    return address, release


def verify_consent_review(nodes):
    if not any(resource_id_is(n, 'settings-napplet-review') for n in nodes):
        raise CheckFailed('First-open consent review is not visible')
    for value, field in ((FIXTURE['publisher'], 'publisher'), (FIXTURE['app'], 'napplet'),
                         (FIXTURE['oldEvent'], 'event'), ('Requested access: theme', 'requested access')):
        if not any(label(n) == value for n in nodes):
            raise CheckFailed('Consent review did not show the expected ' + field)
    return exactly_one(nodes, lambda n: resource_id_is(n, 'settings-napplet-approve'),
                       'explicit first-open approval')


def update_session_id(nodes):
    reviews = [resource_id_suffix(n) for n in nodes
               if re.fullmatch(r'published-update-review-' + UUID.pattern, resource_id_suffix(n))]
    if len(reviews) != 1:
        raise CheckFailed('Expected one visible UUID-scoped update review')
    for value, field in ((FIXTURE['publisher'], 'publisher'), (FIXTURE['app'], 'napplet'),
                         (FIXTURE['oldEvent'], 'current event'), (FIXTURE['newEvent'], 'new event'),
                         ('Requested access: relay, theme', 'requested access')):
        if not any(label(n) == value for n in nodes):
            raise CheckFailed('Update review did not show the expected ' + field)
    return reviews[0].removeprefix('published-update-review-')


def verify_access_review(nodes, session):
    reviews = [n for n in nodes if resource_id_suffix(n) == 'published-update-access-' + session]
    if len(reviews) != 1:
        raise CheckFailed('Separate changed-access review is not visible for the update session')
    for value, field in ((FIXTURE['publisher'], 'publisher'), (FIXTURE['app'], 'napplet'),
                         ('The update requests: relay, theme', 'new access')):
        if not any(label(n) == value for n in nodes):
            raise CheckFailed('Changed-access review did not show the expected ' + field)


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


class ChangedAccessDriver(base.Driver):
    def __init__(self, args):
        base.ROOT = Path(args.source).resolve()
        super().__init__(args)
        self.result['scope'] = ('Actual Android changed-access update journey through native Settings, '
                                'first-open consent, separate update and access reviews, and workspace')
        self.result['fixture'] = dict(FIXTURE)

    def check(self, name, details):
        super().check(name, details)
        print('PASS ' + name, flush=True)

    def tap_id(self, identifier, description):
        _, nodes = self.nodes()
        self.tap(exactly_one(nodes, lambda n: resource_id_is(n, identifier), description))

    def scroll_until(self, predicate, description):
        for _ in range(14):
            _, nodes = self.nodes()
            matches = [n for n in nodes if predicate(n)]
            if any(self._visible(n) for n in matches):
                return nodes
            scrollables = [n for n in nodes if n.get('scrollable') == 'true']
            if not scrollables:
                raise CheckFailed('No observed scrollable native container while looking for ' + description)
            node = scrollables[-1]
            x1, y1, x2, y2 = base.node_bounds(node)
            x = (x1 + x2) // 2
            self.adb_run('shell', 'input', 'swipe', str(x), str(y1 + (y2-y1)*4//5),
                         str(x), str(y1 + (y2-y1)//3), '350')
        raise CheckFailed(description + ' was not reached by observed native scrolling')

    @staticmethod
    def _visible(node):
        try:
            base.node_bounds(node)
            return True
        except CheckFailed:
            return False

    def open_settings(self):
        _, nodes = self.nodes()
        if any(label(n) == 'Settings' for n in nodes):
            return nodes
        self.tap_id('shell-settings', 'shell settings control')
        return self.wait(lambda observed: any(label(n) == 'Settings' for n in observed),
                         'native Settings screen')[1]

    def close_settings(self):
        self.tap_id('settings-done', 'close Settings control')

    def source_snapshot(self):
        hashes = source_hashes(base.ROOT)
        return {'files': hashes, 'sha256': source_digest(hashes)}

    def run_scenario(self):
        if self.args.package != PACKAGE:
            raise CheckFailed('This driver accepts only the public changed-access fixture package')
        for value, name in ((self.args.expected_apk_sha256, 'APK'),
                            (self.args.expected_source_sha256, 'source')):
            if not re.fullmatch(r'[a-f0-9]{64}', value):
                raise CheckFailed('Exact lowercase SHA-256 handoff required for ' + name)
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
        _, nodes = self.wait(lambda observed: any(resource_id_is(n, 'changed-access-fixture-label') for n in observed),
                             'changed-access fixture banner')
        address, _ = verify_fixture_screen(nodes)
        title = exactly_one(nodes, lambda n: resource_id_is(n, 'focused-napplet-name'), 'empty shell title')
        if label(title) != 'Hypergolic' or any(label(n) == 'Runtime connected' or
                guest_marker([n], 'changed-access-v1') or guest_marker([n], 'changed-access-v2') for n in nodes):
            raise CheckFailed('Changed-access fixture did not begin in its empty shell')
        self.result['fixtureAddress'] = address
        self.check('empty-shell-before-open', 'No published guest was open before first consent')
        self.capture('01-fixture')

        self.open_settings()
        _, nodes = self.nodes()
        if not any(resource_id_is(n, 'settings-full-npub') and label(n) == FIXTURE['identityNpub'] for n in nodes):
            raise CheckFailed('Fixture selected identity is not the disposable public-only key')
        self.scroll_until(lambda n: resource_id_is(n, 'settings-napplet-address'), 'first-open naddr field')
        self.tap_id('settings-napplet-address', 'public naddr field')
        # A single long IME injection can outrun the controlled React Native input.
        for offset in range(0, len(address), 12):
            self.adb_run('shell', 'input', 'text', address[offset:offset + 12])
            time.sleep(0.1)
        self.adb_run('shell', 'input', 'keyevent', '4')
        self.scroll_until(lambda n: resource_id_is(n, 'settings-open-napplet'), 'verify and open action')
        self.tap_id('settings-open-napplet', 'verify and open public napplet')
        _, nodes = self.wait(lambda observed: any(resource_id_is(n, 'settings-napplet-review') for n in observed),
                             'first-open consent review')
        approve = verify_consent_review(nodes)
        self.check('first-open-consent-exact', {'publisher': FIXTURE['publisher'], 'app': FIXTURE['app'],
                   'event': FIXTURE['oldEvent'], 'access': 'theme', 'explicitApprovalRequired': True})
        self.capture('02-consent-review')
        self.tap(approve)
        _, nodes = self.wait(lambda observed: any(label(n) == 'Runtime connected' for n in observed)
                             and guest_marker(observed, 'changed-access-v1'), 'native changed-access-v1 guest')
        if guest_marker(nodes, 'changed-access-v2'):
            raise CheckFailed('Initial session rendered v2 before the update was approved')
        self.check('native-runtime-v1-connected', 'Native runtime and changed-access-v1 guest were visible')
        self.capture('03-changed-access-v1')

        _, nodes = self.nodes()
        self.tap(exactly_one(nodes, lambda n: resource_id_is(n, 'changed-access-fixture-release'),
                             'make-new-revision-available action'))
        self.wait(lambda observed: any('Changed-access revision available' in label(n) for n in observed),
                  'fixture release activated')
        self.open_settings()
        nodes = self.scroll_until(lambda n: re.fullmatch(r'published-update-check-' + UUID.pattern,
                                                          resource_id_suffix(n)) is not None,
                                  'published update check action')
        check = exactly_one(nodes, lambda n: re.fullmatch(r'published-update-check-' + UUID.pattern,
                                                           resource_id_suffix(n)) is not None,
                           'published update check action')
        self.tap(check)
        _, nodes = self.wait(lambda observed: any(re.fullmatch(r'published-update-review-' + UUID.pattern,
                                    resource_id_suffix(n)) for n in observed), 'verified update review')
        nodes = self.scroll_until(lambda n: label(n) == FIXTURE['oldEvent'], 'visible current event field')
        session = update_session_id(nodes)
        self.result['sessionId'] = session
        self.check('update-review-exact', {'publisher': FIXTURE['publisher'], 'app': FIXTURE['app'],
                   'oldEvent': FIXTURE['oldEvent'], 'newEvent': FIXTURE['newEvent'],
                   'access': ['relay', 'theme'], 'sessionId': session})
        self.capture('04-update-review-accept-event')
        accept_update = self.scroll_until(lambda n: resource_id_suffix(n) == 'published-update-accept-' + session,
                                          'accept update action')
        self.tap(exactly_one(accept_update, lambda n: resource_id_suffix(n) ==
                             'published-update-accept-' + session, 'accept update action'))
        _, nodes = self.wait(lambda observed: any(resource_id_suffix(n) == 'published-update-access-' + session
                                for n in observed), 'separate changed-access review')
        verify_access_review(nodes, session)
        self.check('changed-access-review-exact', {'publisher': FIXTURE['publisher'], 'app': FIXTURE['app'],
                   'access': ['relay', 'theme'], 'separateConsentRequired': True})
        self.capture('05-changed-access-review-decline')
        cancel_access_nodes = self.scroll_until(lambda n: resource_id_suffix(n) ==
                                                'published-update-access-cancel-' + session,
                                                'decline changed-access action')
        cancel_access = exactly_one(cancel_access_nodes, lambda n: resource_id_suffix(n) ==
                                    'published-update-access-cancel-' + session,
                                    'decline changed-access action')
        self.tap(cancel_access)
        self.wait(lambda observed: any(resource_id_suffix(n) == 'published-update-check-' + session
                                       for n in observed), 'changed-access review declined')
        self.check('decline-changed-access-keeps-v1',
                   'Declining the separate relay-access review preserves the pinned v1 event and grant')
        self.capture('06-declined-changed-access-v1')
        self.close_settings()
        _, nodes = self.wait(lambda observed: any(label(n) == 'Runtime connected' for n in observed)
                             and guest_marker(observed, 'changed-access-v1'),
                             'connected v1 guest after changed-access decline')
        if guest_marker(nodes, 'changed-access-v2'):
            raise CheckFailed('Declining changed access changed the v1 guest revision')

        self.open_settings()
        nodes = self.scroll_until(lambda n: resource_id_suffix(n) == 'published-update-check-' + session,
                                  'repeat update check after access decline')
        self.tap(exactly_one(nodes, lambda n: resource_id_suffix(n) == 'published-update-check-' + session,
                             'repeat update check after access decline'))
        _, nodes = self.wait(lambda observed: any(re.fullmatch(r'published-update-review-' + UUID.pattern,
                                    resource_id_suffix(n)) for n in observed), 'repeat verified update review')
        nodes = self.scroll_until(lambda n: label(n) == FIXTURE['oldEvent'], 'visible current event field')
        if update_session_id(nodes) != session:
            raise CheckFailed('Session identity changed after declining changed access')
        accept_update = self.scroll_until(lambda n: resource_id_suffix(n) == 'published-update-accept-' + session,
                                          'accept update after access decline')
        self.tap(exactly_one(accept_update, lambda n: resource_id_suffix(n) ==
                             'published-update-accept-' + session, 'accept update after access decline'))
        _, nodes = self.wait(lambda observed: any(resource_id_suffix(n) == 'published-update-access-' + session
                                for n in observed), 'repeat separate changed-access review')
        verify_access_review(nodes, session)
        self.check('changed-access-review-repeated-after-decline',
                   {'requestedAccess': ['relay', 'theme'], 'sessionId': session})
        self.capture('07-changed-access-review-accept')
        accept_access_nodes = self.scroll_until(lambda n: resource_id_suffix(n) ==
                                                'published-update-access-accept-' + session,
                                                'accept changed-access action')
        accept_access = exactly_one(accept_access_nodes, lambda n: resource_id_suffix(n) ==
                                    'published-update-access-accept-' + session,
                                    'accept changed-access action')
        self.tap(accept_access)
        _, nodes = self.wait(lambda observed: any(label(n) == 'Runtime connected' for n in observed)
                             and guest_marker(observed, 'changed-access-v2'), 'native changed-access-v2 guest')
        if guest_marker(nodes, 'changed-access-v1'):
            raise CheckFailed('Old guest remained after accepting the changed-access update')
        self.check('accept-update-and-access-replaces-v1',
                   'Separate update and changed-access decisions connected the v2 guest')
        self.capture('08-changed-access-v2')

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
    parser.add_argument('--launch', action='store_true', help='Launch existing fixture app; never reinstalls or clears data')
    args = parser.parse_args()
    args.scenario = 'changed-access-update'
    args.cold_launch = False
    for value, name in ((args.expected_apk_sha256, 'APK'), (args.expected_source_sha256, 'source')):
        if not re.fullmatch(r'[a-f0-9]{64}', value):
            parser.error('Exact lowercase SHA-256 handoff required for ' + name)
    if args.package != PACKAGE:
        parser.error('Package must be ' + PACKAGE)
    active = None
    exit_code = 1
    try:
        active = ChangedAccessDriver(args)
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
