"""Offline admission checks; these tests do not represent Android execution."""
import copy
import sys
import unittest
from unittest.mock import patch
from driver import CheckFailed
import published_host_driver as phd


def review_nodes():
    return [
        {'text': 'Signed test napplet', 'bounds': '[1,1][300,40]'},
        {'resource-id': 'org.test:id/published-lab-publisher', 'text': phd.FIXTURE['publisher'], 'bounds': '[1,50][300,90]'},
        {'text': phd.FIXTURE['app'], 'bounds': '[1,100][300,140]'},
        {'text': phd.FIXTURE['event'], 'bounds': '[1,150][300,190]'},
        {'text': phd.FIXTURE['access'], 'bounds': '[1,200][300,240]'},
        {'resource-id': 'org.test:id/published-lab-open', 'text': 'Open signed test', 'bounds': '[1,250][300,300]'},
    ]


class PublishedHostFixtureTests(unittest.TestCase):
    def test_fixture_claims_are_exact_and_include_explicit_open(self):
        button = phd.verify_review(review_nodes())
        self.assertEqual(button['text'], 'Open signed test')

    def test_changed_or_missing_publisher_app_event_or_access_is_rejected(self):
        for index in (1, 2, 3, 4):
            nodes = review_nodes()
            nodes[index]['text'] = 'unexpected'
            with self.subTest(field=index):
                with self.assertRaises(CheckFailed):
                    phd.verify_review(nodes)

    def test_missing_open_button_is_not_admitted_as_review(self):
        nodes = review_nodes()[:-1]
        with self.assertRaises(CheckFailed):
            phd.verify_review(nodes)

    def test_unknown_command_options_fail_before_driver_creation(self):
        argv = ['published_host_driver.py', '--source', '.', '--serial', 'emulator-5554',
                '--expected-apk-sha256', 'a' * 64, '--output', 'unused', '--unknown']
        with patch.object(sys, 'argv', argv), patch.object(phd, 'PublishedHostDriver') as driver:
            with self.assertRaises(SystemExit):
                phd.main()
            driver.assert_not_called()


if __name__ == '__main__':
    unittest.main()
