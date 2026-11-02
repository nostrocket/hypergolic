"""Offline admission regressions. These tests do not represent native execution."""
import copy
import json
import sys
import unittest
from unittest.mock import patch
from driver import CheckFailed
import workspace_driver as wd


def overview_nodes():
    nodes = [{'text': 'Your napplets', 'bounds': '[10,20][290,60]'}]
    for index, title in enumerate(('UX Lab 1', 'UX Lab 2', 'UX Lab 3')):
        nodes.append({'content-desc': 'Open ' + title, 'bounds': f'[{10 + 100 * index},100][{90 + 100 * index},500]'})
    return nodes


def rows():
    values = []
    for index in range(3):
        values.append({'id': str(index), 'generation': 'generation-' + str(index),
                       'frameId': 'frame-' + str(index), 'contextUniqueId': 'context-' + str(index),
                       'description': json.dumps({'attached': True, 'empty': False, 'visible': index == 0,
                                                  'screenX': 10, 'screenY': 50, 'width': 100, 'height': 600}),
                       'snapshot': {'counter': str(index + 1), 'draft': 'draft-' + str(index),
                                    'mirror': 'draft-' + str(index), 'selected': '04', 'edge': 'None',
                                    'scroll': {'x': 0, 'y': 100, 'rail': 40}}})
    return values


class RecordedInputs(wd.WorkspaceDriver):
    """Exercise admission control flow without invoking ADB or a browser."""
    def __init__(self):
        self.values = rows()
        self.observations = [copy.deepcopy(self.values) for _ in range(3)]
        self.bindings = {'UX Lab 1': wd.identity(self.values[0])}
        self.nodes_after = overview_nodes()
        self.density = 'Physical density: 420'
        self.actions = []
        self.checks = []
    def correlate(self, title): self.actions.append(('correlate', title))
    def observe(self): return self.observations.pop(0)
    def overview(self): return overview_nodes()
    def adb_run(self, *args):
        if args != ('shell', 'wm', 'density'): raise AssertionError('Unexpected device command')
        return self.density
    def swipe(self, points, duration): self.actions.append(('swipe', points, duration))
    def wait(self, predicate, description, **kwargs):
        if not predicate(self.nodes_after): raise CheckFailed(description)
        return None, self.nodes_after
    def capture(self, name): self.actions.append(('capture', name))
    def open_card(self, title): self.actions.append(('tap', title))
    def focused(self, title): return {'title': title, 'webViewBounds': (10, 50, 110, 650)}, []
    def check(self, name, details): self.checks.append(name)


class ShortCardTests(unittest.TestCase):
    def test_density_prefers_override_independent_of_output_order(self):
        bounds = (10, 100, 200, 600)
        for text in ('Physical density: 420\nOverride density: 320', 'Override density: 320\nPhysical density: 420'):
            stroke = wd.short_card_stroke(bounds, text)
            self.assertEqual(stroke['travelNativePixels'], 40)
            self.assertEqual(stroke['durationMs'], 13)
        self.assertEqual(wd.short_card_stroke(bounds, 'Physical density: 420')['travelNativePixels'], 52)

    def test_invalid_density_and_clipped_stroke_rejected(self):
        for text in ('', 'Physical density: 0', 'Physical density: 420\nOverride density: invalid',
                     'Physical density: 420\nPhysical density: 320'):
            with self.subTest(text=text), self.assertRaises(CheckFailed):
                wd.short_card_stroke((10, 100, 200, 600), text)
        with self.assertRaises(CheckFailed): wd.short_card_stroke((10, 100, 30, 120), 'Physical density: 420')

    def test_retained_overview_rejects_warning_focus_duplicate_or_missing_card(self):
        self.assertEqual(len(wd.retained_overview_cards(overview_nodes())), 3)
        variants = []
        warning = overview_nodes(); warning.append({'resource-id': 'close-confirm'})
        variants.append(warning)
        focused = overview_nodes(); focused.append({'content-desc': 'Right napplet handle'})
        variants.append(focused)
        duplicate = overview_nodes(); duplicate.append(copy.deepcopy(duplicate[-1]))
        variants.extend((duplicate, overview_nodes()[:-1]))
        for nodes in variants:
            with self.assertRaises(CheckFailed): wd.retained_overview_cards(nodes)

    def test_scenario_preserves_states_then_verifies_ordinary_tap_binding(self):
        runner = RecordedInputs(); runner.card_cancel()
        self.assertIn(('swipe', (50, 300, 50, 248), 13), runner.actions)
        self.assertEqual(runner.checks, ['short-card-stroke-keeps-overview', 'ordinary-card-tap-still-opens'])
        self.assertEqual(len(runner.observations), 0)

    def test_changed_context_or_draft_cannot_pass_rejected_stroke(self):
        for field in ('contextUniqueId', 'draft'):
            runner = RecordedInputs()
            if field == 'draft': runner.observations[1][1]['snapshot']['draft'] = 'changed'
            else: runner.observations[1][0][field] = 'replacement'
            with self.assertRaises(CheckFailed): runner.card_cancel()
            self.assertNotIn(('tap', 'UX Lab 1'), runner.actions)
            self.assertEqual(runner.checks, [])

    def test_ordinary_tap_cannot_pass_wrong_visible_runtime(self):
        runner = RecordedInputs()
        for index, row in enumerate(runner.observations[2]):
            desc = json.loads(row['description']); desc['visible'] = index == 1
            row['description'] = json.dumps(desc)
        with self.assertRaises(CheckFailed): runner.card_cancel()
        self.assertNotIn('ordinary-card-tap-still-opens', runner.checks)

    def test_unknown_scenario_rejected_before_driver_creation(self):
        argv = ['workspace_driver.py', '--source', '.', '--serial', 'explicit-test-device',
                '--expected-apk-sha256', 'a' * 64, '--output', 'unused', 'unknown']
        with patch.object(sys, 'argv', argv), patch.object(wd, 'WorkspaceDriver') as driver:
            with self.assertRaises(SystemExit): wd.main()
            driver.assert_not_called()

    def test_combined_scenario_runs_short_probe_before_existing_navigation(self):
        runner = RecordedInputs()
        with patch.object(runner, 'card_cancel') as short, patch.object(runner, 'navigation_close') as rest:
            events = []; short.side_effect = lambda: events.append('short'); rest.side_effect = lambda: events.append('rest')
            runner.card_cancel_and_navigation_close()
            self.assertEqual(events, ['short', 'rest'])
        with patch.object(runner, 'card_cancel', side_effect=CheckFailed('failed')), patch.object(runner, 'navigation_close') as rest:
            with self.assertRaises(CheckFailed): runner.card_cancel_and_navigation_close()
            rest.assert_not_called()


if __name__ == '__main__': unittest.main()
