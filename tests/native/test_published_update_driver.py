"""Offline admission checks for the Android published-update UI driver."""
import sys
import unittest
from unittest.mock import patch

from driver import CheckFailed
import published_update_driver as pud


def node(identifier=None, text='', bounds='[1,1][300,40]'):
    return {'resource-id': identifier or '', 'text': text, 'bounds': bounds}


def consent_nodes():
    return [
        node('org.test:id/settings-napplet-review', 'Allow this napplet?'),
        node(text=pud.FIXTURE['publisher']),
        node(text=pud.FIXTURE['app']),
        node(text=pud.FIXTURE['oldEvent']),
        node('org.test:id/settings-napplet-approve', 'Allow and open'),
    ]


def update_review_nodes(session='76be31d0-7748-4c6f-b7c6-819253a6074c'):
    return [
        node('org.test:id/published-update-review-' + session, 'Use this verified update?'),
        node(text=pud.FIXTURE['publisher']),
        node(text=pud.FIXTURE['app']),
        node(text=pud.FIXTURE['oldEvent']),
        node(text=pud.FIXTURE['newEvent']),
        node(text='Requested access: theme'),
        node('org.test:id/published-update-accept-' + session, 'Close and use update'),
        node('org.test:id/published-update-cancel-' + session, 'Keep current version'),
    ]


class PublishedUpdateDriverTests(unittest.TestCase):
    def test_fixture_screen_admits_public_address_and_release_control(self):
        address = 'naddr1' + 'q' * 40
        actual, release = pud.verify_fixture_screen([
            node('org.test:id/update-fixture-label', 'Published update QA'),
            node('org.test:id/update-fixture-address', address),
            node('org.test:id/update-fixture-release', 'Make new revision available'),
        ])
        self.assertEqual(actual, address)
        self.assertEqual(release['text'], 'Make new revision available')

    def test_fixture_screen_rejects_missing_or_non_naddr_address(self):
        for address in ('npub1' + 'q' * 40, ''):
            with self.subTest(address=address), self.assertRaises(CheckFailed):
                pud.verify_fixture_screen([
                    node('org.test:id/update-fixture-label', 'fixture'),
                    node('org.test:id/update-fixture-address', address),
                    node('org.test:id/update-fixture-release', 'release'),
                ])

    def test_consent_requires_exact_public_metadata_and_explicit_approval(self):
        self.assertEqual(pud.verify_consent_review(consent_nodes())['text'], 'Allow and open')
        for index in (1, 2, 3):
            changed = consent_nodes()
            changed[index]['text'] = 'unexpected'
            with self.subTest(field=index), self.assertRaises(CheckFailed):
                pud.verify_consent_review(changed)
        with self.assertRaises(CheckFailed):
            pud.verify_consent_review(consent_nodes()[:-1])

    def test_update_review_binds_dynamic_uuid_and_exact_events(self):
        session = pud.verify_update_review(update_review_nodes())
        self.assertEqual(session, '76be31d0-7748-4c6f-b7c6-819253a6074c')

    def test_update_review_rejects_mismatched_ids_or_claims(self):
        changed = update_review_nodes()
        changed[4]['text'] = 'wrong next event'
        with self.assertRaises(CheckFailed):
            pud.verify_update_review(changed)
        changed = update_review_nodes()
        changed[5]['text'] = 'Requested access: identity'
        with self.assertRaises(CheckFailed):
            pud.verify_update_review(changed)
        changed = update_review_nodes()
        changed[0]['resource-id'] = 'org.test:id/published-update-review-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        changed.insert(1, node('org.test:id/published-update-review-76be31d0-7748-4c6f-b7c6-819253a6074c'))
        with self.assertRaises(CheckFailed):
            pud.verify_update_review(changed)

    def test_guest_revision_marker_is_taken_from_native_observed_nodes(self):
        nodes = [node(text='Runtime connected'), node(text='update-v1')]
        self.assertTrue(pud.guest_marker(nodes, 'update-v1'))
        self.assertFalse(pud.guest_marker(nodes, 'update-v2'))

    def test_unknown_options_fail_before_driver_creation(self):
        argv = ['published_update_driver.py', '--source', '.', '--serial', 'emulator-5554',
                '--expected-apk-sha256', 'a' * 64, '--expected-source-sha256', 'b' * 64,
                '--output', 'unused', '--unknown']
        with patch.object(sys, 'argv', argv), patch.object(pud, 'PublishedUpdateDriver') as driver:
            with self.assertRaises(SystemExit):
                pud.main()
            driver.assert_not_called()

    def test_non_fixture_package_is_rejected_by_cli(self):
        argv = ['published_update_driver.py', '--source', '.', '--serial', 'emulator-5554',
                '--package', 'org.nostrocket.hypergolic.dev', '--expected-apk-sha256', 'a' * 64,
                '--expected-source-sha256', 'b' * 64, '--output', 'unused']
        with patch.object(sys, 'argv', argv), patch.object(pud, 'PublishedUpdateDriver') as driver:
            with self.assertRaises(SystemExit):
                pud.main()
            driver.assert_not_called()


if __name__ == '__main__':
    unittest.main()
