#!/usr/bin/env python3
"""Read-only relay query acceptance using actual Android accessibility and ADB input."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shlex
import subprocess
import time
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[3]
PACKAGE = 'org.nostrocket.hypergolic.feedqueryfixture'

def digest(data):
    return hashlib.sha256(data).hexdigest()

def sources():
    files = subprocess.check_output(['git', '-C', str(ROOT), 'ls-files', '-co', '--exclude-standard', '-z']).decode().split('\0')
    paths = [p for p in set(files) if p.startswith(('src/', 'modules/napplet-host/', 'runtime/src/', 'runtime/fixtures/', 'tests/native/feed-query/')) or p in ('package.json', 'pnpm-lock.yaml', 'app.json')]
    paths += ['runtime/dist/index.html', 'runtime/dist/host.js']
    return {p: digest((ROOT / p).read_bytes()) for p in sorted(paths) if (ROOT / p).is_file()}

class Journey:
    def __init__(self, args):
        self.args = args
        self.out = args.output
        self.out.mkdir(parents=True, exist_ok=False)
        self.result = {'kind': 'hypergolic-android-relay-query-v1', 'status': 'running', 'checks': [], 'inputs': [], 'sourceBefore': sources(), 'scope': 'Actual standalone API 36 public-only SDK/native/WSS journey; no protected-identity or published-napplet claim.'}

    def adb(self, *args, binary=False):
        value = subprocess.check_output([self.args.adb, '-s', self.args.serial, *args], timeout=30)
        return value if binary else value.decode().strip()

    def nodes(self):
        self.adb('shell', 'uiautomator', 'dump', '--compressed', '/data/local/tmp/hg-feed-query.xml')
        xml = self.adb('exec-out', 'cat', '/data/local/tmp/hg-feed-query.xml', binary=True)
        nodes = list(ET.fromstring(xml).iter('node'))
        if not any(n.get('package') == PACKAGE for n in nodes):
            raise RuntimeError('Intended query fixture is not foreground')
        self.xml = xml
        return nodes

    def find(self, title, timeout=25):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            found = [n for n in self.nodes() if n.get('text') == title or n.get('content-desc') == title]
            clickable = [n for n in found if n.get('clickable') == 'true']
            if len(clickable) == 1:
                return clickable[0]
            if len(found) == 1:
                return found[0]
            time.sleep(.2)
        raise RuntimeError('Timed out observing: ' + title)

    def input(self, *args):
        self.result['inputs'].append(list(args))
        return self.adb('shell', 'input', *args)

    def tap(self, node):
        b = re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', node.get('bounds', ''))
        if not b:
            raise RuntimeError('Observed control lacks visible bounds')
        x1,y1,x2,y2 = map(int, b.groups())
        if x2 <= x1 or y2 <= y1:
            raise RuntimeError('Control is outside the visible native viewport')
        self.input('tap', str((x1+x2)//2), str((y1+y2)//2))

    def filter(self, value):
        nodes = self.nodes()
        fields = [n for n in nodes if n.get('class') == 'android.widget.EditText']
        if len(fields) != 2:
            raise RuntimeError('Expected query filters followed by the editable draft')
        self.tap(fields[0])
        self.nodes()  # Observe after focus/keyboard transition before selection.
        self.input('keycombination', '113', '29')
        self.input('text', shlex.quote(value))
        current = [n for n in self.nodes() if n.get('class') == 'android.widget.EditText']
        if len(current) != 2 or current[0].get('text') != value:
            raise RuntimeError('Native input did not replace the exact query filters')
        self.input('keyevent', '4')

    def capture(self, name):
        self.nodes()
        (self.out/(name+'.xml')).write_bytes(self.xml)
        image = self.adb('exec-out', 'screencap', '-p', binary=True)
        if not image.startswith(b'\x89PNG'):
            raise RuntimeError('Invalid native screenshot')
        (self.out/(name+'.png')).write_bytes(image)
        self.result.setdefault('captures', []).append({'name':name,'sha256':digest(image),'visuallyInspected':False})

    def check(self, name):
        self.result['checks'].append(name)
        print('PASS ' + name, flush=True)

    def run(self):
        sample = json.loads(self.args.sample.read_text())
        event = sample['event']
        assert re.fullmatch('[0-9a-f]{64}', event['id'])
        self.result['eventId'] = event['id']
        self.result['independentSampleSha256'] = digest(self.args.sample.read_bytes())
        installed = self.adb('shell', 'pm', 'path', PACKAGE).splitlines()
        assert len(installed) == 1
        actual = self.adb('exec-out', 'cat', installed[0].removeprefix('package:'), binary=True)
        assert digest(actual) == digest(self.args.apk.read_bytes()), 'Installed APK does not match final build'
        self.result['installedApkSha256'] = digest(actual)
        self.result['webView'] = self.adb('shell', 'dumpsys', 'webviewupdate')
        self.adb('shell', 'am', 'force-stop', PACKAGE)
        self.adb('shell', 'am', 'start', '-W', '-n', PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity')
        self.find('Native host connected')
        self.find('Ready to query.')
        self.filter(json.dumps([{'ids':[event['id']], 'limit':1}], separators=(',',':')))
        self.tap(self.find('Query notes'))
        self.find('Received 1 signed note.')
        # IDs can be below the viewport; scroll with native input until observed.
        for _ in range(5):
            nodes = self.nodes()
            if any(n.get('text') == event['id'] for n in nodes):
                break
            self.input('swipe', '540', '1800', '540', '950', '350')
        else:
            raise RuntimeError('Exact independently verified event ID not observed')
        assert any(n.get('text') == event['content'] for n in nodes), 'Returned note content differs from independent sample'
        self.check('exact-signed-event'); self.capture('query-exact-event')
        self.input('swipe', '540', '900', '540', '1900', '350')
        self.tap(self.find('Query empty sample'))
        self.find('Query completed. No matching notes.')
        self.check('empty-eose'); self.capture('query-empty')
        self.filter('[{"authors":["partial"]}]')
        self.tap(self.find('Query notes'))
        self.find('Query failed: invalid relay query')
        self.check('invalid-filter-denial'); self.capture('query-invalid-denial')
        self.tap(self.find('Close Feed Lab'))
        self.find('Open Feed Lab')
        assert not any(n.get('class') == 'android.webkit.WebView' for n in self.nodes()), 'Closed guest remains exposed'
        self.tap(self.find('Open Feed Lab')); self.find('Ready to query.')
        self.tap(self.find('Query empty sample')); self.find('Query completed. No matching notes.')
        self.check('close-reopen'); self.capture('query-reopened')
        self.adb('shell', 'am', 'force-stop', PACKAGE)
        self.adb('shell', 'am', 'start', '-W', '-n', PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity')
        self.find('Ready to query.'); self.tap(self.find('Query empty sample'))
        self.find('Query completed. No matching notes.')
        self.check('cold-restart'); self.capture('query-cold-restart')
        self.result['sourceAfter'] = sources()
        assert self.result['sourceBefore'] == self.result['sourceAfter'], 'Query source changed during native run'
        self.result['status'] = 'passed'

if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True); parser.add_argument('--adb', default=str(ROOT/'.tools/android-sdk/platform-tools/adb'))
    parser.add_argument('--apk',type=Path,required=True); parser.add_argument('--sample',type=Path,required=True); parser.add_argument('--output',type=Path,required=True)
    journey=Journey(parser.parse_args())
    try:
        journey.run()
    except Exception as error:
        journey.result.update(status='failed', error=str(error))
        raise
    finally:
        (journey.out/'result.json').write_text(json.dumps(journey.result,indent=2)+'\n')
