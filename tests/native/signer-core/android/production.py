#!/usr/bin/env python3
"""Observe the sealed ordinary production app under its disposable proof ID; never targets a retained app."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[4]
PACKAGE = 'org.nostrocket.hypergolic.signercore.bridgeproof'
ACTIVITY = PACKAGE + '/org.nostrocket.hypergolic.dev.MainActivity'
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--output', type=Path, required=True)
p.add_argument('--serial', default='emulator-5554')
p.add_argument('--archived-sources', action='store_true', help='Verify exact input snapshot archived after unchanged compilation, allowing later concurrent repository work.')
p.add_argument('--attached', action='store_true', help=argparse.SUPPRESS)
a = p.parse_args(); out = a.output.resolve()
if not re.fullmatch(r'emulator-[0-9]+', a.serial): raise SystemExit('An emulator is required.')
if a.attached: raise SystemExit('Only a fresh absent-before disposable installation is supported.')
if any((out / name).exists() for name in ('production-result.json', 'production-effects.json')): raise SystemExit('A fresh observer result is required.')
seal = json.loads((out / 'build.json').read_text()); apk = out / 'bridge.apk'
driver_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
if seal['entry'] != 'index.ts' or seal['package'] != PACKAGE: raise SystemExit('Ordinary production entry and disposable package required.')
adb = [ROOT / '.tools/android-sdk/platform-tools/adb', '-s', a.serial]
env = os.environ.copy(); env['PATH'] = str(ROOT / '.tools/node/bin') + os.pathsep + env.get('PATH', '')
SCRATCH = '/data/local/tmp/hg-vault-production.xml'
effects = {'pinAttempted': False, 'installAttempted': False, 'scratchAttempted': False}
remote_uncertain = False
private_ui = False
stage = 'preflight'
def record_effect(name):
    effects[name] = True
    (out / 'production-effects.json').write_text(json.dumps(effects, indent=2) + '\n')
def run(command, timeout=30):
    global remote_uncertain
    args = [str(x) for x in command]
    try:
        return subprocess.check_output(args, env=env, text=True, stderr=subprocess.STDOUT, timeout=timeout)
    except subprocess.TimeoutExpired:
        tail = args[len(adb):] if args[:len(adb)] == [str(x) for x in adb] else []
        if tail and (tail[0] in ('install', 'uninstall') or tail[:2] in (['shell', 'input'], ['shell', 'am'], ['shell', 'uiautomator'], ['shell', 'rm']) or tail[:3] in (['shell', 'locksettings', 'set-pin'], ['shell', 'locksettings', 'clear'])):
            remote_uncertain = True
        raise

def failure(error):
    result = {'type': type(error).__name__, 'stage': stage}
    if isinstance(error, subprocess.CalledProcessError): result['exitCode'] = error.returncode
    if isinstance(error, RuntimeError): result['message'] = str(error)
    return result

def cleanup(baseline, metadata):
    errors = []
    def attempt(name, action):
        try: action()
        except BaseException as error: errors.append({'operation': name, **failure(error)})
    def mutable():
        if remote_uncertain: raise RuntimeError('Remote mutation completion requires reconciliation; cleanup mutation deferred')
    def remove_app():
        if not effects['installAttempted']: return
        current = run(adb + ['shell', 'pm', 'list', 'packages']).splitlines()
        if 'package:' + PACKAGE not in current: return
        mutable()
        paths = run(adb + ['shell', 'pm', 'path', PACKAGE]).splitlines()
        if len(paths) != 1 or not re.fullmatch(r'package:/data/app/[^\s]+/base\.apk', paths[0]): raise RuntimeError('Owned APK path is ambiguous')
        installed_apk = subprocess.check_output([str(x) for x in adb + ['exec-out', 'cat', paths[0][8:]]], timeout=30)
        if hashlib.sha256(installed_apk).hexdigest() != seal['apkSha256']: raise RuntimeError('Installed APK does not match owned seal')
        run(adb + ['uninstall', PACKAGE])
    def restore_pin():
        if not effects['pinAttempted']: return
        mutable()
        try:
            run(adb + ['shell', 'locksettings', 'verify'])
            return  # Already in the confirmed original no-credential state.
        except subprocess.CalledProcessError:
            pass
        run(adb + ['shell', 'locksettings', 'verify', '--old', '5566'])
        run(adb + ['shell', 'locksettings', 'clear', '--old', '5566'])
        run(adb + ['shell', 'locksettings', 'verify'])
    def retire_scratch():
        if effects['scratchAttempted']:
            mutable(); run(adb + ['shell', 'rm', '-f', SCRATCH])
    def inventory():
        after = run(adb + ['shell', 'pm', 'list', 'packages'])
        (out / 'packages-after.txt').write_text(after)
        if baseline is not None and set(after.splitlines()) != set(baseline.splitlines()): raise RuntimeError('Production disposable package cleanup mismatch')
        after_metadata = run(adb + ['shell', 'pm', 'list', 'packages', '-f', '-U', '--show-versioncode'])
        (out / 'packages-metadata-after.txt').write_text(after_metadata)
        if metadata is not None and set(after_metadata.splitlines()) != set(metadata.splitlines()): raise RuntimeError('Production package metadata cleanup mismatch')
    def scratch_absent():
        try: run(adb + ['shell', 'test', '-e', SCRATCH])
        except subprocess.CalledProcessError as error:
            if error.returncode == 1: return
            raise
        raise RuntimeError('Owned scratch remains')
    attempt('uninstall-owned-proof', remove_app)
    attempt('restore-owned-pin', restore_pin)
    attempt('retire-owned-scratch', retire_scratch)
    attempt('verify-inventory', inventory)
    attempt('verify-scratch-absence', scratch_absent)
    attempt('verify-source-seal', verify_sources)
    return errors

def verify_sources():
    if hashlib.sha256(Path(__file__).read_bytes()).hexdigest() != driver_hash: raise RuntimeError('Production observer changed during execution')
    if hashlib.sha256(apk.read_bytes()).hexdigest() != seal['apkSha256']: raise RuntimeError('Sealed production APK changed')
    for path, expected in seal['sources'].items():
        source = out / 'source-snapshot' / path if a.archived_sources else ROOT / path
        if hashlib.sha256(source.read_bytes()).hexdigest() != expected: raise RuntimeError('Production source changed: ' + path)
def snapshot(name, private=False, screenshot=False):
    global private_ui
    private_ui = private
    record_effect('scratchAttempted')
    run(adb + ['shell', 'uiautomator', 'dump', SCRATCH])
    xml = run(adb + ['exec-out', 'cat', '/data/local/tmp/hg-vault-production.xml'])
    if not private:
        if 'nsec1' in xml: raise RuntimeError('Secret appeared in native accessibility output')
        (out / (name + '.xml')).write_text(xml)
        if screenshot:
            (out / (name + '.png')).write_bytes(subprocess.check_output([str(x) for x in adb + ['exec-out', 'screencap', '-p']], timeout=15))
    return ET.fromstring(xml)
def nodes(name, private=False): return list(snapshot(name, private).iter('node'))
checks = []
def check(value, name):
    if not value: raise RuntimeError('Production assertion failed: ' + name)
    checks.append(name)
def find(target, name, *, tap=False, partial=False, private=False, scroll=False, timeout=25):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        tree = snapshot(name, private)
        for node in tree.iter('node'):
            values = [node.get('resource-id', ''), node.get('text', ''), node.get('content-desc', '')]
            if any((target.casefold() in value.casefold() if partial else target.casefold() == value.casefold()) for value in values):
                bounds = re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', node.get('bounds', ''))
                if not bounds: continue
                left, top, right, bottom = map(int, bounds.groups())
                if right <= left or bottom <= top: continue
                if not private: (out / (name + '.png')).write_bytes(subprocess.check_output([str(x) for x in adb + ['exec-out', 'screencap', '-p']], timeout=15))
                if tap: run(adb + ['shell', 'input', 'tap', (left+right)//2, (top+bottom)//2])
                checks.append(name)
                return node
        if scroll: run(adb + ['shell', 'input', 'swipe', '500', '1800', '500', '600', '300'])
        time.sleep(.15)
    raise RuntimeError('Production UI target missing: ' + target)
def top():
    for _ in range(4): run(adb + ['shell', 'input', 'swipe', '500', '650', '500', '1850', '250'])
def settings(name):
    tree = snapshot(name)
    if not any(n.get('resource-id') == 'settings-full-npub' or n.get('resource-id', '').startswith('settings-section-') for n in tree.iter('node')):
        if any(n.get('resource-id') == 'identity-import-cancel' for n in tree.iter('node')): find('identity-import-cancel', name+'-close-import', tap=True)
        else: find('shell-settings', name+'-open', tap=True)
    top()
    return find('settings-full-npub', name+'-npub').get('text')
def identity_section(name):
    top(); node = find('settings-section-identity', name+'-section', scroll=True)
    if '+' in node.get('content-desc', ''): find('settings-section-identity', name+'-expand', tap=True)
    find('Saved identities', name+'-saved-heading', scroll=True)
    run(adb + ['shell', 'input', 'swipe', '500', '1950', '500', '850', '300'])
def nsec_fixture(scalar):
    code = "import {nip19} from 'nostr-tools';const key=new Uint8Array(32);key[31]=Number(process.argv[1]);process.stdout.write(nip19.nsecEncode(key));key.fill(0);"
    value = run([ROOT / '.tools/node/bin/node', '--input-type=module', '-e', code, scalar])
    if not re.fullmatch(r'nsec1[a-z0-9]{58}', value): raise RuntimeError('Disposable fixture encoding failed')
    return value
def native_text(value):
    global remote_uncertain
    try:
        result = subprocess.run([str(x) for x in adb + ['shell', 'input', 'text', value]], capture_output=True, timeout=15)
    except subprocess.TimeoutExpired:
        remote_uncertain = True
        raise
    if result.returncode != 0:
        remote_uncertain = True
        raise RuntimeError('Native fixture entry completion requires reconciliation')
def authenticate(name, cancel=False):
    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        tree = snapshot(name, private=True)
        for node in tree.iter('node'):
            package = node.get('package', '')
            field = node.get('resource-id', '').lower()
            if package in ('com.android.systemui', 'com.android.settings') and ('pinentry' in field or 'passwordentry' in field or node.get('password') == 'true'):
                checks.append(name + '-real-system-credential-screen')
                if cancel: run(adb + ['shell', 'input', 'keyevent', '4'])
                else: native_text('5566'); run(adb + ['shell', 'input', 'keyevent', '66'])
                return
            if package == 'com.android.systemui' and node.get('text', '').casefold() in ('use pin', 'confirm pin'):
                raw = re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', node.get('bounds', ''))
                if raw:
                    l,t,r,b = map(int,raw.groups()); run(adb + ['shell','input','tap',(l+r)//2,(t+b)//2])
        time.sleep(.2)
    raise RuntimeError('System credential prompt missing')
def import_prepare(scalar, name):
    settings(name+'-settings'); identity_section(name)
    find('settings-import-identity', name+'-import', tap=True, scroll=True)
    find('identity-import-review', name+'-native-entry-request', tap=True)
    find('Import private key', name+'-native-entry', private=True)
    # The native field deliberately has no accessibility node. AlertDialog focuses its first EditText.
    native_text(nsec_fixture(scalar))
    find('Prepare import', name+'-prepare', tap=True, private=True)
    find('identity-change-npub', name+'-public-candidate')
def native_switch(accept, name):
    find('Switch identity', name+'-native-switch', tap=accept)
    if not accept: find('Cancel', name+'-native-cancel', tap=True)
baseline = metadata = None
primary = None
journey_passed = False
initial = imported = None
try:
    verify_sources()
    baseline = run(adb + ['shell', 'pm', 'list', 'packages'])
    if 'package:' + PACKAGE in baseline.splitlines(): raise RuntimeError('Disposable proof package must be absent before setup')
    metadata = run(adb + ['shell', 'pm', 'list', 'packages', '-f', '-U', '--show-versioncode'])
    # No --old credential is supplied: this must succeed before owning a PIN change.
    run(adb + ['shell', 'locksettings', 'verify'])
    try: run(adb + ['shell', 'test', '-e', SCRATCH])
    except subprocess.CalledProcessError as error:
        if error.returncode != 1: raise
    else: raise RuntimeError('Disposable scratch must be absent before setup')
    (out / 'packages-before.txt').write_text(baseline)
    (out / 'packages-metadata-before.txt').write_text(metadata)
    stage = 'set-owned-pin'; record_effect('pinAttempted')
    run(adb + ['shell', 'locksettings', 'set-pin', '5566'])
    stage = 'install-owned-proof'; record_effect('installAttempted')
    run(adb + ['install', apk])
    stage = 'ordinary-production-journey'
    run(adb + ['shell', 'am', 'start', '-W', '-n', ACTIVITY])
    initial = settings('initial-production'); check(initial.startswith('npub1'), 'fresh-native-public-identity')
    run(adb + ['shell', 'am', 'force-stop', PACKAGE]); run(adb + ['shell', 'am', 'start', '-W', '-n', ACTIVITY])
    check(settings('initial-cold-restart') == initial, 'fresh-generated-key-stable-after-cold-process-restart')
    identity_section('native-entry-cancel')
    find('settings-import-identity', 'entry-cancel-import', tap=True, scroll=True)
    find('identity-import-review', 'entry-cancel-open', tap=True)
    find('Cancel', 'native-entry-cancel', tap=True, private=True)
    check(settings('after-entry-cancel') == initial, 'native-entry-cancel-keeps-selected')
    import_prepare(3, 'import-js-cancel')
    find('identity-change-cancel', 'public-import-cancel', tap=True)
    check(settings('after-public-import-cancel') == initial, 'public-import-cancel-keeps-selected')
    import_prepare(3, 'import-native-cancel')
    find('identity-change-confirm', 'import-native-confirm-request', tap=True)
    find('Import this identity?', 'native-import-confirmation')
    native_switch(False, 'import-native-denial')
    check(settings('after-native-import-cancel') == initial, 'native-import-denial-keeps-selected')
    import_prepare(3, 'import-confirmed')
    imported = find('identity-change-npub', 'confirmed-public-candidate').get('text')
    find('identity-change-confirm', 'import-confirmed-js-request', tap=True)
    find('Import this identity?', 'import-confirmed-native-screen')
    native_switch(True, 'import-confirmed')
    check(settings('after-import') == imported and imported != initial, 'native-import-switch-selected-public-key')
    run(adb + ['shell', 'am', 'force-stop', PACKAGE]); run(adb + ['shell', 'am', 'start', '-W', '-n', ACTIVITY])
    check(settings('imported-cold-restart') == imported, 'imported-key-stable-after-cold-process-restart')
    identity_section('saved-account-selection')
    candidates = [n for n in nodes('saved-public-inventory') if n.get('resource-id', '').startswith('identity-select-')]
    check(len(candidates) == 2, 'public-inventory-two-accounts')
    inactive = next(n.get('resource-id') for n in candidates if n.get('enabled') == 'true')
    find(inactive, 'select-original-request', tap=True, scroll=True)
    find('identity-change-confirm', 'select-original-js-confirm', tap=True)
    find('Switch identity?', 'select-native-confirmation')
    native_switch(False, 'select-original-cancel')
    check(settings('after-native-select-cancel') == imported, 'native-select-denial-keeps-selected')
    identity_section('select-original-approved')
    find(inactive, 'select-original-again', tap=True, scroll=True)
    find('identity-change-confirm', 'select-original-js-again', tap=True)
    find('Switch identity?', 'select-original-native-again')
    native_switch(True, 'select-original-approved')
    check(settings('after-original-select') == initial, 'native-confirmed-selection-persists')
    import_prepare(3, 'duplicate-import-selects-existing')
    find('identity-change-confirm', 'duplicate-import-js-select', tap=True)
    find('Switch identity?', 'duplicate-native-existing-select')
    native_switch(True, 'duplicate-import-selection')
    check(settings('after-existing-import') == imported, 'duplicate-import-selects-existing-account')
    identity_section('duplicate-public-inventory')
    check(len([n for n in nodes('duplicate-account-rows') if n.get('resource-id', '').startswith('identity-select-')]) == 2, 'duplicate-import-does-not-add-row')
    settings('native-backup-settings'); identity_section('native-backup'); top()
    find('identity-backup-start', 'backup-start', tap=True, scroll=True)
    find('identity-backup-confirm', 'backup-auth-request', tap=True)
    authenticate('backup-authentication')
    find('Hide private key', 'native-backup-canvas', private=True, timeout=30)
    native_xml = run(adb + ['exec-out', 'cat', '/data/local/tmp/hg-vault-production.xml'])
    check('nsec1' not in native_xml, 'native-backup-key-absent-from-accessibility')
    windows = run(adb + ['shell', 'dumpsys', 'window', 'windows'])
    secure = [block for block in re.split(r'\n\s*Window #', windows) if PACKAGE in block and 'SECURE' in block]
    check(bool(secure), 'native-backup-own-window-flag-secure')
    (out / 'backup-window-flags.txt').write_text('\n'.join(line for block in secure for line in block.splitlines() if 'SECURE' in line or 'mAttrs=' in line) + '\n')
    find('Hide private key', 'native-hide-backup', tap=True, private=True)
    check(settings('after-backup') == imported, 'backup-completes-without-changing-selected')
    identity_section('delete-native-denial')
    delete_id = inactive.replace('identity-select-', 'identity-delete-')
    find(delete_id, 'delete-inactive-request', tap=True, scroll=True)
    find('identity-delete-confirm', 'delete-auth-cancel-request', tap=True)
    authenticate('delete-auth-cancel', cancel=True)
    check(settings('after-delete-auth-cancel') == imported, 'system-auth-cancel-keeps-selected')
    identity_section('after-delete-denial-inventory')
    check(len([n for n in nodes('after-delete-denial-rows') if n.get('resource-id', '').startswith('identity-select-')]) == 2, 'system-auth-cancel-keeps-both-records')
    find(delete_id, 'delete-inactive-again', tap=True, scroll=True)
    find('identity-delete-confirm', 'delete-auth-confirm-request', tap=True)
    authenticate('delete-auth-confirm')
    check(settings('after-authenticated-delete') == imported, 'authenticated-delete-keeps-selected')
    identity_section('after-delete-inventory')
    check(len([n for n in nodes('after-delete-rows') if n.get('resource-id', '').startswith('identity-select-')]) == 1, 'authenticated-delete-removes-only-inactive-row')
    run(adb + ['shell', 'am', 'force-stop', PACKAGE]); run(adb + ['shell', 'am', 'start', '-W', '-n', ACTIVITY])
    check(settings('deleted-cold-restart') == imported, 'authenticated-delete-survives-cold-restart')
    identity_section('deleted-restart-inventory')
    check(len([n for n in nodes('deleted-restart-rows') if n.get('resource-id', '').startswith('identity-select-')]) == 1, 'deleted-record-stays-absent-after-restart')
    import_prepare(4, 'autonomous-candidate-expiry')
    waiting = time.monotonic()
    (out / 'candidate-expiry-wait.json').write_text(json.dumps({'started': True, 'durationSeconds': 124, 'jsCallsDuringWait': 0}))
    while time.monotonic() - waiting < 124: time.sleep(.5)
    find('identity-change-confirm', 'expired-candidate-confirm-request', tap=True)
    check(settings('after-autonomous-expiry') == imported, 'native-timer-expiry-keeps-selected')
    identity_section('expired-inventory')
    check(len([n for n in nodes('expired-candidate-rows') if n.get('resource-id', '').startswith('identity-select-')]) == 1, 'expired-candidate-never-persisted')
    checks.append('native-candidate-expired-without-js-calls-for-124seconds')
    verify_sources()
    journey_passed = True
except BaseException as error:
    primary = failure(error)
    if not private_ui and not remote_uncertain and stage == 'ordinary-production-journey':
        try:
            foreground = run(adb + ['shell', 'dumpsys', 'activity', 'activities'])
            resumed = re.findall(r'topResumedActivity=.*?\s([^\s]+/[^\s}]+)', foreground)
            if resumed == [ACTIVITY]: snapshot('failure-public-ui')
        except BaseException as capture_error: primary['failureCapture'] = failure(capture_error)
finally:
    stage = 'cleanup'
    cleanup_errors = cleanup(baseline, metadata)
passed = journey_passed and primary is None and not cleanup_errors and not remote_uncertain
receipt = {'status': 'passed' if passed else 'failed', 'platform': 'android', 'suite': 'production-account-bridge',
  'journeyPassed': journey_passed, 'assertions': len(checks), 'checks': checks, 'primaryFailure': primary,
  'cleanupErrors': cleanup_errors, 'deviceReconciliationRequired': bool(cleanup_errors) or remote_uncertain,
  'remoteMutationCompletionUncertain': remote_uncertain, 'intendedOwnedEffects': effects,
  'sources': seal['sources'], 'sourcesUnchanged': not any(x['operation'] == 'verify-source-seal' for x in cleanup_errors),
  'apkSha256': seal['apkSha256'], 'entry': 'index.ts',
  'inputSourceSnapshot': str(out / 'source-snapshot') if a.archived_sources else None, 'observerSha256': driver_hash,
  'initialNpub': initial, 'importedNpub': imported,
  'scope': 'Ordinary production app and actual Expo owner/vault: import/selection cancellation and confirmation, duplicates/cold restarts, real OS PIN authentication, secure native backup, canceled and committed inactive deletion, autonomous120s prepared-candidate expiry.',
  'limitations': 'Captured napplet signing requires a separate ordinary guest journey. The exact sealed APK/source inputs are recorded; no current-source claim follows from archived-only input verification.'}
(out / 'production-result.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps({'status': receipt['status'], 'journeyPassed': journey_passed, 'assertions': len(checks), 'deviceReconciliationRequired': receipt['deviceReconciliationRequired'], 'output': str(out)}))
raise SystemExit(0 if passed else 1)
