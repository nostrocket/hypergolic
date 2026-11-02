#!/usr/bin/env python3
"""Resource tracer acceptance using actual Android accessibility, ADB input and independently verified public bytes."""
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
PACKAGE = 'org.nostrocket.hypergolic.resourcefixture'

def digest(data):
    return hashlib.sha256(data).hexdigest()

def sources():
    files = subprocess.check_output(['git', '-C', str(ROOT), 'ls-files', '-co', '--exclude-standard', '-z']).decode().split('\0')
    paths = [p for p in set(files) if p.startswith(('src/', 'modules/napplet-host/', 'runtime/src/', 'runtime/fixtures/', 'tests/native/resource/', 'src/resources/', 'napplets/resource-lab/')) or p in ('package.json', 'pnpm-lock.yaml', 'app.json')]
    paths += ['runtime/dist/index.html', 'runtime/dist/host.js']
    return {p: digest((ROOT / p).read_bytes()) for p in sorted(paths) if (ROOT / p).is_file()}

class Journey:
    def __init__(self, args):
        self.args = args
        self.out = args.output
        self.out.mkdir(parents=True, exist_ok=False)
        self.result = {'kind': 'hypergolic-android-resource-tracer-v1', 'status': 'running', 'checks': [], 'inputs': [], 'sourceBefore': sources(), 'scope': 'Actual standalone API 36 public-only SDK/Kehto/native HTTPS journey; no protected-identity or published-napplet claim.'}

    def adb(self, *args, binary=False):
        value = subprocess.check_output([self.args.adb, '-s', self.args.serial, *args], timeout=30)
        return value if binary else value.decode().strip()

    def nodes(self):
        self.adb('shell', 'uiautomator', 'dump', '--compressed', '/data/local/tmp/hg-resource.xml')
        xml = self.adb('exec-out', 'cat', '/data/local/tmp/hg-resource.xml', binary=True)
        nodes = list(ET.fromstring(xml).iter('node'))
        if not any(n.get('package') == PACKAGE for n in nodes):
            raise RuntimeError('Intended resource fixture is not foreground')
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
            title = node.get('text') or node.get('content-desc')
            self.input('swipe','500','800','500','1250','350')
            fresh = self.find(title)
            b = re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',fresh.get('bounds',''))
            if not b:
                raise RuntimeError('Control lacks refreshed native bounds')
            x1,y1,x2,y2 = map(int,b.groups())
            if x2 <= x1 or y2 <= y1:
                raise RuntimeError('Control is outside the visible native viewport after observed scroll')
        self.input('tap', str((x1+x2)//2), str((y1+y2)//2))

    def replace_url(self, value):
        fields = [n for n in self.nodes() if n.get('resource-id') == 'url']
        if len(fields) != 1:
            self.input('swipe','500','700','500','1900','450');fields = [n for n in self.nodes() if n.get('resource-id') == 'url']
        assert len(fields) == 1, 'Resource URL must be visible'
        self.tap(fields[0]);self.nodes();self.input('keycombination','113','29');self.input('text',shlex.quote(value))
        assert next(n for n in self.nodes() if n.get('resource-id') == 'url').get('text') == value
        self.input('keyevent','4')

    def media_state(self, paused, timeout=15):
        deadline = time.monotonic() + timeout
        prefix = 'Media paused at ' if paused else 'Media playing at '
        while time.monotonic() < deadline:
            values = [n.get('text','') for n in self.nodes() if n.get('text','').startswith(prefix)]
            if len(values) == 1:
                position = float(values[0].removeprefix(prefix).removesuffix(' s'))
                if paused or position > .5:
                    return position
            time.sleep(.2)
        raise RuntimeError('Media playback state not observed: ' + prefix)

    def media(self):
        sample = json.loads(self.args.media.read_text());self.result['mediaSample'] = sample
        self.replace_url(sample['url']);self.tap(self.find('Load resource'));self.find('Resource loaded.')
        # Scroll the actual guest viewport to expose media controls and the byte receipt.
        self.input('swipe','500','1700','500','650','450')
        nodes = self.nodes()
        receipt = next((n.get('text','') for n in nodes if 'SHA-256 ' + sample['sha256'] in n.get('text','')), None)
        assert receipt and str(sample['bytes']) + ' bytes' in receipt and sample['mime'] in receipt, 'Actual native media Blob hash/size mismatch'
        self.capture('resource-media-loaded');self.check('native-media-exact-bytes-over-2mib')
        # Return to the explicit Play control; scrolling is native input, never JS injection.
        self.input('swipe','500','650','500','1150','350')
        self.tap(self.find('Play resource'));playing = self.media_state(False);self.result['mediaStartedAt'] = playing
        self.tap(self.find('Hide Resource Lab'));self.tap(self.find('Show Resource Lab'))
        paused = self.media_state(True);time.sleep(.6);still = self.media_state(True)
        assert paused > 0 and abs(still-paused) < .15, 'Switch must retain a paused position'
        self.result['mediaSwitchPosition'] = [paused,still];self.capture('resource-media-switch-paused');self.check('native-switch-pause-manual-return')
        self.tap(self.find('Play resource'));resumed = self.media_state(False);assert resumed >= paused
        self.input('keyevent','3');time.sleep(.7)
        self.adb('shell','am','start','-W','-n',PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity')
        paused = self.media_state(True);time.sleep(.6);still = self.media_state(True)
        assert paused > resumed and abs(still-paused) < .15, 'Background/return must pause without restarting'
        self.result['mediaBackgroundPosition'] = [paused,still];self.capture('resource-media-background-paused');self.check('native-background-pause-manual-return')
        self.tap(self.find('Play resource'));self.media_state(False);self.capture('resource-media-manual-play');self.check('native-media-manual-play')

    def audio(self):
        sample = json.loads(self.args.audio.read_text());self.result['audioSample']=sample
        self.reset_guest();self.load_expected(sample)
        self.input('swipe','500','650','500','1150','350');self.tap(self.find('Play resource'))
        # This short sample may end before an accessibility snapshot; an advanced ended position proves playback.
        deadline=time.monotonic()+12;position=0
        while time.monotonic()<deadline:
            labels=[n.get('text','') for n in self.nodes() if re.fullmatch(r'Media (paused|playing) at [0-9.]+ s',n.get('text',''))]
            if labels:
                position=float(labels[0].split(' at ')[1].removesuffix(' s'))
                if position>.1:break
        assert position>.1,'Actual audio-only playback did not advance'
        self.result['audioPlayedTo']=position;self.capture('resource-native-audio-playback');self.check('native-audio-only-exact-bytes-and-playback')

    def diagnostics(self):
        self.tap(self.find('Resource diagnostics'))
        cases=['cancel','owner-epoch','close','background','chunk-cancel','chunk-owner-epoch','chunk-close']
        self.result['diagnostics']=[]
        for case in cases:
            self.find('Waiting for SDK resource');self.tap(self.find('Load resource'));self.find('Resource probe held')
            if case.endswith('cancel'):
                self.tap(self.find('Cancel'));self.find('Load cancelled.')
            elif case=='background':
                self.input('keyevent','3');time.sleep(.6)
                self.adb('shell','am','start','-W','-n',PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity')
            else:
                self.tap(self.find('Revoke resource owner'));self.find('Resource owner revoked')
            self.tap(self.find('Release resource probe'))
            deadline=time.monotonic()+12;report=None
            while time.monotonic()<deadline:
                reports=[n.get('text','') for n in self.nodes() if n.get('text','').startswith(('PASS '+case+':','FAIL '+case+':'))]
                if reports:report=reports[0];break
                time.sleep(.2)
            assert report and report.startswith('PASS '),report or 'No diagnostic receipt'
            if case.endswith('cancel'):self.find('Load cancelled.')
            assert not any(n.get('text','').startswith('Attachment:') for n in self.nodes()),'Revoked/cancelled SDK received a late Blob'
            self.result['diagnostics'].append(report);self.capture('resource-diagnostic-'+case);self.check('native-diagnostic-'+case)
            if case!=cases[-1]:self.tap(self.find('Next resource case'))
        self.tap(self.find('Return to resource journey'));self.find('Ready to load.')

    def reset_guest(self):
        self.tap(self.find('Close Resource Lab'));self.tap(self.find('Open Resource Lab'));self.find('Ready to load.')

    def load_expected(self, sample):
        self.replace_url(sample['url']);self.tap(self.find('Load resource'));self.find('Resource loaded.')
        self.input('swipe','500','1700','500','850','450')
        receipt = next((n.get('text','') for n in self.nodes() if 'SHA-256 ' + sample['sha256'] in n.get('text','')),None)
        assert receipt and str(sample['bytes']) + ' bytes' in receipt and sample['mime'] in receipt, 'Delivered resource bytes do not match independent sample'

    def settings(self, disabled):
        self.tap(self.find('Download settings'));self.find('Blossom downloads')
        if disabled:
            field = next(n for n in self.nodes() if n.get('resource-id') == 'resource-servers')
            self.tap(field);self.input('keycombination','113','29');self.input('keyevent','67');self.input('keyevent','4')
            self.tap(self.find('Save download servers'))
        else:
            self.tap(self.find('Restore download defaults'))
        self.find('Download servers saved.');self.capture('resource-settings-disabled' if disabled else 'resource-settings-defaults')
        self.tap(self.find('Return to Resource Lab'))

    def schemes(self):
        samples = json.loads(self.args.schemes.read_text());self.result['schemeSamples']=samples
        self.reset_guest();self.settings(False);self.load_expected(samples['blossom']);self.capture('resource-blossom-verified');self.check('native-blossom-default-redirect-and-sha256')
        self.settings(True);self.load_expected(samples['blossom']);self.check('native-loaded-memory-cache-retention')
        self.reset_guest();self.replace_url(samples['blossom']['url']);self.tap(self.find('Load resource'));self.find('Load failed: blocked-by-policy');self.check('native-close-revokes-cache')
        self.adb('shell','am','force-stop',PACKAGE);self.adb('shell','am','start','-W','-n',PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity');self.find('Ready to load.')
        self.replace_url(samples['blossom']['url']);self.tap(self.find('Load resource'));self.find('Load failed: blocked-by-policy');self.check('native-download-settings-persist-cold-launch')
        self.settings(False);self.load_expected(samples['blossom'])
        self.load_expected(samples['nostr']);self.capture('resource-nostr-one-hop');self.check('native-nostr-verified-event-json')
        self.load_expected(samples['data']);self.capture('resource-data-json');self.check('native-host-mediated-data-bytes')
        self.replace_url('https://localtest.me/private');self.tap(self.find('Load resource'));self.find('Load failed: blocked-by-policy');self.capture('resource-private-dns-denial');self.check('native-private-dns-denial')
        # Default bulk fields exercise ordered success, unsupported scheme and local data.
        self.input('swipe','500','1700','500','650','450');self.tap(self.find('Load bulk'));self.find('3 bulk results.')
        rows=[n.get('text','') for n in self.nodes() if '; SHA-256 ' in n.get('text','') or 'htree:unsupported: unsupported-scheme' in n.get('text','')]
        assert len(rows)==3 and samples['image']['sha256'] in rows[0] and 'unsupported-scheme' in rows[1] and samples['bulkDataHash'] in rows[2], 'Bulk results lost order or byte identity'
        self.capture('resource-bulk-ordered');self.check('native-bulk-ordered-per-item-errors')

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

    def load(self):
        self.tap(self.find('Load resource')); self.find('Resource loaded.')
        nodes = self.nodes()
        sample = json.loads(self.args.sample.read_text())
        if not any('SHA-256 ' + sample['sha256'] in n.get('text','') for n in nodes):
            self.input('swipe','500','1700','500','1250','300');nodes = self.nodes()
        receipt = next((n.get('text','') for n in nodes if 'SHA-256 ' + sample['sha256'] in n.get('text','')), None)
        assert receipt and str(sample['bytes']) + ' bytes' in receipt and 'image/png' in receipt, 'Native Blob differs from independent bytes'
        assert any(n.get('text') == 'Loaded resource' or n.get('content-desc') == 'Loaded resource' for n in nodes), 'Decoded image not exposed'

    def run(self):
        sample = json.loads(self.args.sample.read_text()); self.result['sample'] = sample
        installed = self.adb('shell', 'pm', 'path', PACKAGE).splitlines(); assert len(installed) == 1
        actual = self.adb('exec-out', 'cat', installed[0].removeprefix('package:'), binary=True)
        assert digest(actual) == digest(self.args.apk.read_bytes()), 'Installed APK differs from final build'
        self.result['installedApkSha256'] = digest(actual); self.result['webView'] = self.adb('shell', 'dumpsys', 'webviewupdate')
        self.adb('shell', 'am', 'force-stop', PACKAGE)
        self.adb('shell', 'am', 'start', '-W', '-n', PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity')
        if self.args.diagnostics_only:
            self.find('Native host connected'); self.find('Ready to load.');self.diagnostics()
            self.result['sourceAfter']=sources();assert self.result['sourceBefore']==self.result['sourceAfter'], 'Source changed during native journey'
            self.result['status']='passed';return
        self.find('Native host connected'); self.find('Ready to load.'); self.load(); self.check('https-exact-image'); self.capture('resource-exact-image')
        self.tap(self.find('Release preview')); assert not any(n.get('text') == 'Loaded resource' for n in self.nodes())
        self.tap(self.find('Check support'))
        assert any('10485760' in n.get('text','') for n in self.nodes()), 'Native selected info not returned'
        self.check('info'); self.capture('resource-info')
        self.replace_url('https://127.0.0.1/private');self.tap(self.find('Load resource'));self.find('Load failed: blocked-by-policy')
        self.check('private-denial'); self.capture('resource-private-denial')
        self.tap(self.find('Close Resource Lab')); self.find('Open Resource Lab')
        assert not any(n.get('class') == 'android.webkit.WebView' for n in self.nodes()), 'Closed guest remains exposed'
        self.tap(self.find('Open Resource Lab')); self.find('Ready to load.'); self.load(); self.check('close-reopen'); self.capture('resource-reopened')
        self.adb('shell','am','force-stop',PACKAGE); self.adb('shell','am','start','-W','-n',PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity')
        self.find('Ready to load.'); self.load(); self.check('cold-restart'); self.capture('resource-cold-restart')
        if self.args.media:
            self.media()
        if self.args.schemes:
            self.schemes()
        if self.args.audio:
            self.audio()
        if self.args.diagnostics:
            self.diagnostics()
        self.result['sourceAfter'] = sources(); assert self.result['sourceBefore'] == self.result['sourceAfter'], 'Source changed during native journey'
        self.result['status'] = 'passed'

if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True); parser.add_argument('--adb', default=str(ROOT/'.tools/android-sdk/platform-tools/adb'))
    parser.add_argument('--apk',type=Path,required=True); parser.add_argument('--sample',type=Path,required=True); parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--media',type=Path)
    parser.add_argument('--schemes',type=Path)
    parser.add_argument('--audio',type=Path)
    parser.add_argument('--diagnostics',action='store_true')
    parser.add_argument('--diagnostics-only',action='store_true')
    journey=Journey(parser.parse_args())
    try:
        journey.run()
    except Exception as error:
        journey.result.update(status='failed', error=str(error))
        raise
    finally:
        (journey.out/'result.json').write_text(json.dumps(journey.result,indent=2)+'\n')
