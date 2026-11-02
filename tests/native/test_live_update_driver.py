"""Protect exact review assertions in the live network update driver."""
import unittest

from driver import CheckFailed
from live_update_driver import LiveUpdateDriver

SESSION = '123e4567-e89b-42d3-a456-426614174000'
FIXTURE = {'publisher': 'a' * 64, 'identifier': 'hg-update-qa', 'v1': 'b' * 64, 'v2': 'c' * 64}


def node(value, identifier=''):
    return {'content-desc': value, 'resource-id': identifier, 'bounds': '[0,0][100,100]'}


class LiveUpdateDriverTests(unittest.TestCase):
    def setUp(self):
        self.driver = LiveUpdateDriver.__new__(LiveUpdateDriver)
        self.driver.fixture = dict(FIXTURE)

    def test_first_open_requires_exact_publisher_event_and_theme(self):
        nodes = [node(FIXTURE['publisher']), node(FIXTURE['identifier']), node(FIXTURE['v1']),
                 node('Requested access: theme'), node('Allow and open', 'settings-napplet-approve')]
        self.assertEqual(self.driver.check_review(nodes, update=False), nodes[-1])
        with self.assertRaises(CheckFailed):
            self.driver.check_review(nodes[:2] + nodes[3:], update=False)

    def test_update_requires_both_exact_events_and_session_scoped_review(self):
        nodes = [node(FIXTURE['publisher']), node(FIXTURE['identifier']), node(FIXTURE['v1']),
                 node(FIXTURE['v2']), node('Requested access: theme'),
                 node('Use this verified update?', 'published-update-review-' + SESSION)]
        self.assertEqual(self.driver.check_review(nodes, update=True), SESSION)
        with self.assertRaises(CheckFailed):
            self.driver.check_review(nodes[:3] + nodes[4:], update=True)
        with self.assertRaises(CheckFailed):
            self.driver.check_review(nodes + [nodes[-1]], update=True)


if __name__ == '__main__':
    unittest.main()
