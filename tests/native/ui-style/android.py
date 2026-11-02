#!/usr/bin/env python3
"""Native input and visual evidence for the isolated public-identity UI fixture."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import time
import xml.etree.ElementTree as ET

PACKAGE = 'org.nostrocket.hypergolic.uistyle'
p = argparse.ArgumentParser()
p.add_argument('--serial', required=True)
p.add_argument('--output', required=True, type=Path)
p.add_argument('--appearance', choices=['dark', 'light'], default='dark')
p.add_argument('--font-scale', type=float, default=1.0)
a = p.parse_args()
if not a.serial.startswith('emulator-') or a.font_scale not in [1.0, 1.5]:
    p.error('Use an explicit emulator and font scale 1.0 or 1.5; physical devices are excluded.')
a.output.mkdir(parents=True, exist_ok=False)
checks = []


def adb(*args, binary=False):
    return subprocess.check_output(['adb', '-s', a.serial, *args], timeout=30, text=not binary)


def nodes():
    adb('shell', 'uiautomator', 'dump', '/sdcard/hypergolic-ui-style.xml')
    xml = adb('exec-out', 'cat', '/sdcard/hypergolic-ui-style.xml')
    result = list(ET.fromstring(xml).iter('node'))
    if not any(n.get('package') == PACKAGE for n in result):
        raise RuntimeError('The isolated UI fixture is not foreground; input stopped.')
    return result, xml


def find(identifier, required=True):
    for n in nodes()[0]:
        if n.get('resource-id', '').split('/')[-1] == identifier:
            return n
    if required:
        raise RuntimeError('Unreachable control: ' + identifier)
    return None


def scroll_up():
    items, _ = nodes()
    scroll = next((n for n in items if n.get('scrollable') == 'true'), items[0])
    x1, y1, x2, y2 = map(int, re.findall(r'\d+', scroll.get('bounds', '')))
    x = (x1 + x2) // 2
    adb('shell', 'input', 'swipe', str(x), str(y1 + (y2 - y1) * 3 // 4),
        str(x), str(y1 + (y2 - y1) // 4), '400')


def tap(identifier):
    for _ in range(8):
        n = find(identifier, False)
        if n is not None:
            x1, y1, x2, y2 = map(int, re.findall(r'\d+', n.get('bounds', '')))
            if x2 > x1 and y2 - y1 >= 100 and n.get('enabled') == 'true':
                adb('shell', 'input', 'tap', str((x1 + x2) // 2), str((y1 + y2) // 2))
                return
        scroll_up()
    raise RuntimeError('Unreachable control: ' + identifier)


def capture(name):
    _, xml = nodes()
    (a.output / (name + '.xml')).write_text(xml)
    (a.output / (name + '.png')).write_bytes(adb('exec-out', 'screencap', '-p', binary=True))


def record(name, condition=True):
    checks.append({'name': name, 'passed': bool(condition)})
    if not condition:
        raise RuntimeError(name + ' failed')


old_font = adb('shell', 'settings', 'get', 'system', 'font_scale').strip()
old_night = adb('shell', 'cmd', 'uimode', 'night').strip()
result = {'scope': 'Android emulator; public identity, no signing or publication',
          'appearance': a.appearance, 'fontScale': a.font_scale, 'checks': checks, 'passed': False}
try:
    adb('shell', 'cmd', 'uimode', 'night', 'yes' if a.appearance == 'dark' else 'no')
    adb('shell', 'settings', 'put', 'system', 'font_scale', str(a.font_scale))
    adb('shell', 'am', 'force-stop', PACKAGE)
    adb('shell', 'am', 'start', '-n', PACKAGE + '/org.nostrocket.hypergolic.dev.MainActivity')
    for _ in range(20):
        time.sleep(1)
        try:
            if find('ui-fixture-empty', False) is not None:
                break
        except RuntimeError:
            continue
    tap('ui-fixture-empty')
    capture('glass-empty')
    tap('empty-open-napplet')
    capture('glass-settings')
    record('empty-shelf')
    tap('settings-napplet-address')
    adb('shell', 'input', 'text', 'not-a-napplet')
    adb('shell', 'input', 'keyevent', '66')
    # The visible action also works on IMEs that do not send onSubmitEditing.
    if find('settings-napplet-error', False) is None:
        adb('shell', 'input', 'keyevent', '4')
        tap('settings-open-napplet')
    error = find('settings-napplet-error')
    record('address-validation', 'naddr1' in error.get('text', ''))
    capture('glass-address-error')
    # Clear focus through the app's own scroll surface before the disclosure.
    for _ in range(5):
        if find('settings-section-identity', False) is not None:
            break
        scroll_up()
    tap('settings-section-identity')
    for _ in range(5):
        if find('settings-import-identity', False) is not None:
            break
        scroll_up()
    tap('settings-import-identity')
    record('grouped-identity-settings', find('identity-import-input').get('password') == 'true')
    capture('glass-import')
    tap('identity-import-cancel')
    tap('settings-done')
    tap('ui-fixture-workspace')
    for _ in range(15):
        if find('increment', False) is not None:
            break
        time.sleep(0.2)
    tap('increment')
    record('native-guest-input')
    capture('glass-active')
    tap('shell-overview')
    capture('glass-overview')
    tap('overview-card-ux-lab-1')
    record('workspace-navigation', find('shell-overview') is not None)
    tap('shell-napplet-menu')
    capture('slim-napplet-menu')
    record('napplet-menu', find('shell-menu-overview') is not None and find('shell-menu-settings') is not None)
    adb('shell', 'input', 'keyevent', '4')
    record('menu-back-dismissal', find('shell-workspace-menu', False) is None and find('shell-napplet-menu') is not None)
    tap('shell-napplet-menu')
    tap('shell-close')
    capture('glass-close')
    tap('close-keep-open')
    record('close-protection', find('shell-napplet-menu') is not None)
    tap('ui-fixture-review')
    content = find('approval-sheet-content').get('text', '')
    record('trusted-review', content == 'A note from my own corner of the network.' and find('approval-sheet-reject') is not None)
    capture('glass-review')
    tap('approval-sheet-reject')
    result['passed'] = True
except Exception as error:
    result['error'] = str(error)
    try:
        capture('failure')
    except Exception:
        pass
finally:
    adb('shell', 'settings', 'put', 'system', 'font_scale', old_font)
    previous_mode = 'yes' if 'yes' in old_night else 'no' if 'no' in old_night else 'auto'
    adb('shell', 'cmd', 'uimode', 'night', previous_mode)
    (a.output / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))
    if not result['passed']:
        raise SystemExit(1)
