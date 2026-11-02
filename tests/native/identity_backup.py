#!/usr/bin/env python3
"""Actual Android fingerprint backup journey on the named disposable API 36 fixture.

The test never prints, stores, decodes, or extracts the disposable private key.
It relies on the existing identity driver to seal the selected source tree and
installed APK before and after the journey.
"""
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import zlib
import re
import sys
import time

from driver import node_bounds, parse_nodes
from identity_biometric import IdentityBiometric
from identity_driver import main, native_control, require_equal, single_pid


class IdentityBackup(IdentityBiometric):
    scenario = 'identity-backup'
    NSEC = re.compile(r'nsec1[023456789acdefghjklmnpqrstuvwxyz]{58}', re.IGNORECASE)
    SCALAR = re.compile(r'(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])', re.IGNORECASE)

    def native_text(self, value):
        expected = value.casefold()
        _, rows = self.driver.wait(lambda nodes: any(node.get('package') == self.package
            and node.get('_webview-depth') == 0 and node.get('text', '').casefold() == expected for node in nodes), value)
        found = [node for node in rows if node.get('package') == self.package
                 and node.get('_webview-depth') == 0 and node.get('text', '').casefold() == expected]
        if len(found) != 1:
            raise RuntimeError('Expected exactly one native backup control: ' + value)
        node_bounds(found[0])
        return found[0]

    def backup_control(self, identifier):
        for _ in range(10):
            _, rows = self.driver.nodes()
            found = [node for node in rows if node.get('resource-id', '').split('/')[-1] == identifier]
            if len(found) == 1:
                return native_control(rows, identifier, self.package)
            if len(found) > 1:
                raise RuntimeError('Expected one backup control: ' + identifier)
            scrolls = [node for node in rows if node.get('package') == self.package
                       and node.get('class') == 'android.widget.ScrollView' and node.get('scrollable') == 'true']
            if len(scrolls) != 1:
                raise RuntimeError('Backup control is below Settings but no native Settings scroll view is available')
            x1, y1, x2, y2 = node_bounds(scrolls[0])
            self.adb('shell', 'input', 'swipe', str((x1 + x2) // 2), str(y1 + (y2 - y1) * 4 // 5),
                     str((x1 + x2) // 2), str(y1 + (y2 - y1) // 4), '350')
        raise RuntimeError('Backup control was not reachable by Settings scrolling: ' + identifier)

    def scroll_settings_to_top(self):
        for _ in range(5):
            _, rows = self.driver.nodes()
            scrolls = [node for node in rows if node.get('package') == self.package
                       and node.get('class') == 'android.widget.ScrollView' and node.get('scrollable') == 'true']
            if len(scrolls) != 1: raise RuntimeError('Native Settings scroll view is unavailable')
            x1, y1, x2, y2 = node_bounds(scrolls[0])
            self.adb('shell', 'input', 'swipe', str((x1 + x2) // 2), str(y1 + (y2 - y1) // 4),
                     str((x1 + x2) // 2), str(y1 + (y2 - y1) * 4 // 5), '350')

    def backup_review(self):
        self.tap(self.backup_control('identity-backup-start'), 'identity-backup-start')

    def backup_prompt(self):
        self.backup_review()
        review = self.control('identity-backup-npub')
        require_equal(self.fixture['npub'], review.get('text'), 'Exact selected backup review identity')
        self.press('identity-backup-confirm')
        self.system_nodes()

    def system_nodes(self):
        self.driver.adb_run('shell', 'uiautomator', 'dump', '/sdcard/hypergolic-backup-system.xml')
        xml = self.driver.adb_run('exec-out', 'cat', '/sdcard/hypergolic-backup-system.xml', binary=True)
        rows = parse_nodes(xml)
        if not any(node.get('resource-id') == 'com.android.systemui:id/title' and node.get('text') == 'Back up identity' for node in rows):
            raise RuntimeError('Expected the actual system-owned backup authentication prompt')
        if self.package not in self.driver.adb_run('shell', 'dumpsys', 'activity', 'activities').split('topResumedActivity=')[-1].split('\n')[0]:
            raise RuntimeError('Backup authentication prompt lost its owning foreground activity')
        return rows

    def inventory(self, count):
        self.scroll_settings_to_top()
        require_equal(self.fixture['npub'], self.control('settings-full-npub').get('text'), 'Selected backup identity in Settings')
        _, rows = self.driver.nodes()
        identities = [node for node in rows if node.get('resource-id', '').split('/')[-1].startswith('identity-select-')]
        require_equal(count, len(identities), 'Saved identity count')

    def secure_capture(self, name, panel_bounds):
        png = self.driver.adb_run('exec-out', 'screencap', '-p', binary=True)
        if not png.startswith(b'\x89PNG\r\n\x1a\n'):
            raise RuntimeError('FLAG_SECURE screenshot was not a PNG')
        self.assert_redacted(png, panel_bounds)
        (self.driver.out / (name + '.png')).write_bytes(png)
        self.driver.result['captures'].append({'name': name, 'pngSha256': hashlib.sha256(png).hexdigest(),
            'visuallyInspected': False, 'surface': 'ADB screenshot of FLAG_SECURE native backup panel; panel bounds are required to be redacted'})

    @staticmethod
    def assert_redacted(png, bounds):
        offset, width, height, colour, data = 8, None, None, None, bytearray()
        while offset < len(png):
            length = struct.unpack('>I', png[offset:offset + 4])[0]
            kind, value = png[offset + 4:offset + 8], png[offset + 8:offset + 8 + length]
            offset += 12 + length
            if kind == b'IHDR':
                width, height, depth, colour, compression, filtering, interlace = struct.unpack('>IIBBBBB', value)
                if depth != 8 or compression != 0 or filtering != 0 or interlace != 0 or colour not in (2, 6):
                    raise RuntimeError('Unsupported Android screenshot format for FLAG_SECURE inspection')
            elif kind == b'IDAT': data.extend(value)
            elif kind == b'IEND': break
        if width is None or height is None: raise RuntimeError('PNG lacks an image header')
        channels = 4 if colour == 6 else 3
        raw, prior, rows = zlib.decompress(data), bytearray(width * channels), []
        position = 0
        for _ in range(height):
            filter_type, current = raw[position], bytearray(raw[position + 1:position + 1 + width * channels])
            position += 1 + width * channels
            for index in range(len(current)):
                left = current[index - channels] if index >= channels else 0
                up = prior[index]
                upper_left = prior[index - channels] if index >= channels else 0
                if filter_type == 1: current[index] = (current[index] + left) & 255
                elif filter_type == 2: current[index] = (current[index] + up) & 255
                elif filter_type == 3: current[index] = (current[index] + ((left + up) // 2)) & 255
                elif filter_type == 4:
                    candidate = left + up - upper_left
                    distances = (abs(candidate - left), abs(candidate - up), abs(candidate - upper_left))
                    current[index] = (current[index] + (left if distances[0] <= distances[1] and distances[0] <= distances[2] else up if distances[1] <= distances[2] else upper_left)) & 255
                elif filter_type != 0: raise RuntimeError('Unsupported PNG row filter for FLAG_SECURE inspection')
            rows.append(current); prior = current
        x1, y1, x2, y2 = node_bounds({'bounds': bounds})
        x1, y1, x2, y2 = max(0, x1), max(0, y1), min(width, x2), min(height, y2)
        if x2 <= x1 or y2 <= y1: raise RuntimeError('Native backup bounds fall outside screenshot')
        for y in range(y1, y2, max(1, (y2 - y1) // 20)):
            for x in range(x1, x2, max(1, (x2 - x1) // 20)):
                pixel = rows[y][x * channels:x * channels + 3]
                if any(value > 4 for value in pixel):
                    raise RuntimeError('FLAG_SECURE capture contains non-redacted backup-panel pixels')

    def assert_no_secret_accessibility(self):
        _, rows = self.driver.nodes()
        for node in rows:
            if node.get('package') != self.package or node.get('_webview-depth') != 0: continue
            visible = (node.get('text', '') + ' ' + node.get('content-desc', '')).lower()
            if self.NSEC.search(visible) or self.SCALAR.search(visible):
                raise RuntimeError('Native backup accessibility exposes a private-key-shaped value')

    def run(self):
        if self.package != 'org.nostrocket.hypergolic.identityfixture': raise RuntimeError('Requires isolated identity fixture')
        if self.adb('emu', 'avd', 'name').splitlines()[0] != 'Hypergolic_Auth_API_36': raise RuntimeError('Requires the disposable authentication emulator')
        if self.adb('shell', 'getprop', 'ro.build.version.sdk') != '36': raise RuntimeError('Requires the reviewed API 36 image')
        self.driver.result['scope'] = 'Actual Android BiometricPrompt and FLAG_SECURE native backup panel in the isolated Release app; enrolled virtual fingerprint 1 and unrecognised virtual fingerprint 2.'
        self.driver.result['limitations'] = ['Public disposable fixture only; no real identity or physical biometric hardware.', 'ADB screenshot redaction is verified structurally and still requires later visual inspection of the archived PNG.', 'No iOS backup, signing, remote loading or physical-device claim.']
        self.driver.result['firstLaunch'] = self.cold_launch()
        fixture_script = Path(__file__).with_name('public-test-identity.mjs')
        self.fixture = json.loads(subprocess.check_output([self.driver.args.node, str(fixture_script)], text=True))
        target = self.fixture['pubkey']
        self.press('shell-settings')
        _, rows = self.driver.nodes()
        if not any(node.get('resource-id') == 'identity-select-' + target for node in rows):
            self.review_import(self.fixture['nsec']); self.press('identity-change-confirm')
            require_equal(self.fixture['npub'], self.header()[1], 'Imported disposable backup identity')
            self.press('shell-settings')
        self.scroll_settings_to_top()
        if self.control('settings-full-npub').get('text') != self.fixture['npub']:
            self.press('identity-select-' + target); self.press('identity-change-confirm'); self.press('shell-settings')
            self.scroll_settings_to_top()
        require_equal(self.fixture['npub'], self.control('settings-full-npub').get('text'), 'Selected disposable backup identity')
        self.backup_control('identity-backup-start')
        self.backup_review()
        require_equal(self.fixture['npub'], self.control('identity-backup-npub').get('text'), 'Exact backup review target')
        self.driver.capture('01-exact-backup-review')
        self.press('identity-backup-cancel'); self.inventory(2)
        self.driver.check('cancelled-backup-review-keeps-selected-identity-and-inventory', {'identities': 2, 'selectedNpub': self.fixture['npub']})
        self.backup_prompt(); self.adb('shell', 'input', 'keyevent', '4'); self.press('identity-backup-cancel'); self.inventory(2)
        self.driver.check('system-cancel-keeps-backup-identity-and-inventory', {'identities': 2})
        self.backup_prompt(); self.adb('emu', 'finger', 'touch', '2')
        rows = self.system_nodes()
        if not any('not recognised' in (node.get('text', '') + node.get('content-desc', '')).lower() or 'not recognized' in (node.get('text', '') + node.get('content-desc', '')).lower() for node in rows):
            raise RuntimeError('System did not report an unrecognised fingerprint')
        self.adb('emu', 'finger', 'remove'); self.adb('shell', 'input', 'keyevent', '4'); self.press('identity-backup-cancel'); self.inventory(2)
        self.driver.check('unrecognised-fingerprint-denies-backup', {'identities': 2})
        self.backup_prompt(); self.adb('shell', 'input', 'keyevent', '3')
        self.adb('shell', 'am', 'start', '-W', '-n', self.package + '/' + self.driver.args.activity)
        self.inventory(2)
        self.driver.check('background-revokes-backup-authentication', {'identities': 2})
        self.backup_prompt(); self.adb('emu', 'finger', 'touch', '1'); self.adb('emu', 'finger', 'remove')
        heading = self.native_text('Write down your private key')
        hide = self.native_text('Hide private key')
        hx1, hy1, hx2, _ = node_bounds(heading)
        bx1, _, bx2, by2 = node_bounds(hide)
        panel_bounds = f'[{min(hx1, bx1)},{hy1}][{max(hx2, bx2)},{by2}]'
        self.assert_no_secret_accessibility(); self.secure_capture('02-flag-secure-backup-panel', panel_bounds)
        self.driver.check('native-backup-panel-is-accessible-and-flag-secure-redacted', {'heading': 'Write down your private key', 'hideButton': 'Hide private key'})
        self.tap(self.native_text('Hide private key'), 'hide-private-key')
        self.control('settings-full-npub')
        self.backup_prompt(); self.adb('emu', 'finger', 'touch', '1'); self.adb('emu', 'finger', 'remove')
        self.native_text('Write down your private key')
        self.adb('shell', 'input', 'keyevent', '3')
        self.adb('shell', 'am', 'start', '-W', '-n', self.package + '/' + self.driver.args.activity)
        _, rows = self.driver.nodes()
        if any(node.get('text', '').casefold() in ('write down your private key', 'hide private key') for node in rows):
            raise RuntimeError('Backgrounded native backup reveal remained visible')
        self.backup_prompt(); self.system_nodes(); self.adb('shell', 'input', 'keyevent', '4'); self.press('identity-backup-cancel')
        self.inventory(2)
        self.driver.check('backgrounded-reveal-clears-and-resume-requires-fresh-authentication', {'identities': 2})
        self.press('settings-done')
        require_equal(self.fixture['npub'], self.header()[1], 'Final selected backup identity')
        self.driver.result['finalPid'] = single_pid(self.adb('shell', 'pidof', self.package))


class IdentityBackupPinTimeout(IdentityBackup):
    """Standalone public-fixture PIN and native-reveal expiry acceptance journey."""
    scenario = 'identity-backup-pin-timeout'
    PUBLIC_SCALAR_2_NPUB = 'npub1ccz8l9zpa47k6vz9gphftsrumpw80rjt3nhnefat4symjhrsnmjs38mnyd'

    def backup_prompt(self):
        self.backup_review()
        require_equal(self.selected_npub, self.control('identity-backup-npub').get('text'), 'Exact selected backup review identity')
        self.press('identity-backup-confirm')
        self.system_nodes()

    def inventory(self, count):
        self.scroll_settings_to_top()
        require_equal(self.selected_npub, self.control('settings-full-npub').get('text'), 'Selected backup identity in Settings')
        _, rows = self.driver.nodes()
        identities = [node for node in rows if node.get('resource-id', '').split('/')[-1].startswith('identity-select-')]
        require_equal(count, len(identities), 'Saved identity count')

    def use_pin(self):
        rows = self.system_nodes()
        choices = [node for node in rows if node.get('package') == 'com.android.systemui'
                   and 'use pin' in (node.get('text', '') + ' ' + node.get('content-desc', '')).casefold()]
        if len(choices) != 1: raise RuntimeError('Expected one actual system PIN fallback control')
        self.tap(choices[0], 'system-use-pin')
        # The credential screen is owned entirely by System UI, so the base
        # application's hierarchy guard intentionally cannot observe this step.
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            self.driver.adb_run('shell', 'uiautomator', 'dump', '/sdcard/hypergolic-backup-pin.xml')
            xml = self.driver.adb_run('exec-out', 'cat', '/sdcard/hypergolic-backup-pin.xml', binary=True)
            pin_rows = [node for node in parse_nodes(xml) if node.get('package') == 'com.android.systemui'
                        and node.get('password') == 'true' and node.get('enabled') == 'true']
            if len(pin_rows) == 1:
                node_bounds(pin_rows[0])
                return
            time.sleep(0.2)
        raise RuntimeError('Expected one actual System UI PIN field after the owned backup prompt')

    def run(self):
        if self.package != 'org.nostrocket.hypergolic.identityfixture': raise RuntimeError('Requires isolated identity fixture')
        if self.adb('emu', 'avd', 'name').splitlines()[0] != 'Hypergolic_Auth_API_36': raise RuntimeError('Requires the disposable authentication emulator')
        if self.adb('shell', 'getprop', 'ro.build.version.sdk') != '36': raise RuntimeError('Requires the reviewed API 36 image')
        self.driver.result['scope'] = 'Actual Android system PIN backup authentication and native backup-reveal timeout in the isolated public fixture.'
        self.driver.result['limitations'] = ['Public fixture PIN only; no real identity, physical device, or biometric claim.', 'The private key is never printed, stored, decoded, extracted, or read from accessibility.', 'No iOS, signing, relay, or restore claim.']
        self.driver.result['firstLaunch'] = self.cold_launch()
        self.press('shell-settings')
        self.scroll_settings_to_top()
        self.selected_npub = self.control('settings-full-npub').get('text')
        require_equal(self.PUBLIC_SCALAR_2_NPUB, self.selected_npub, 'Selected public scalar-2 identity')
        self.inventory(2)
        self.backup_prompt(); self.use_pin()
        self.actions.append({'operation': 'native-system-credential', 'publicFixture': True, 'masked': True})
        started = time.monotonic()
        self.adb('shell', 'input', 'text', '123456'); self.adb('shell', 'input', 'keyevent', '66')
        heading = self.native_text('Write down your private key'); hide = self.native_text('Hide private key')
        hx1, hy1, hx2, _ = node_bounds(heading); bx1, _, bx2, by2 = node_bounds(hide)
        self.assert_no_secret_accessibility(); self.secure_capture('01-pin-native-reveal-redacted', f'[{min(hx1, bx1)},{hy1}][{max(hx2, bx2)},{by2}]')
        self.driver.check('system-pin-authentication-opens-protected-native-reveal', {'heading': 'Write down your private key', 'hideButton': 'Hide private key'})
        self.driver.wait(lambda nodes: any(node.get('resource-id', '').split('/')[-1] == 'settings-full-npub' for node in nodes),
                         'native backup reveal timeout returns to Settings', timeout=75)
        elapsed = time.monotonic() - started
        if elapsed < 50 or elapsed > 75: raise RuntimeError('Unexpected native backup reveal timeout interval')
        self.inventory(2)
        self.driver.check('native-backup-reveal-auto-dismisses', {'observedSeconds': elapsed, 'identities': 2})
        self.backup_prompt(); self.system_nodes(); self.adb('shell', 'input', 'keyevent', '4'); self.press('identity-backup-cancel'); self.inventory(2)
        self.driver.check('post-timeout-backup-requires-fresh-system-authentication', {'identities': 2})
        self.press('settings-done')
        require_equal(self.selected_npub, self.header()[1], 'Final selected backup identity')
        self.driver.result['finalPid'] = single_pid(self.adb('shell', 'pidof', self.package))


if __name__ == '__main__':
    pin_timeout = '--pin-timeout' in sys.argv
    if pin_timeout: sys.argv.remove('--pin-timeout')
    raise SystemExit(main(scenario_type=IdentityBackupPinTimeout if pin_timeout else IdentityBackup))
