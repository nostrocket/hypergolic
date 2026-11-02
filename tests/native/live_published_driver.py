#!/usr/bin/env python3
"""Run the public-only live-published fixture on one explicit Android device."""
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

PACKAGE = 'org.nostrocket.hypergolic.livepublishedfixture'
NADDR = 'naddr1qvzqqqyf8ypzqfngzhsvjggdlgeycm96x4emzjlwf8dyyzdfg4hefp89zpkdgz99qqxxv6tvv5kkyun0waek2us8fz2v6'
PUBLISHER = '266815e0c9210dfa324c6cba3573b14bee49da4209a9456f9484e5106cd408a5'
EVENT = 'a3c01be3f0d75cd8ff758c78f71ab9446487f01b791f53ac141fce15d1214d0d'
APP_ID = 'file-browser'
PROBE_RESULT = 'Native relay and HTTPS artifact verified (56974 bytes)'


def has_id(node, identifier):
    value = node.get('resource-id', '')
    return value == identifier or value.endswith('/' + identifier)


class LivePublishedDriver(base.Driver):
    def __init__(self, args):
        if args.package != PACKAGE:
            raise CheckFailed('This driver is restricted to the disposable live-published fixture package')
        self.apk = Path(args.apk).resolve()
        if not self.apk.is_file():
            raise CheckFailed('Explicit APK path is not a file')
        self.apk_sha256 = hashlib.sha256(self.apk.read_bytes()).hexdigest()
        super().__init__(args)
        self.result['scope'] = 'Public-only live-published Android fixture; no key import, signing, or publication'
        self.result['fixture'] = {'naddr': NADDR, 'publisher': PUBLISHER, 'event': EVENT,
                                  'app': APP_ID, 'access': 'theme'}
        self.result['apk'] = {'path': str(self.apk), 'sha256': self.apk_sha256}

    def check(self, name, details):
        super().check(name, details)
        print('PASS ' + name, flush=True)

    def tap_id(self, identifier, description):
        _, nodes = self.nodes()
        self.tap(exactly_one(nodes, lambda n: has_id(n, identifier), description))

    def scroll_until(self, predicate, description):
        for _ in range(14):
            _, nodes = self.nodes()
            if any(predicate(n) for n in nodes):
                return nodes
            scrollables = [n for n in nodes if n.get('scrollable') == 'true']
            if not scrollables:
                raise CheckFailed('No observed scrollable native container while looking for ' + description)
            x1, y1, x2, y2 = base.node_bounds(scrollables[-1])
            x = (x1 + x2) // 2
            self.adb_run('shell', 'input', 'swipe', str(x), str(y1 + (y2-y1)*4//5),
                         str(x), str(y1 + (y2-y1)//3), '350')
        raise CheckFailed(description + ' was not reached by observed native scrolling')

    def verify_review(self, nodes):
        if not any(has_id(n, 'settings-napplet-review') for n in nodes):
            raise CheckFailed('First-open consent review is not visible')
        expected = ((PUBLISHER, 'publisher'), (APP_ID, 'napplet'), (EVENT, 'signed event'),
                    ('Requested access: theme', 'requested access'))
        for value, field in expected:
            if not any(label(n) == value for n in nodes):
                raise CheckFailed('Consent review did not show exact expected ' + field)
        return exactly_one(nodes, lambda n: has_id(n, 'settings-napplet-approve'),
                           'explicit Allow and open control')

    def run_scenario(self):
        if not re.fullmatch(r'[A-Za-z0-9_.]+', self.args.package):
            raise CheckFailed('Invalid Android package')
        if self.args.reset_fixture:
            if self.args.package != PACKAGE:
                raise CheckFailed('Refusing to reset a non-fixture package')
            self.adb_run('shell', 'pm', 'clear', PACKAGE)
            self.result['fixtureDataReset'] = True
        self.metadata()
        if self.result['app']['installedBaseApkSha256'] != self.apk_sha256:
            raise CheckFailed('Installed fixture APK does not match the explicit APK file SHA-256')
        self.result['app']['apkPathSha256Match'] = True
        launch = self.adb_run('shell', 'am', 'start', '-W', '-n', PACKAGE + '/org.nostrocket.hypergolic.dev.MainActivity')
        if 'Status: ok' not in launch:
            raise CheckFailed('Android did not report successful fixture launch')

        _, nodes = self.wait(lambda ns: any(has_id(n, 'live-fixture-probe') for n in ns),
                             'live-published fixture Probe native source control')
        address = exactly_one(nodes, lambda n: has_id(n, 'live-fixture-address'), 'public fixture naddr')
        if label(address).strip() != NADDR:
            raise CheckFailed('Fixture naddr differs from the pinned public candidate')
        self.capture('01-live-fixture')
        self.tap_id('live-fixture-probe', 'Probe native source')
        _, nodes = self.wait(lambda ns: any(
            has_id(n, 'live-fixture-probe-result') and
            (label(n) == PROBE_RESULT or ' failed:' in label(n)) for n in ns),
            'native relay and HTTPS probe outcome', timeout=150)
        outcome = label(exactly_one(nodes, lambda n: has_id(n, 'live-fixture-probe-result'),
                                    'native source probe result'))
        if outcome != PROBE_RESULT:
            raise CheckFailed('Native source probe reported ' + outcome)
        self.check('native-relay-https-artifact', PROBE_RESULT)
        self.capture('02-probe-verified')

        _, nodes = self.nodes()
        if not any(label(n) == 'Settings' for n in nodes):
            self.tap_id('shell-settings', 'trusted shell Settings control')
            _, nodes = self.wait(lambda ns: any(label(n) == 'Settings' for n in ns), 'trusted Settings')
        if not any(has_id(n, 'settings-full-npub') for n in nodes):
            _, nodes = self.nodes()
        self.scroll_until(lambda n: has_id(n, 'settings-napplet-address'), 'published naddr field')
        self.tap_id('settings-napplet-address', 'trusted Settings naddr field')
        self.adb_run('shell', 'input', 'text', NADDR)
        self.adb_run('shell', 'input', 'keyevent', '4')
        self.scroll_until(lambda n: has_id(n, 'settings-open-napplet'), 'Verify and open action')
        self.tap_id('settings-open-napplet', 'Verify and open public napplet')
        _, nodes = self.wait(lambda ns: any(has_id(n, 'settings-napplet-review') or
                                            has_id(n, 'settings-napplet-error') for n in ns),
                             'first-open review or explicit Settings error', timeout=150)
        if any(has_id(n, 'settings-napplet-error') for n in nodes):
            diagnostic = next((label(n) for n in nodes if has_id(n, 'live-fixture-open-diagnostic')),
                              'source stage unavailable')
            raise CheckFailed('Published Settings open failed before review: ' + diagnostic[:240])
        approve = self.verify_review(nodes)
        self.check('first-open-review-exact', {'publisher': PUBLISHER, 'event': EVENT,
                   'app': APP_ID, 'requestedAccess': 'theme', 'explicitApprovalRequired': True})
        self.capture('03-consent-review')
        self.tap(approve)
        _, nodes = self.wait(lambda ns: any(label(n) == 'Runtime connected' for n in ns),
                             'native published guest Runtime connected', timeout=90)
        self.check('guest-runtime-connected', 'Android hierarchy observed Runtime connected after explicit consent')
        self.capture('04-guest-connected')
        self.result['limitations'] = [
            'Fixture identity is public-only and its signing/publication paths fail closed.',
            'This emulator run does not prove production identity security, guest signing, filesystem access, or physical-device behavior.',
        ]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--package', required=True)
    parser.add_argument('--apk', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--adb')
    parser.add_argument('--timeout', type=float, default=30)
    parser.add_argument('--reset-fixture', action='store_true', help='Clear data only for the pinned disposable fixture package')
    args = parser.parse_args()
    args.scenario = 'live-published-fixture'
    args.launch = True
    driver = None
    try:
        driver = LivePublishedDriver(args)
        driver.run_scenario()
        driver.result['status'] = 'passed'
        return 0
    except Exception as exc:
        if driver:
            driver.result['status'] = 'failed'
            driver.result['error'] = str(exc)[:1200]
            try:
                driver.capture('failure')
            except Exception as capture_error:
                driver.result['captureError'] = str(capture_error)[:400]
        print('FAILED: ' + str(exc), file=sys.stderr)
        return 1
    finally:
        if driver:
            driver.result['finishedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
            (driver.out / 'result.json').write_text(json.dumps(driver.result, indent=2) + '\n')
            print(json.dumps({'status': driver.result['status'], 'checks': len(driver.result['checks']),
                              'result': str(driver.out / 'result.json')}))


if __name__ == '__main__':
    sys.exit(main())
