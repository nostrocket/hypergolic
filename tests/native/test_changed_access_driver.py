"""Offline admission checks for the Android changed-access UI driver."""
import sys
import unittest
from unittest.mock import patch

from driver import CheckFailed
import changed_access_driver as cad


SESSION = '76be31d0-7748-4c6f-b7c6-819253a6074c'


def node(identifier=None, text='', bounds='[1,1][300,40]'):
    return {'resource-id': identifier or '', 'text': text, 'bounds': bounds}


def update_review_nodes():
    return [
        node('org.test:id/published-update-review-' + SESSION, 'Use this verified update?'),
        node(text=cad.FIXTURE['publisher']),
        node(text=cad.FIXTURE['app']),
        node(text=cad.FIXTURE['oldEvent']),
        node(text=cad.FIXTURE['newEvent']),
        node(text='Requested access: relay, theme'),
        node('org.test:id/published-update-accept-' + SESSION, 'Close and use update'),
        node('org.test:id/published-update-cancel-' + SESSION, 'Keep current version'),
    ]


def access_review_nodes():
    return [
        node('org.test:id/published-update-access-' + SESSION, 'Allow changed access?'),
        node(text=cad.FIXTURE['publisher']),
        node(text=cad.FIXTURE['app']),
        node(text='The update requests: relay, theme'),
        node('org.test:id/published-update-access-accept-' + SESSION, 'Allow and update'),
        node('org.test:id/published-update-access-cancel-' + SESSION, 'Keep current version'),
    ]


def consent_nodes():
    return [
        node('org.test:id/settings-napplet-review', 'Allow this napplet?'),
        node(text=cad.FIXTURE['publisher']),
        node(text=cad.FIXTURE['app']),
        node(text=cad.FIXTURE['oldEvent']),
        node(text='Requested access: theme'),
        node('org.test:id/settings-napplet-approve', 'Allow and open'),
    ]


class ChangedAccessDriverTests(unittest.TestCase):
    def test_fixture_screen_uses_its_distinct_public_address_and_release_controls(self):
        address = 'naddr1' + 'q' * 40
        actual, release = cad.verify_fixture_screen([
            node('org.test:id/changed-access-fixture-label', 'Changed access QA'),
            node('org.test:id/changed-access-fixture-address', address),
            node('org.test:id/changed-access-fixture-release', 'Make new revision available'),
        ])
        self.assertEqual(actual, address)
        self.assertEqual(release['text'], 'Make new revision available')

    def test_fixture_screen_rejects_missing_banner_or_malformed_address(self):
        for nodes in (
            [node('org.test:id/changed-access-fixture-address', 'naddr1' + 'q' * 40),
             node('org.test:id/changed-access-fixture-release', 'release')],
            [node('org.test:id/changed-access-fixture-label', 'fixture'),
             node('org.test:id/changed-access-fixture-address', 'npub1' + 'q' * 40),
             node('org.test:id/changed-access-fixture-release', 'release')],
        ):
            with self.subTest(nodes=nodes), self.assertRaises(CheckFailed):
                cad.verify_fixture_screen(nodes)

    def test_first_open_review_requires_exact_v1_claims_and_explicit_approval(self):
        self.assertEqual(cad.verify_consent_review(consent_nodes())['text'], 'Allow and open')
        for index, wrong in ((1, 'other publisher'), (2, 'other napplet'),
                             (3, 'other event'), (4, 'Requested access: relay')):
            changed = consent_nodes()
            changed[index]['text'] = wrong
            with self.subTest(index=index), self.assertRaises(CheckFailed):
                cad.verify_consent_review(changed)
        with self.assertRaises(CheckFailed):
            cad.verify_consent_review(consent_nodes()[:-1])

    def test_fixture_identity_and_signed_event_ids_match_the_embedded_fixture(self):
        self.assertEqual(cad.FIXTURE['publisher'],
                         '803d57d794cf576cbef909cd854a040bddd4a04fc6ea7a36f85a1daf0bc43799')
        self.assertEqual(cad.FIXTURE['oldEvent'],
                         '2bd6f1bfcfbbd1053735e98e9306664577334ecde33f8420f8cbaa638fb2a0ac')
        self.assertEqual(cad.FIXTURE['newEvent'],
                         '1f7adba5c649f9ab5f5933d658e4aea76c23347d982bbdfe3fa9202155c17beb')

    def test_update_review_binds_the_signed_revision_and_expanded_access(self):
        self.assertEqual(cad.update_session_id(update_review_nodes()), SESSION)

    def test_update_review_rejects_changed_event_access_or_ambiguous_session(self):
        for index, wrong in ((4, 'wrong event'), (5, 'Requested access: theme, relay')):
            changed = update_review_nodes()
            changed[index]['text'] = wrong
            with self.subTest(index=index), self.assertRaises(CheckFailed):
                cad.update_session_id(changed)
        changed = update_review_nodes()
        changed.insert(1, node('org.test:id/published-update-review-' + SESSION))
        with self.assertRaises(CheckFailed):
            cad.update_session_id(changed)

    def test_separate_changed_access_review_requires_exact_claims_and_session(self):
        cad.verify_access_review(access_review_nodes(), SESSION)
        for index, wrong in ((1, 'other publisher'), (2, 'other napplet'),
                             (3, 'The update requests: theme, relay')):
            changed = access_review_nodes()
            changed[index]['text'] = wrong
            with self.subTest(index=index), self.assertRaises(CheckFailed):
                cad.verify_access_review(changed, SESSION)
        with self.assertRaises(CheckFailed):
            cad.verify_access_review(access_review_nodes(), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')

    def test_native_guest_marker_checks_observed_hierarchy(self):
        nodes = [node(text='Runtime connected'), node(text='changed-access-v1')]
        self.assertTrue(cad.guest_marker(nodes, 'changed-access-v1'))
        self.assertFalse(cad.guest_marker(nodes, 'changed-access-v2'))

    def test_source_manifest_includes_fixture_and_distinct_fixture_source(self):
        self.assertIn('tests/napplets/fixtures/changed-access-fixture.ts', cad.SOURCE_PATHS)
        self.assertIn('tests/native/published-update-fixtures/source.ts', cad.SOURCE_PATHS)
        self.assertIn('tests/native/published-update-fixtures/index.tsx', cad.SOURCE_PATHS)

    def test_non_fixture_package_is_rejected_by_cli_before_driver_creation(self):
        argv = ['changed_access_driver.py', '--source', '.', '--serial', 'emulator-5554',
                '--package', 'org.nostrocket.hypergolic.dev', '--expected-apk-sha256', 'a' * 64,
                '--expected-source-sha256', 'b' * 64, '--output', 'unused']
        with patch.object(sys, 'argv', argv), patch.object(cad, 'ChangedAccessDriver') as driver:
            with self.assertRaises(SystemExit):
                cad.main()
            driver.assert_not_called()


if __name__ == '__main__':
    unittest.main()
