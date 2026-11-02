#!/usr/bin/env python3
"""Real BiometricPrompt callbacks on the disposable Android authentication emulator."""
import json
from pathlib import Path
import subprocess
import time
from identity_deletion import IdentityDeletion
from identity_driver import main, require_equal, single_pid

class IdentityBiometric(IdentityDeletion):
    scenario = 'identity-biometric'
    def run(self):
        if self.package != 'org.nostrocket.hypergolic.identityfixture': raise RuntimeError('Requires isolated identity fixture')
        if self.adb('emu', 'avd', 'name').splitlines()[0] != 'Hypergolic_Auth_API_36': raise RuntimeError('Requires the disposable authentication emulator')
        if self.adb('shell', 'getprop', 'ro.build.version.sdk') != '36': raise RuntimeError('Requires the reviewed API 36 image')
        self.driver.result['scope'] = 'Actual Android BiometricPrompt and protected-record erasure in the isolated Release app; enrolled virtual fingerprint 1 and unrecognised virtual fingerprint 2.'
        self.driver.result['limitations'] = ['Emulated sensor and public disposable scalar-2 import key; no physical biometric hardware claim.', 'No iOS authentication, Android API 26-29, backup, signing or remote loading proof.']
        self.driver.result['firstLaunch'] = self.cold_launch()
        original = self.header()[1]
        script = Path(__file__).with_name('public-test-identity.mjs')
        fixture = json.loads(subprocess.check_output([self.driver.args.node, str(script)], text=True))
        self.target = fixture['pubkey']
        self.original_key = json.loads(subprocess.check_output([self.driver.args.node, str(script), original], text=True))['pubkey']
        if self.original_key == self.target: raise RuntimeError('Select the generated disposable identity before running')
        self.press('shell-settings')
        _, rows = self.driver.nodes()
        if not any(n.get('resource-id') == 'identity-select-' + self.target for n in rows):
            self.review_import(fixture['nsec']); self.press('identity-change-confirm'); self.press('shell-settings')
            self.press('identity-select-' + self.original_key); self.press('identity-change-confirm'); self.press('shell-settings')
        self.inventory(original, 2, True); self.press('settings-done')
        markers = {n: f'BiometricDraft{time.time_ns()}N{n}' for n in (1, 2, 3)}
        for n, marker in markers.items(): self.focus(n); self.input(self.draft(), marker)
        self.press('shell-settings'); self.prompt(self.target)
        self.adb('emu', 'finger', 'touch', '2')
        _, rows = self.system_nodes()
        if not any('not recognised' in n.get('text', '').lower() or 'not recognized' in n.get('text', '').lower() for n in rows):
            raise RuntimeError('System did not report an unrecognised fingerprint')
        self.system_capture('01-fingerprint-rejected')
        self.adb('emu', 'finger', 'remove'); self.adb('shell', 'input', 'keyevent', '4')
        self.inventory(original, 2, True)
        self.driver.check('wrong-fingerprint-and-system-cancel-keep-identity', {'identities': 2})
        self.prompt(self.target); self.adb('shell', 'input', 'keyevent', '3')
        self.adb('emu', 'finger', 'touch', '1'); self.adb('emu', 'finger', 'remove')
        self.adb('shell', 'am', 'start', '-W', '-n', self.package + '/' + self.driver.args.activity)
        self.inventory(original, 2, True)
        self.driver.check('background-revokes-biometric-request', {'identities': 2})
        self.prompt(self.target); self.system_capture('02-fingerprint-approve')
        self.adb('emu', 'finger', 'touch', '1'); self.adb('emu', 'finger', 'remove')
        self.inventory(original, 1, False); self.driver.capture('03-biometric-identity-removed')
        self.press('settings-done'); self.drafts(markers)
        require_equal(original, self.header()[1], 'Identity after fingerprint-authenticated deletion')
        self.driver.capture('04-biometric-live-draft')
        self.driver.check('fingerprint-deletes-only-inactive-identity-and-preserves-live-drafts', {'identities': 1, 'loadedNappletDrafts': 3, 'selectedNpub': original})
        self.control('workspace-saved'); self.driver.result['secondLaunch'] = self.cold_launch()
        require_equal(original, self.header()[1], 'Selected identity after restart')
        self.press('shell-settings'); self.inventory(original, 1, False); self.driver.capture('05-biometric-restarted-inventory')
        self.press('settings-done'); self.focused(3)
        self.driver.check('biometric-deletion-survives-restart', {'identities': 1, 'focusedNapplet': 'UX Lab 3'})
        self.driver.result['finalPid'] = single_pid(self.adb('shell', 'pidof', self.package))

if __name__ == '__main__': raise SystemExit(main(scenario_type=IdentityBiometric))
