#!/usr/bin/env python3
"""Public Android input proving saved workspace order, selected napplet and explicit empty restart."""
import re
import sys
from identity_driver import IdentityRestart, main, native_control, require_equal, require_new_pid, single_pid, validate_encoding


class WorkspaceRestart(IdentityRestart):
    scenario = 'workspace-restart'

    def control(self, identifier):
        def present(nodes):
            try:
                native_control(nodes, identifier, self.package)
                return True
            except RuntimeError:
                return False
        _, nodes = self.driver.wait(present, identifier)
        return native_control(nodes, identifier, self.package)

    def activate(self, identifier):
        self.tap(self.control(identifier), identifier)

    def saved(self):
        self.control('workspace-saved')

    def focused(self, expected):
        def matches(nodes):
            try:
                return native_control(nodes, 'focused-napplet-name', self.package).get('text') == expected
            except RuntimeError:
                return False
        self.driver.wait(matches, 'focused ' + expected)
        self.saved()

    def cards(self, expected):
        def identifiers(nodes):
            return [node['resource-id'].split('/')[-1].removeprefix('overview-card-') for node in nodes
                    if node.get('package') == self.package and node.get('_webview-depth') == 0
                    and re.fullmatch(r'overview-card-ux-lab-[1-9][0-9]*', node.get('resource-id', '').split('/')[-1])]
        _, nodes = self.driver.wait(lambda rows: identifiers(rows) == expected, 'exact workspace opening order')
        return identifiers(nodes)

    def run(self):
        self.driver.result['scope'] = 'Android controlled workspace through public native input and data-preserving restarts; no private key or saved napplet-string capability proof'
        self.driver.result['limitations'][0] = 'Workspace descriptor and public identity continuity only; no private-key usability, encrypted storage, authentication, import, backup, saved napplet-string capability or signing proof.'
        self.driver.result['firstLaunch'] = self.cold_launch()
        first = self.settings('01')
        self.focused('UX Lab 1')
        first_pid = single_pid(self.adb('shell', 'pidof', self.package))
        self.activate('handle-right')
        self.cards(['ux-lab-1', 'ux-lab-2', 'ux-lab-3'])
        self.activate('shell-settings')
        self.activate('settings-open-ux-lab')
        self.focused('UX Lab 4')
        self.driver.capture('02-new-focused')
        self.driver.result['secondLaunch'] = self.cold_launch()
        self.focused('UX Lab 4')
        second_pid = single_pid(self.adb('shell', 'pidof', self.package))
        require_new_pid(first_pid, second_pid)
        self.driver.capture('03-restored-focused')
        self.driver.check('selected-napplet-after-restart', {'title': 'UX Lab 4', 'firstPid': first_pid, 'secondPid': second_pid})
        self.activate('handle-right')
        expected = ['ux-lab-1', 'ux-lab-2', 'ux-lab-3', 'ux-lab-4']
        self.cards(expected)
        self.driver.capture('04-restored-order')
        self.driver.check('opening-order-after-restart', {'sessions': expected.copy()})
        while expected:
            self.activate('overview-close-' + expected[0])
            self.activate('close-confirm')
            expected.pop(0)
            self.cards(expected)
            self.saved()
        self.control('empty-open-napplet')
        self.driver.capture('05-empty-before-restart')
        self.driver.result['thirdLaunch'] = self.cold_launch()
        self.focused('Hypergolic')
        self.control('empty-open-napplet')
        self.cards([])
        third_pid = single_pid(self.adb('shell', 'pidof', self.package))
        require_new_pid(second_pid, third_pid)
        self.driver.capture('06-empty-after-restart')
        second = self.settings('07')
        require_equal(first, second, 'Public identity across workspace changes and restarts')
        observations = {'headerBefore': first['header'], 'settingsBefore': first['settings'],
                        'headerAfter': second['header'], 'settingsAfter': second['settings']}
        self.driver.result['identityObservations'] = observations
        self.driver.result['canonicalNpubValidation'] = validate_encoding(observations, self.driver.args.source, self.driver.args.node)
        self.driver.check('explicit-empty-after-restart', {'sessions': [], 'secondPid': second_pid, 'thirdPid': third_pid, 'identityUnchanged': True})
        self.driver.result['finalPid'] = third_pid


if __name__ == '__main__':
    sys.exit(main(scenario_type=WorkspaceRestart))
