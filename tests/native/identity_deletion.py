#!/usr/bin/env python3
"""System-authenticated deletion on the explicitly named disposable Android auth emulator."""
import hashlib
import json
from pathlib import Path
import subprocess
import time
from identity_switch import IdentitySwitch
from identity_driver import main, require_equal, single_pid
from driver import parse_nodes

# Public fixture credential, ONLY for Hypergolic_Auth_API_36. Never use for a real device.
PUBLIC_TEST_PIN = '123456'

class IdentityDeletion(IdentitySwitch):
    scenario = 'identity-deletion'
    def system_nodes(self):
        self.driver.adb_run('shell', 'uiautomator', 'dump', '/sdcard/hypergolic-auth-system.xml')
        xml = self.driver.adb_run('exec-out', 'cat', '/sdcard/hypergolic-auth-system.xml', binary=True)
        rows = parse_nodes(xml)
        if not any(n.get('resource-id') == 'com.android.systemui:id/title' and n.get('text') == 'Delete saved identity' for n in rows):
            raise RuntimeError('Expected the actual system-owned identity deletion prompt')
        if self.package not in self.driver.adb_run('shell', 'dumpsys', 'activity', 'activities').split('topResumedActivity=')[-1].split('\n')[0]:
            raise RuntimeError('Authentication prompt lost its owning foreground activity')
        return xml, rows
    def system_capture(self, name):
        xml, _ = self.system_nodes()
        png = self.driver.adb_run('exec-out', 'screencap', '-p', binary=True)
        (self.driver.out / (name + '.xml')).write_bytes(xml)
        (self.driver.out / (name + '.png')).write_bytes(png)
        self.driver.result['captures'].append({'name': name, 'pngSha256': hashlib.sha256(png).hexdigest(), 'xmlSha256': hashlib.sha256(xml).hexdigest(), 'visuallyInspected': False, 'surface': 'Expected Android system authentication prompt'})
    def review(self, target):
        self.press('identity-delete-' + target)
    def prompt(self, target):
        self.review(target); self.press('identity-delete-confirm'); self.system_nodes()
    def inventory(self, selected, count, target_present):
        require_equal(selected, self.control('settings-full-npub')['text'], 'Selected identity')
        _, rows = self.driver.nodes()
        identities = [n for n in rows if n.get('resource-id', '').startswith('identity-select-')]
        require_equal(count, len(identities), 'Saved identity count')
        require_equal(target_present, any(n.get('resource-id') == 'identity-select-' + self.target for n in rows), 'Target identity membership')
        if any(n.get('resource-id') == 'identity-delete-' + self.original_key for n in rows):
            raise RuntimeError('Selected identity exposes deletion')
    def drafts(self, markers):
        for number, marker in markers.items():
            self.focus(number)
            if marker not in self.draft().get('text', ''): raise RuntimeError('Identity action destroyed a loaded napplet draft')
    def run(self):
        if self.package != 'org.nostrocket.hypergolic.identityfixture': raise RuntimeError('Requires isolated identity fixture')
        if self.adb('emu', 'avd', 'name').splitlines()[0] != 'Hypergolic_Auth_API_36': raise RuntimeError('Refuses credential changes outside the disposable authentication emulator')
        if self.adb('shell', 'getprop', 'ro.build.version.sdk') != '36': raise RuntimeError('This system UI driver requires its reviewed API 36 image')
        self.driver.result['scope'] = 'Isolated Android Release app, actual native main-runtime ownership, system PIN authentication, guarded protected-record erasure and real live napplet DOM.'
        self.driver.result['limitations'] = ['Public disposable scalar-2 key and public test PIN only.', 'No physical device, biometric enrollment, Android API 26-29 or iOS authentication claim.', 'No backup/reveal, signing or remote loading proof.']
        self.driver.result['firstLaunch'] = self.cold_launch()
        original = self.header()[1]
        fixture_script = Path(__file__).with_name('public-test-identity.mjs')
        fixture = json.loads(subprocess.check_output([self.driver.args.node, str(fixture_script)], text=True))
        self.target = fixture['pubkey']
        self.original_key = json.loads(subprocess.check_output([self.driver.args.node, str(fixture_script), original], text=True))['pubkey']
        if self.original_key == self.target: raise RuntimeError('Select the generated disposable identity before running')
        self.press('shell-settings')
        _, rows = self.driver.nodes()
        if not any(n.get('resource-id') == 'identity-select-' + self.target for n in rows):
            self.review_import(fixture['nsec']); self.press('identity-change-confirm'); self.press('shell-settings')
            self.press('identity-select-' + self.original_key); self.press('identity-change-confirm'); self.press('shell-settings')
        self.inventory(original, 2, True)
        # Changing only this named disposable emulator's known public credential is explicit test setup.
        self.driver.adb_run('shell', 'locksettings', 'clear', '--old', PUBLIC_TEST_PIN)
        self.review(self.target)
        message = self.control('identity-delete-unavailable')['text']
        if 'unavailable' not in message.lower(): raise RuntimeError('Expected unavailable device authentication')
        _, rows = self.driver.nodes()
        if any(n.get('resource-id') == 'identity-delete-confirm' for n in rows): raise RuntimeError('No-lock device permits confirmation')
        self.driver.capture('01-no-lock'); self.press('identity-delete-cancel'); self.inventory(original, 2, True)
        self.driver.check('no-lock-denies-and-selected-identity-has-no-delete', {'identities': 2, 'selectedNpub': original})
        self.driver.adb_run('shell', 'locksettings', 'set-pin', PUBLIC_TEST_PIN)
        self.press('settings-done')
        markers = {n: f'DeletionDraft{time.time_ns()}N{n}' for n in (1, 2, 3)}
        for n, marker in markers.items(): self.focus(n); self.input(self.draft(), marker)
        self.press('shell-settings'); self.review(self.target)
        require_equal(fixture['npub'], self.control('identity-delete-npub')['text'], 'Exact deletion review target')
        self.driver.capture('02-exact-review'); self.press('identity-delete-cancel'); self.inventory(original, 2, True)
        self.press('settings-done'); self.drafts(markers)
        self.driver.check('review-cancel-keeps-all-live-drafts', {'loadedNappletDrafts': 3})
        self.press('shell-settings'); self.prompt(self.target); self.system_capture('03-system-pin-cancel')
        self.adb('shell', 'input', 'keyevent', '4'); self.inventory(original, 2, True)
        self.driver.check('system-cancel-keeps-identity', {'identities': 2})
        self.prompt(self.target); self.system_capture('04-system-pin-background')
        self.adb('shell', 'input', 'keyevent', '3')
        self.adb('shell', 'am', 'start', '-W', '-n', self.package + '/' + self.driver.args.activity)
        self.inventory(original, 2, True)
        self.driver.check('background-revokes-system-authentication', {'identities': 2})
        self.prompt(self.target)
        self.driver.adb_run('shell', 'input', 'text', '000000'); self.adb('shell', 'input', 'keyevent', '66')
        _, rows = self.system_nodes()
        if not any('wrong' in (n.get('text', '') + n.get('content-desc', '')).lower() for n in rows): raise RuntimeError('System did not report the rejected test PIN')
        self.adb('shell', 'input', 'keyevent', '4'); self.inventory(original, 2, True)
        self.driver.check('wrong-pin-cannot-delete', {'identities': 2})
        self.prompt(self.target); started = time.monotonic()
        self.driver.wait(lambda ns: any(n.get('resource-id') == 'settings-full-npub' for n in ns), 'Native authentication timeout returns to Settings', timeout=75)
        elapsed = time.monotonic() - started
        if elapsed < 50 or elapsed > 75: raise RuntimeError('Unexpected authentication timeout interval')
        self.inventory(original, 2, True)
        self.driver.check('native-authentication-timeout', {'observedSeconds': elapsed, 'identities': 2})
        self.prompt(self.target); self.system_capture('05-system-pin-approve')
        self.actions.append({'operation': 'native-system-credential', 'publicFixture': True, 'masked': True})
        self.driver.adb_run('shell', 'input', 'text', PUBLIC_TEST_PIN); self.adb('shell', 'input', 'keyevent', '66')
        self.inventory(original, 1, False); self.driver.capture('06-identity-removed')
        self.press('settings-done'); self.drafts(markers)
        require_equal(original, self.header()[1], 'Identity after authenticated deletion')
        self.driver.capture('07-live-draft-after-delete')
        self.driver.check('pin-deletes-only-inactive-identity-and-preserves-live-drafts', {'identities': 1, 'loadedNappletDrafts': 3, 'selectedNpub': original})
        self.control('workspace-saved'); self.driver.result['secondLaunch'] = self.cold_launch()
        require_equal(original, self.header()[1], 'Selected identity after deletion restart')
        self.press('shell-settings'); self.inventory(original, 1, False); self.driver.capture('08-restarted-inventory')
        self.press('settings-done'); self.focused(3)
        self.driver.check('deletion-and-current-workspace-survive-restart', {'identities': 1, 'focusedNapplet': 'UX Lab 3'})
        self.driver.result['finalPid'] = single_pid(self.adb('shell', 'pidof', self.package))

if __name__ == '__main__': raise SystemExit(main(scenario_type=IdentityDeletion))
