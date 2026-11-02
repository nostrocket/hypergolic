#!/usr/bin/env python3
"""Observe ordinary-production NIP55 account controls using two owned disposable APKs; no signing/publication claim."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[5]
PACKAGE = 'org.nostrocket.hypergolic.signercore.bridgeproof'
PROVIDER = 'org.nostrocket.hypergolic.signercore.nip55fixture'
ACTIVITY = PACKAGE + '/org.nostrocket.hypergolic.dev.MainActivity'
REMOTE_XML = '/data/local/tmp/hg-nip55-production.xml'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app-build', type=Path, required=True)
    parser.add_argument('--provider', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--serial', default='emulator-5554')
    parser.add_argument('--state-data', action='store_true', help='Observe focused State Lab data continuity across signing-method transitions')
    args = parser.parse_args()
    if not re.fullmatch(r'emulator-[0-9]+', args.serial): parser.error('Owned emulator required')
    app_build, provider_build, out = args.app_build.resolve(), args.provider.resolve(), args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    app_receipt, provider_receipt = app_build / 'build.json', provider_build / 'build.json'
    seal, provider = json.loads(app_receipt.read_text()), json.loads(provider_receipt.read_text())
    if seal.get('entry') != 'index.ts' or seal.get('package') != PACKAGE or not seal.get('sources'):
        raise RuntimeError('Sealed ordinary entry and owned application ID required')
    if provider.get('status') != 'passed' or provider.get('sourceAfter') != provider.get('sourceBefore') or provider.get('package') != PROVIDER or PACKAGE not in provider.get('clients', []):
        raise RuntimeError('Reviewed independent provider with exact allowed client required')
    # Locate products by sealed bytes, never select an arbitrary APK from a build directory.
    def product(folder, expected):
        candidates = [p for p in folder.glob('*.apk') if digest(p) == expected]
        if len(candidates) != 1: raise RuntimeError('One exact sealed APK required')
        return candidates[0]
    apk, provider_apk = product(app_build, seal['apkSha256']), product(provider_build, provider['apkSha256'])
    observer_hash, app_receipt_hash, provider_receipt_hash = digest(Path(__file__)), digest(app_receipt), digest(provider_receipt)
    adb = [ROOT / '.tools/android-sdk/platform-tools/adb', '-s', args.serial]
    env = dict(os.environ, PATH=str(ROOT / '.tools/node/bin') + os.pathsep + os.environ.get('PATH', ''))
    def run(command, timeout=30):
        return subprocess.check_output([str(x) for x in command], env=env, text=True, stderr=subprocess.STDOUT, timeout=timeout)
    def verify_sources():
        if digest(Path(__file__)) != observer_hash or digest(app_receipt) != app_receipt_hash or digest(provider_receipt) != provider_receipt_hash:
            raise RuntimeError('Observer or build receipt changed')
        if digest(apk) != seal['apkSha256'] or digest(provider_apk) != provider['apkSha256']:
            raise RuntimeError('Sealed product changed')
        for name, expected in seal['sources'].items():
            if digest(ROOT / name) != expected or digest(app_build / 'source-snapshot' / name) != expected:
                raise RuntimeError('Production input/current/archive differs: ' + name)
        for name, expected in provider['sourceBefore'].items():
            if digest(provider_build / 'source-snapshot' / name) != expected:
                raise RuntimeError('Pinned provider source archive differs: ' + name)
    def inventory(): return sorted(run(adb + ['shell', 'pm', 'list', 'packages']).splitlines())
    verify_sources()
    baseline = inventory()
    if len(baseline) != 253 or any('package:' + p in baseline for p in [PACKAGE, PROVIDER]):
        raise RuntimeError('Expected exact retained inventory and absent disposable IDs')
    (out / 'packages-before.json').write_text(json.dumps(baseline, indent=2) + '\n')
    checks, private_entry = [], False
    state_title, state_marker = None, 'HGSignerState' + str(time.time_ns())
    receipt = {'status': 'failed', 'suite': 'production-nip55-state-data' if args.state_data else 'production-nip55-account', 'platform': 'android', 'serial': args.serial,
               'entry': 'index.ts', 'package': PACKAGE, 'sources': seal['sources'], 'observerSha256': observer_hash,
               'argv': __import__('sys').argv, 'screenshots': 'Secure-window captures retained as observed; black images do not establish readable visual acceptance',
               'appBuildReceiptSha256': app_receipt_hash, 'providerBuildReceiptSha256': provider_receipt_hash,
               'providerSources': provider['sourceBefore'], 'providerSourceScope': 'Pinned provider02 source archive; distinct from current production app inputs',
               'apkSha256': seal['apkSha256'], 'providerApkSha256': provider['apkSha256'],
               'scope': 'Ordinary production Expo owner/vault and real installed-package picker, independent Activity result, native Resume, candidate cancellation, same-account commit, public method inventory, explicit method choice and offline disconnect, cold process restoration.',
               'limitations': 'Uses known public-vector scalar9 only in native import input. No secret getters or backup reveal. No event-signing, publication, network transport, Amber, physical protection or complete cross-capability E2E acceptance.'}
    if args.state_data:
        receipt['scope'] = 'One bundled State Lab shared string through actual SDK Write/Read controls across same-account NIP55 connection, explicit local/NIP55 choices, offline NO_METHOD and final cold local recovery. Ordinary native owner, picker, Resume and method confirmations remain.'
        receipt['dataScope'] = {'fixture': 'state-lab', 'storageScope': 'shared', 'key': 'sample', 'marker': state_marker,
                                'limitations': 'One public string in one bundled app/identity namespace. No instance-scope, other-app/publisher, NIP46, signing or complete data-integrity claim.'}
    def check(value, label):
        if not value: raise RuntimeError('Production assertion failed: ' + label)
        checks.append(label)
    def snapshot(name, screenshot=False):
        try:
            run(adb + ['shell', 'uiautomator', 'dump', REMOTE_XML])
            xml = run(adb + ['exec-out', 'cat', REMOTE_XML])
        finally:
            if private_entry: run(adb + ['shell', 'rm', '-f', REMOTE_XML])
        if not private_entry:
            if 'nsec1' in xml: raise RuntimeError('Private entry appeared in public accessibility output')
            (out / (name + '.xml')).write_text(xml)
            if screenshot:
                (out / (name + '.png')).write_bytes(subprocess.check_output([str(x) for x in adb + ['exec-out', 'screencap', '-p']], timeout=15))
        return ET.fromstring(xml)
    size = re.search(r'(\d+)x(\d+)', run(adb + ['shell', 'wm', 'size']))
    if not size: raise RuntimeError('Display size unavailable')
    width, height = map(int, size.groups())
    def swipe(up=True):
        run(adb + ['shell', 'input', 'swipe', width // 2, int(height * (.8 if up else .27)), width // 2, int(height * (.27 if up else .8)), '250'])
    def top():
        for _ in range(4): swipe(False)
    def matches(node, target, partial=False):
        values = [node.get('resource-id', ''), node.get('text', ''), node.get('content-desc', '')]
        return any(target.casefold() in v.casefold() if partial else target.casefold() == v.casefold() or v.endswith(':id/' + target) for v in values)
    def find(target, name, tap=False, partial=False, scroll=False, timeout=25):
        deadline = time.monotonic() + timeout
        reversed_once = False
        while time.monotonic() < deadline:
            tree = snapshot(name)
            reverse_needed = False
            for node in tree.iter('node'):
                if not matches(node, target, partial): continue
                bounds = re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', node.get('bounds', ''))
                if not bounds: continue
                left, upper, right, lower = map(int, bounds.groups())
                if right <= left or lower <= upper or lower <= 0:
                    if scroll and not partial and lower < height // 2: reverse_needed = True
                    continue
                if not private_entry: snapshot(name, screenshot=True)
                if tap: run(adb + ['shell', 'input', 'tap', (left + right) // 2, (upper + lower) // 2])
                checks.append(name); return node
            if reverse_needed and not reversed_once:
                run(adb + ['shell', 'input', 'swipe', width // 2, int(height * .4), width // 2, int(height * .55), '250'])
                reversed_once = True
            elif scroll: swipe()
            time.sleep(.2)
        raise RuntimeError('Production control absent: ' + target)
    def private_input_state(name, expected_length, focus=False):
        deadline, tapped = time.monotonic() + 25, False
        while time.monotonic() < deadline:
            tree = snapshot(name)
            entries = [node for node in tree.iter('node') if node.get('class') == 'android.widget.EditText' and node.get('package') == PACKAGE]
            if len(entries) == 1:
                node = entries[0]
                text = node.get('text', '')
                empty_hint = focus and expected_length == 0 and node.get('hint') == 'Private key' and text == 'Private key'
                state = {'length': len(text), 'focused': node.get('focused') == 'true',
                         'password': node.get('password') == 'true', 'masked': all(c == '\u2022' for c in text),
                         'empty': text == '' or empty_hint, 'hintVisible': empty_hint}
                receipt.setdefault('privateInputStates', {})[name] = state
                if not state['password'] or (focus and not state['masked'] and not empty_hint):
                    raise RuntimeError('Private input is not masked; no text retained')
                if focus and not state['empty']:
                    raise RuntimeError('Private input must be empty before single injection')
                if focus and not tapped:
                    bounds = re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', node.get('bounds', ''))
                    if not bounds: raise RuntimeError('Private input bounds unavailable')
                    left, upper, right, lower = map(int, bounds.groups())
                    check(right > left and lower > upper, name + '-input-bounds')
                    run(adb + ['shell', 'input', 'tap', (left + right) // 2, (upper + lower) // 2])
                    tapped = True
                elif (state['empty'] if focus else state['length'] == expected_length and state['masked']) and state['focused']:
                    check(True, name + ('-empty-field-and-focus' if focus else '-masked-length-and-focus')); return
            time.sleep(.2)
        raise RuntimeError('Private input state unavailable; no text retained')
    def settings(name):
        top()
        if not any(matches(n, 'settings-full-npub') for n in snapshot(name).iter('node')):
            find('shell-settings', name + '-open', tap=True)
        top(); return find('settings-full-npub', name + '-npub').get('text')
    def section(name):
        top(); node = find('settings-section-identity', name + '-section', scroll=True)
        if '+' in node.get('content-desc', ''): find('settings-section-identity', name + '-expand', tap=True)
    def accounts(name, expected):
        section(name); find('Saved identities', name + '-saved', scroll=True)
        swipe()
        rows = [n for n in snapshot(name + '-rows', screenshot=True).iter('node') if 'identity-select-' in n.get('resource-id', '')]
        check(len(rows) == 2, name + '-two-retained-accounts')
        check(sum(expected in n.get('resource-id', '') for n in rows) == 1, name + '-one-fixture-account')
    def restart(name):
        run(adb + ['shell', 'am', 'force-stop', PACKAGE]); run(adb + ['shell', 'am', 'start', '-W', '-n', ACTIVITY])
        return settings(name)
    def begin_android(name):
        section(name); find('signer-connect-android', name + '-connect', tap=True, scroll=True)
        find('Choose Android signer', name + '-actual-native-picker')
    def lookup(name):
        begin_android(name)
        choice = find(PROVIDER, name + '-installed-package-and-cert', partial=True)
        label = choice.get('text', '') or choice.get('content-desc', '')
        check(label.splitlines()[0] == PROVIDER and provider['certificateSha256'] in label, name + '-exact-native-package-certificate-choice')
        left, upper, right, lower = map(int, re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', choice.get('bounds', '')).groups())
        run(adb + ['shell', 'input', 'tap', (left + right) // 2, (upper + lower) // 2])
        find('get_public_key', name + '-actual-provider-request', partial=True)
        find('Return fixture result', name + '-provider-native-return', tap=True)
        find('Resume signer request?', name + '-native-resume-screen')
        find('Resume', name + '-native-resume-gesture', tap=True)
        return find('identity-change-npub', name + '-public-candidate').get('text')
    def method_control(method, name):
        target, deadline = 'signer-select-' + method, time.monotonic() + 25
        for _ in range(8):
            if time.monotonic() >= deadline: break
            tree = snapshot(name)
            views = [n for n in tree.iter('node') if n.get('class') == 'android.widget.ScrollView' and n.get('scrollable') == 'true' and n.get('package') == PACKAGE]
            if len(views) != 1 or not any(matches(n, 'settings-done') for n in tree.iter('node')):
                raise RuntimeError('Expected one observed Settings scroll view')
            area = state_bounds(views[0])
            if area[2] <= area[0] or area[3] <= area[1]: raise RuntimeError('Invalid observed Settings scroll bounds')
            def visible(node):
                left, upper, right, lower = state_bounds(node)
                return area[0] <= left < right <= area[2] and area[1] <= upper < lower <= area[3]
            candidates = [n for n in tree.iter('node') if matches(n, target)]
            if len(candidates) > 1: raise RuntimeError('Ambiguous signing-method control')
            if candidates and visible(candidates[0]):
                node = candidates[0]
                if node.get('enabled') != 'true': raise RuntimeError('Signing-method control is disabled')
                left, upper, right, lower = state_bounds(node)
                snapshot(name, screenshot=True)
                run(adb + ['shell', 'input', 'tap', (left + right) // 2, (upper + lower) // 2])
                checks.append(name); return
            # These observed controls follow the method choices in Settings. If
            # they are visible while the target is absent, scroll back toward it.
            later = [n for n in tree.iter('node') if (matches(n, 'signer-connect') or matches(n, 'signer-connect-android') or matches(n, 'Saved identities')) and visible(n)]
            up = bool(later)
            if candidates:
                bound = state_bounds(candidates[0]); up = bound[3] <= area[1] or bound[1] < area[1]
            x, middle, step = (area[0] + area[2]) // 2, (area[1] + area[3]) // 2, (area[3] - area[1]) // 6
            run(adb + ['shell', 'input', 'swipe', x, middle, x, middle + step if up else middle - step, '400'])
        raise RuntimeError('Signing-method control unavailable: ' + target)
    def select(method, name, expected_npub):
        section(name)
        if args.state_data: method_control(method, name + '-explicit-method')
        else: find('signer-select-' + method, name + '-explicit-method', tap=True, scroll=True)
        find('identity-change-confirm', name + '-js-flush-confirm', tap=True)
        find('Change signing method?', name + '-native-method-confirmation')
        find('Use signing method', name + '-native-method-gesture', tap=True)
        check(settings(name + '-selected-account') == expected_npub, name + '-same-public-identity')
    # Adapt only the observed WebView traversal/input patterns from state_storage.py.
    # Its old visible runtime-status check is incompatible with the current zero-size status.
    def state_rows(tree):
        rows = []
        def visit(node, depth=0):
            if node.tag == 'node': rows.append((node, depth))
            for child in node: visit(child, depth + int(node.get('class') == 'android.webkit.WebView'))
        visit(tree); return rows
    def state_bounds(node):
        value = re.fullmatch(r'\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]', node.get('bounds', ''))
        if not value: raise RuntimeError('State Lab control has no observed bounds')
        return tuple(map(int, value.groups()))
    def state_surface(rows):
        candidates = [state_bounds(node) for node, depth in rows if depth == 0 and node.get('class') == 'android.webkit.WebView']
        candidates = [b for b in candidates if b[2] - b[0] > 400 and b[3] - b[1] > 400]
        if len(candidates) != 1: raise RuntimeError('Expected one focused native WebView for State Lab')
        return candidates[0]
    def state_control(target, name, tap=False):
        for _ in range(6):
            rows = state_rows(snapshot(name)); area = state_surface(rows)
            matches = [node for node, depth in rows if depth > 0 and node.get('resource-id', '').split('/')[-1] == target]
            visible = [node for node in matches if (lambda b: b[2] > b[0] and b[3] - b[1] > 15 and b[0] >= area[0] and b[1] >= area[1] and b[3] <= area[3])(state_bounds(node))]
            if len(visible) > 1: raise RuntimeError('Ambiguous visible State Lab control')
            if visible:
                node = visible[0]
                if tap:
                    left, upper, right, lower = state_bounds(node)
                    run(adb + ['shell', 'input', 'tap', (left + right) // 2, (upper + lower) // 2])
                return node
            up = target in {'identity', 'identity-status', 'scope', 'key'}
            if len(matches) == 1:
                bound = state_bounds(matches[0])
                if bound[3] <= area[1] + 1: up = True
                elif bound[1] >= area[3] - 1: up = False
            x, high, low = (area[0] + area[2]) // 2, area[1] + (area[3] - area[1]) // 3, area[1] + (area[3] - area[1]) * 3 // 4
            run(adb + ['shell', 'input', 'swipe', x, high if up else low, x, low if up else high, '400'])
        raise RuntimeError('State Lab control unavailable: ' + target)
    def state_ready(name):
        deadline = time.monotonic() + 25
        while state_control('identity-status', name + '-identity-ready').get('text') != 'Identity connected':
            if time.monotonic() >= deadline: raise RuntimeError('State Lab SDK identity did not connect')
            time.sleep(.2)
        title = find('focused-napplet-name', name + '-focused-title').get('text', '')
        check(bool(re.fullmatch(r'State Lab [1-9][0-9]*', title)) and (state_title is None or title == state_title), name + '-same-state-lab-title')
        check(state_control('identity', name + '-identity').get('text') == pubkey, name + '-sdk-same-public-key')
        check(state_control('scope', name + '-scope').get('text') == 'All instances of this napplet', name + '-shared-scope')
        check(state_control('key', name + '-key').get('text') == 'sample', name + '-same-key')
        return title
    def state_action(action, expected_status, name):
        before = int(state_control('requests', name + '-requests-before').get('text', ''))
        state_control(action, name + '-action', tap=True)
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            after = int(state_control('requests', name + '-requests-after').get('text', ''))
            if after < before or after > before + 1: raise RuntimeError('Unexpected State Lab SDK request count')
            if after != before + 1: continue
            # The fixture sets Waiting before advancing its counter. Only inspect a
            # fresh terminal status after observing this action's exact new count.
            status = state_control('status', name + '-status').get('text', '')
            if status.startswith('Request failed:'): raise RuntimeError('State Lab SDK operation failed')
            if status == expected_status:
                check(after == before + 1, name + '-one-new-sdk-request'); return
        raise RuntimeError('State Lab SDK operation did not settle')
    def state_read(name, expected_npub):
        find('settings-done', name + '-close-settings', tap=True)
        state_ready(name)
        state_action('read', 'Read complete.', name)
        check(state_control('result', name + '-rendered-value').get('text') == state_marker, name + '-exact-persisted-string')
        receipt.setdefault('stateDataReadbacks', []).append(name)
        check(settings(name + '-return-settings') == expected_npub, name + '-same-account-after-read')
    def state_start(name, expected_npub):
        nonlocal state_title
        check(settings(name + '-account') == expected_npub, name + '-same-account')
        top(); developer = find('settings-section-developer', name + '-developer-section', scroll=True)
        if '+' in developer.get('content-desc', ''): find('settings-section-developer', name + '-expand-developer', tap=True)
        find('settings-open-state-lab', name + '-open-state-lab', tap=True, scroll=True)
        state_title = state_ready(name)
        state_action('read', 'No value saved.', name + '-missing-before-write')
        state_control('value', name + '-value-input', tap=True)
        run(adb + ['shell', 'input', 'keycombination', '113', '29']); run(adb + ['shell', 'input', 'keyevent', '67'])
        run(adb + ['shell', 'input', 'text', state_marker])
        if re.search(r'mInputShown=true\b', run(adb + ['shell', 'dumpsys', 'input_method'])): run(adb + ['shell', 'input', 'keyevent', '4'])
        check(state_control('value', name + '-entered-public-value').get('text') == state_marker, name + '-public-input-exact')
        state_action('write', 'Write confirmed.', name + '-write')
        state_action('read', 'Read complete.', name + '-read')
        check(state_control('result', name + '-baseline-result').get('text') == state_marker, name + '-baseline-persisted-string')
        receipt['stateLabTitle'] = state_title
        check(settings(name + '-return-settings') == expected_npub, name + '-account-after-write')
    def provider_events():
        raw = run(adb + ['exec-out', 'run-as', PROVIDER, 'cat', 'files/events.jsonl'])
        (out / 'provider-events.jsonl').write_text(raw)
        return [json.loads(line) for line in raw.splitlines() if line.strip()]
    try:
        run(adb + ['install', provider_apk])
        run(adb + ['install', apk])
        run(adb + ['shell', 'am', 'start', '-W', '-n', ACTIVITY])
        initial = settings('fresh-production')
        section('native-import'); find('settings-import-identity', 'import-identity', tap=True, scroll=True)
        find('identity-import-review', 'native-import-open', tap=True)
        private_entry = True; find('Import private key', 'native-private-entry')
        private_input_state('before-single-native-entry', 0, focus=True)
        code = "import {nip19} from 'nostr-tools';const k=new Uint8Array(32);k[31]=9;process.stdout.write(nip19.nsecEncode(k));k.fill(0);"
        fixture = run([ROOT / '.tools/node/bin/node', '--input-type=module', '-e', code])
        if not re.fullmatch(r'nsec1[a-z0-9]{58}', fixture): raise RuntimeError('Public fixture encoding failed')
        try:
            entered = subprocess.run([str(x) for x in adb + ['shell', 'input', 'text', fixture]], capture_output=True, timeout=15)
        except Exception:
            raise RuntimeError('Native fixture entry failed') from None
        finally:
            del fixture
        if entered.returncode: raise RuntimeError('Native fixture entry failed')
        private_input_state('after-single-native-entry', 63)
        find('Prepare import', 'native-import-prepare', tap=True)
        private_entry = False
        imported = find('identity-change-npub', 'local9-public-candidate').get('text')
        find('identity-change-confirm', 'local9-js-flush-confirm', tap=True)
        find('Import this identity?', 'local9-native-confirmation'); find('Switch identity', 'local9-native-gesture', tap=True)
        check(settings('local9-selected') == imported and imported != initial, 'native-import-selected-disposable-local9')
        pubkey = 'acd484e2f0c7f65309ad178a9f559abde09796974c57e714c35f110dfc27ccbe'
        if args.state_data: state_start('state-data-baseline-local', imported)
        accounts('before-connection', pubkey)
        if args.state_data:
            check(lookup('connect-existing') == imported, 'provider-candidate-same-existing-account')
        else:
            begin_android('native-picker-cancel'); find('Cancel', 'native-picker-cancel-gesture', tap=True)
            check(settings('after-picker-cancel') == imported, 'picker-cancellation-keeps-selected')
            candidate = lookup('public-candidate-cancel'); check(candidate == imported, 'actual-provider-result-matches-existing-local-account')
            find('identity-change-cancel', 'public-candidate-cancel-gesture', tap=True)
            check(settings('after-candidate-cancel') == imported, 'public-candidate-cancellation-keeps-selected')
            section('no-connection-after-cancel'); find('This device · Selected', 'local-remains-selected-after-cancel', scroll=True)
            check(lookup('connect-existing') == imported, 'second-lookup-same-account')
        find('identity-change-confirm', 'connect-js-flush-confirm', tap=True)
        find('Connect and use Android signer?', 'connect-native-final-confirmation')
        find('Use this signer', 'connect-native-final-gesture', tap=True)
        check(settings('connected-account') == imported, 'connection-preserves-selected-public-identity')
        section('connected-methods'); find('Android signer app · Selected', 'explicit-nip55-selected', scroll=True)
        find('signer-package', 'saved-installed-package', scroll=True); find('signer-local-copy', 'stored-local-copy-preserved', scroll=True)
        if args.state_data: state_read('state-data-after-nip55-connect', imported)
        accounts('connected-inventory', pubkey)
        check(restart('connected-cold-restart') == imported, 'connected-identity-survives-cold-restart')
        section('restored-methods'); find('Android signer app · Selected', 'nip55-selection-survives-cold-restart', scroll=True)
        find('signer-local-copy', 'restored-local-copy-present', scroll=True)
        select('local', 'explicit-local', imported); section('local-method'); find('This device · Selected', 'explicit-local-selected', scroll=True)
        if args.state_data: state_read('state-data-after-explicit-local', imported)
        select('nip55', 'explicit-nip55', imported); section('nip55-method'); find('Android signer app · Selected', 'explicit-nip55-selected-again', scroll=True)
        if args.state_data: state_read('state-data-after-explicit-nip55', imported)
        events = provider_events(); requests = [v for v in events if v.get('stage') == 'received']
        if args.state_data:
            check(len(requests) == 1 and all(v.get('type') == 'get_public_key' and v.get('caller') == PACKAGE for v in requests), 'one-publickey-request-no-signing-requests')
            check(len([v for v in events if v.get('stage') == 'returned']) == 1, 'one-actual-activity-result')
        else:
            check(len(requests) == 2 and all(v.get('type') == 'get_public_key' and v.get('caller') == PACKAGE for v in requests), 'two-publickey-requests-no-signing-requests')
            check(len({v['id'] for v in requests}) == 2, 'distinct-native-request-correlations')
            check(len([v for v in events if v.get('stage') == 'returned']) == 2, 'two-actual-activity-results')
        run(adb + ['uninstall', PROVIDER])
        check('package:' + PROVIDER not in inventory(), 'provider-offline-before-disconnect')
        section('offline-disconnect'); find('signer-disconnect-android', 'offline-disconnect-request', tap=True, scroll=True)
        find('identity-change-confirm', 'offline-disconnect-js-flush-confirm', tap=True)
        find('Disconnect saved signer?', 'offline-native-disconnect-confirmation')
        find('Disconnect signer', 'offline-native-disconnect-gesture', tap=True)
        check(settings('after-offline-disconnect') == imported, 'offline-disconnect-preserves-identity')
        section('no-selected-method'); find('signer-no-selection', 'explicit-no-selection-no-fallback', scroll=True)
        find('signer-select-local', 'local-method-still-available', scroll=True)
        if args.state_data: state_read('state-data-offline-no-method', imported)
        check(restart('disconnected-cold-restart') == imported, 'disconnected-identity-survives-restart')
        section('disconnected-restored'); find('signer-no-selection', 'no-selection-persists-after-restart', scroll=True)
        if args.state_data: state_read('state-data-cold-no-method', imported)
        accounts('final-inventory', pubkey)
        select('local', 'explicit-local-recovery', imported)
        check(settings('local-recovered-account') == imported, 'explicit-local-recovery-preserves-identity')
        section('local-recovered-method'); find('This device · Selected', 'explicit-local-recovery-selected', scroll=True)
        check(restart('local-recovered-cold-restart') == imported, 'local-recovered-identity-survives-restart')
        section('local-recovered-restored'); find('This device · Selected', 'local-recovery-selection-survives-restart', scroll=True)
        if args.state_data: state_read('state-data-final-cold-local-recovery', imported)
        accounts('local-recovered-inventory', pubkey)
        verify_sources()
        receipt.update(status='passed', assertions=len(checks), checks=checks, initialNpub=initial, importedNpub=imported,
                       providerPublicRequests=len(requests), providerSigningRequests=0, sourcesUnchanged=True)
    except BaseException as failure:
        receipt.update(assertions=len(checks), checks=checks, failureClass=type(failure).__name__, failureMessage=str(failure), achievedScope='Only successful checks listed in checks; intended later account stages remain unperformed')
        try: provider_events()
        except Exception: pass
        if not private_entry:
            try: snapshot('failure-public-ui', screenshot=True)
            except Exception: pass
        raise
    finally:
        cleanup_errors = []
        # Both exact IDs were absent before this run; reconcile them even if an
        # install timed out after succeeding or another cleanup action failed.
        for package in [PACKAGE, PROVIDER]:
            present = True
            try: present = 'package:' + package in inventory()
            except Exception as failure: cleanup_errors.append('inventory before ' + package + ': ' + type(failure).__name__)
            if present:
                try: run(adb + ['uninstall', package])
                except Exception as failure: cleanup_errors.append('uninstall ' + package + ': ' + type(failure).__name__)
        after = None
        try: after = inventory()
        except Exception as failure: cleanup_errors.append('final inventory: ' + type(failure).__name__)
        (out / 'packages-after.json').write_text(json.dumps(after, indent=2) + '\n')
        receipt['retainedInventoryUnchanged'] = after is not None and after == baseline
        receipt['ownedAppsRemoved'] = after is not None and all('package:' + p not in after for p in [PACKAGE, PROVIDER])
        receipt['observerXMLRemoved'] = False
        try:
            run(adb + ['shell', 'rm', '-f', REMOTE_XML])
            receipt['observerXMLRemoved'] = run(adb + ['shell', 'test', '!', '-e', REMOTE_XML]).strip() == ''
        except Exception as failure: cleanup_errors.append('observer XML: ' + type(failure).__name__)
        receipt['sourcesUnchanged'] = False
        try: verify_sources(); receipt['sourcesUnchanged'] = True
        except Exception as failure: cleanup_errors.append('source seal: ' + type(failure).__name__)
        cleanup_passed = not cleanup_errors and all(receipt.get(k) for k in ['retainedInventoryUnchanged', 'ownedAppsRemoved', 'observerXMLRemoved', 'sourcesUnchanged'])
        receipt['cleanupErrors'] = cleanup_errors
        if not cleanup_passed:
            receipt.update(status='failed', failureClass='RuntimeError', failureMessage='Production cleanup or source seal mismatch')
        (out / 'result.json').write_text(json.dumps(receipt, indent=2) + '\n')
        if not cleanup_passed:
            raise RuntimeError('Production cleanup or source seal mismatch')
    print(json.dumps({'status': receipt['status'], 'assertions': receipt['assertions'], 'receipt': str(out / 'result.json')}))


if __name__ == '__main__': main()
