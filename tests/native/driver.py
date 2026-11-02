#!/usr/bin/env python3
"""Observe and exercise the actual Android host. Never substitutes browser tests."""
from __future__ import annotations
import argparse
import hashlib
import io
import zipfile
import json
import os
from pathlib import Path
import re
import shutil
import secrets
from receiver import Receiver
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]
IMPLEMENTED = ('trace-host', 'host-boundary', 'renderer-loss', 'network-receiver',
               'navigation-boundary', 'diagnostic-boundary')

class CheckFailed(RuntimeError):
    pass

def run(args, timeout=30, binary=False, check=True):
    result = subprocess.run([str(a) for a in args], stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout)
    if check and result.returncode:
        # Commands contain only public test data, never identities or secrets.
        raise CheckFailed(f'{Path(str(args[0])).name} failed ({result.returncode}): '
                          + result.stderr.decode(errors='replace')[:800])
    return result.stdout if binary else result.stdout.decode(errors='replace').strip()

def parse_nodes(xml):
    tree = ET.fromstring(xml)
    nodes = []
    def visit(element, depth=0):
        is_web = element.get('class') == 'android.webkit.WebView'
        if element.tag == 'node':
            node = dict(element.attrib)
            node['_webview-depth'] = depth
            nodes.append(node)
        for child in element:
            visit(child, depth + int(is_web))
    visit(tree)
    return nodes

def outer_webview(nodes):
    # Chromium can expose a nested virtual WebView with slightly different bounds.
    # Preserve the actual XML hierarchy instead of arbitrarily choosing by area.
    return exactly_one(nodes, lambda n: n.get('class') == 'android.webkit.WebView'
                       and n.get('_webview-depth') == 0, 'outer native WebView')

def node_bounds(node):
    match = re.fullmatch(r'\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]', node.get('bounds', ''))
    if not match:
        raise CheckFailed('Control lacks valid observed bounds')
    x1, y1, x2, y2 = map(int, match.groups())
    if x2 <= x1 or y2 <= y1:
        raise CheckFailed('Control is not currently visible')
    return x1, y1, x2, y2

def exactly_one(nodes, predicate, description):
    found = [n for n in nodes if predicate(n)]
    if len(found) != 1:
        raise CheckFailed(f'{description}: expected one observed control, found {len(found)}')
    node_bounds(found[0])
    return found[0]

def label(node):
    return node.get('content-desc') or node.get('text', '')

def is_increment(n):
    return bool(re.fullmatch(r'Add one(?:\s*\+)?', label(n))) and n.get('clickable') == 'true'

def is_draft(n):
    return n.get('class') == 'android.widget.EditText' and n.get('enabled') == 'true'

def counter_value(nodes):
    # WebView exposes aria-label and output text either together or on descendants.
    candidates = [n for n in nodes if n.get('resource-id', '').split('/')[-1] == 'counter']
    if not candidates:
        candidates = [n for n in nodes if label(n).startswith('Counter')]
    for node in candidates:
        text = ' '.join([node.get('text', ''), node.get('content-desc', '')])
        match = re.search(r'\b(\d+)\b', text)
        if match:
            return int(match.group(1))
    # No broad digit search: section indices would make a false counter assertion.
    raise CheckFailed('Counter value is not exposed unambiguously in Android hierarchy')

class Driver:
    def __init__(self, args):
        self.args = args
        self.out = Path(args.output).resolve()
        if (self.out / 'result.json').exists():
            raise CheckFailed('Output already contains a result; choose a fresh run directory')
        self.out.mkdir(parents=True, exist_ok=True)
        self.adb = args.adb or shutil.which('adb')
        if not self.adb:
            local = ROOT / '.tools/android-sdk/platform-tools/adb'
            self.adb = str(local) if local.exists() else None
        if not self.adb:
            raise CheckFailed('ADB unavailable; enable pinned local tools')
        self.result = {'schemaVersion': 1, 'scenario': args.scenario, 'status': 'running',
                       'startedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                       'scope': 'actual Android debug runtime; not release or full v1 proof',
                       'checks': [], 'captures': [], 'limitations': []}

    def adb_run(self, *args, **kwargs):
        return run([self.adb, '-s', self.args.serial, *args], **kwargs)

    def nodes(self):
        # Capture only the intended app's activity; no unrelated-app screenshot.
        self.adb_run('shell', 'uiautomator', 'dump', '/sdcard/hypergolic-driver-ui.xml', timeout=15)
        xml = self.adb_run('exec-out', 'cat', '/sdcard/hypergolic-driver-ui.xml', binary=True)
        nodes = parse_nodes(xml)
        if not any(n.get('package') == self.args.package for n in nodes):
            raise CheckFailed('Target package is not visible in Android hierarchy')
        return xml, nodes

    def wait(self, predicate, description, timeout=None, expected_error=None):
        deadline = time.monotonic() + (timeout or self.args.timeout)
        last_error = None
        while time.monotonic() < deadline:
            try:
                xml, nodes = self.nodes()
                failure = [label(n) for n in nodes if label(n).startswith('Runtime unavailable:')]
                if failure and failure != [expected_error]:
                    raise CheckFailed(failure[0])
                if predicate(nodes):
                    return xml, nodes
            except (CheckFailed, ET.ParseError, subprocess.TimeoutExpired) as exc:
                last_error = str(exc)
                if str(exc).startswith('Runtime unavailable:'):
                    raise
            time.sleep(0.25)  # Poll interval only; completion depends on observation.
        raise CheckFailed(f'Timed out observing {description}' + (f': {last_error}' if last_error else ''))

    def check(self, name, details):
        self.result['checks'].append({'name': name, 'status': 'passed', 'details': details})

    def capture(self, name):
        xml, nodes = self.nodes()
        (self.out / f'{name}.xml').write_bytes(xml)
        png = self.adb_run('exec-out', 'screencap', '-p', binary=True)
        if not png.startswith(b'\x89PNG\r\n\x1a\n'):
            raise CheckFailed('ADB screenshot was not a PNG')
        (self.out / f'{name}.png').write_bytes(png)
        self.result['captures'].append({'name': name, 'pngSha256': hashlib.sha256(png).hexdigest(),
                                        'xmlSha256': hashlib.sha256(xml).hexdigest(),
                                        'visuallyInspected': False})
        return nodes

    def tap(self, node):
        x1, y1, x2, y2 = node_bounds(node)
        self.adb_run('shell', 'input', 'tap', str((x1+x2)//2), str((y1+y2)//2))

    def metadata(self):
        if self.adb_run('get-state') != 'device':
            raise CheckFailed('Requested ADB device is not authorized/online')
        if self.adb_run('shell', 'getprop', 'sys.boot_completed') != '1':
            raise CheckFailed('Requested Android device has not completed boot')
        properties = {k: self.adb_run('shell', 'getprop', v) for k, v in {
            'model': 'ro.product.model', 'android': 'ro.build.version.release',
            'api': 'ro.build.version.sdk', 'abi': 'ro.product.cpu.abi'}.items()}
        properties['kind'] = 'emulator' if self.args.serial.startswith('emulator-') else 'physical'
        properties['display'] = self.adb_run('shell', 'wm', 'size')
        properties['density'] = self.adb_run('shell', 'wm', 'density')
        webview = self.adb_run('shell', 'dumpsys', 'webviewupdate')
        match = re.search(r'Current WebView package \(name, version\): \(([^,]+), ([^)]+)\)', webview)
        properties['webView'] = {'package': match[1], 'version': match[2]} if match else {'status': 'unavailable'}
        package = self.adb_run('shell', 'dumpsys', 'package', self.args.package)
        app = {'package': self.args.package}
        for k, pattern in {'versionName':r'versionName=([^\s]+)', 'versionCode':r'versionCode=(\d+)',
                           'targetSdk':r'targetSdk=(\d+)'}.items():
            m = re.search(pattern, package)
            app[k] = m[1] if m else None
        app['debuggable'] = 'DEBUGGABLE' in package
        app['installedBinaryMatchesCurrentNativeSource'] = 'unproven; compare recorded APK hash with build/install evidence'
        apk = self.adb_run('shell', 'pm', 'path', self.args.package)
        base = [p.removeprefix('package:') for p in apk.splitlines() if p.endswith('/base.apk')]
        if len(base) != 1:
            raise CheckFailed('Expected exactly one installed base APK')
        apk_bytes = self.adb_run('exec-out', 'cat', base[0], binary=True)
        app['installedBaseApkSha256'] = hashlib.sha256(apk_bytes).hexdigest()
        with zipfile.ZipFile(io.BytesIO(apk_bytes)) as archive:
            app['installedRuntimeAssetSha256'] = {name: hashlib.sha256(archive.read(name)).hexdigest()
                for name in ['assets/runtime/index.html', 'assets/runtime/host.js'] if name in archive.namelist()}
            app['installedRuntimeAssetBytes'] = {name: archive.getinfo(name).file_size
                for name in app['installedRuntimeAssetSha256']}
        git = lambda *args: run(['git', '-C', ROOT, *args])
        hashes = {}
        for path in ['src/App.tsx', 'src/runtime/NappletHost.tsx', 'runtime/dist/index.html',
                     'runtime/dist/host.js', 'runtime/fixtures/ux-lab.html', 'runtime/assets-manifest.json',
                     'modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host/NappletHostView.kt']:
            f = ROOT/path
            if f.exists():
                hashes[path] = hashlib.sha256(f.read_bytes()).hexdigest()
        self.result['device'] = properties
        self.result['app'] = app
        self.result['source'] = {'commit': git('rev-parse', 'HEAD'), 'branch': git('branch', '--show-current'),
                                 'workingFileSha256': hashes, 'gitStatus': git('status', '--short').splitlines()}

    def connect(self):
        if self.args.launch:
            result = self.adb_run('shell', 'am', 'start', '-W', '-n', f'{self.args.package}/.MainActivity')
            if 'Status: ok' not in result:
                raise CheckFailed('Android did not report successful app launch')
        _, nodes = self.wait(lambda ns: any(label(n)=='Runtime connected' for n in ns), 'native Runtime connected')
        self.check('native-runtime-connected', 'Native shell diagnostic observed in Android hierarchy')
        self.result['webViewAccessibilityDescendants'] = any(label(n).startswith('Ready ·') for n in nodes)
        if self.result['webViewAccessibilityDescendants']:
            self.wait(lambda ns: any(label(n)=='Host colors' for n in ns), 'real host theme result')
            self.check('fixture-theme', 'Ready and Host colors observed in Android hierarchy')
        else:
            snap = self.dom_snapshot()
            if not snap.get('ready', '').startswith('Ready ·') or snap.get('theme') != 'Host colors':
                raise CheckFailed('Actual WebView fixture readiness/theme not established')
            self.check('fixture-theme', 'Native diagnostic from Android hierarchy; actual fixture readiness/theme from read-only debug WebView attachment')
        self.result['initialWebViewAccessibilityDescendants'] = self.result['webViewAccessibilityDescendants']
        captured = self.capture('01-connected')
        self.result['webViewAccessibilityDescendants'] = any(label(n).startswith('Ready ·') for n in captured)

    def scroll_to(self, predicate, description):
        for _ in range(8):
            _, nodes = self.nodes()
            candidates = [n for n in nodes if predicate(n)]
            if candidates:
                return exactly_one(nodes, predicate, description)
            web = exactly_one(nodes, lambda n: n.get('class')=='android.webkit.WebView' and n.get('scrollable')=='true', 'scrollable WebView')
            x1,y1,x2,y2 = node_bounds(web)
            x=(x1+x2)//2
            self.adb_run('shell','input','swipe',str(x),str(y1+(y2-y1)*3//4),str(x),str(y1+(y2-y1)//3),'350')
        raise CheckFailed(f'{description} not reached by observed WebView scrolling')

    def dom_snapshot(self):
        node = shutil.which('node')
        if not node:
            raise CheckFailed('Pinned Node unavailable for actual WebView observation')
        output = run([node, ROOT/'tests/native/webview-probe.mjs', '--serial', self.args.serial,
                      '--package', self.args.package, '--mode', 'snapshot'], timeout=30)
        value = json.loads(output)
        if value.get('status') != 'passed':
            raise CheckFailed('Actual WebView DOM observation failed: '+str(value.get('error')))
        return value['snapshot']

    def dom_control(self, name):
        for _ in range(10):
            snap = self.dom_snapshot()
            box = snap['controls'][name]
            viewport = snap['viewport']
            if box and box['y'] >= 0 and box['y']+box['height'] <= viewport['height']:
                return snap, box
            _, nodes = self.nodes()
            web = outer_webview(nodes)
            x1,y1,x2,y2 = node_bounds(web)
            x=(x1+x2)//2
            down = box is None or box['y'] > viewport['height']/2
            a,b=(0.75,0.30) if down else (0.30,0.75)
            self.adb_run('shell','input','swipe',str(x),str(int(y1+(y2-y1)*a)),str(x),str(int(y1+(y2-y1)*b)),'350')
        raise CheckFailed('Actual DOM control not reached through native scrolling: '+name)

    def tap_dom(self, snap, box):
        _, nodes = self.nodes()
        web = outer_webview(nodes)
        x1,y1,x2,y2 = node_bounds(web)
        # CSS coordinates from existing untrusted frame map into fresh native WebView bounds.
        x=x1+(box['x']+box['width']/2)*(x2-x1)/snap['viewport']['width']
        y=y1+(box['y']+box['height']/2)*(y2-y1)/snap['viewport']['height']
        if not (x1 < x < x2 and y1 < y < y2):
            raise CheckFailed('DOM control maps outside actual native WebView')
        self.adb_run('shell','input','tap',str(round(x)),str(round(y)))

    def trace(self):
        if self.result['webViewAccessibilityDescendants']:
            node = self.scroll_to(is_increment, 'Add one')
            _, before = self.nodes()
            try:
                initial = counter_value(before)
                self.result['counterValueObservation'] = 'Android hierarchy'
            except CheckFailed:
                initial = int(self.dom_snapshot()['counter'])
                self.result['counterValueObservation'] = 'read-only actual WebView DOM; numeric value absent from accessibility tree'
            self.tap(node)
            if self.result['counterValueObservation'] == 'Android hierarchy':
                _, after = self.wait(lambda ns: counter_value(ns)==initial+1, 'counter increment')
                actual = counter_value(after)
            else:
                actual = int(self.dom_snapshot()['counter'])
                if actual != initial+1:
                    raise CheckFailed('Native counter tap did not increment exactly once')
        else:
            snap, box = self.dom_control('increment')
            initial = int(snap['counter'])
            self.tap_dom(snap,box)
            actual = int(self.dom_snapshot()['counter'])
            if actual != initial+1:
                raise CheckFailed(f'Native counter tap did not increment exactly once: {initial} -> {actual}')
        self.check('adb-counter-tap', {'before': initial, 'after': actual,
                   'coordinateSource': 'Android hierarchy' if self.result['webViewAccessibilityDescendants'] else 'read-only actual frame DOM + native WebView bounds'})
        self.capture('02-counter')
        marker = 'NativeTrace' + str(int(time.time()))
        if self.result['webViewAccessibilityDescendants']:
            self.tap(self.scroll_to(is_draft, 'temporary note field'))
        else:
            snap,box = self.dom_control('draft')
            self.tap_dom(snap,box)
        self.adb_run('shell','input','text',marker)
        snap=self.dom_snapshot()
        if marker not in snap['draft'] or marker not in snap['mirror']:
            raise CheckFailed('Native input did not update both real textarea and mirror')
        ime = self.adb_run('shell', 'dumpsys', 'input_method')
        was_shown = bool(re.search(r'mInputShown=true\b', ime))
        if was_shown:
            self.adb_run('shell','input','keyevent','4')
            deadline = time.monotonic()+5
            while re.search(r'mInputShown=true\b', self.adb_run('shell','dumpsys','input_method')):
                if time.monotonic()>deadline:
                    raise CheckFailed('Keyboard remained visible after one observed-IME Back dismissal')
                time.sleep(0.1)
        self.check('keyboard-dismissed', {'wasShown':was_shown,'observedThrough':'Android input_method mInputShown'})
        self.check('adb-draft-input', {'marker':marker,'mirrorObserved':True})
        self.capture('03-draft')
        self.result['limitations'] = [
            'One loaded UX fixture only; no gestures, identities, signing or remote loading proven.',
            'Debug app uses Metro; not a standalone release test.',
            'PNG captures require separate visual inspection; XML cannot prove rendering quality.']
        if self.result.get('counterValueObservation', '').startswith('read-only'):
            self.result['limitations'].append('Counter aria-label masks its numeric value in Android accessibility tree; actual DOM verification is not a screen-reader value pass.')
        if not self.result['webViewAccessibilityDescendants']:
            self.result['limitations'].append('Android hierarchy omits fixture descendants. Read-only DOM/CDP observations enabled actual coordinate ADB input, but accessibility acceptance is failed/unproven.')

    def boundary(self):
        if not self.result['app']['debuggable']:
            raise CheckFailed('CDP attack probe is diagnostic-only and requires the debug build')
        pid = self.adb_run('shell','pidof',self.args.package).split()
        sockets = self.adb_run('shell','cat','/proc/net/unix')
        targets = [line.split()[-1] for line in sockets.splitlines()
                   if any(line.endswith('@webview_devtools_remote_'+p) for p in pid)]
        if len(targets)!=1:
            raise CheckFailed('No unique current-app WebView devtools socket; boundary test unimplemented for this build')
        self.check('actual-webview-debug-endpoint', {'pidCount':len(pid),'matchingSockets':len(targets)})
        node = shutil.which('node')
        if not node:
            raise CheckFailed('Pinned Node unavailable; source local tools')
        run([node, ROOT/'tests/native/webview-probe.mjs', '--serial', self.args.serial,
             '--package', self.args.package, '--output', self.out/'boundary.json'],timeout=60,check=False)
        self.result['boundary'] = json.loads((self.out/'boundary.json').read_text())
        if self.result['boundary'].get('status')!='passed':
            raise CheckFailed('Actual WebView boundary probe did not pass: '+str(self.result['boundary'].get('error')))
        self.check('actual-webview-boundary', self.result['boundary']['checks'])
        self.capture('02-boundary')
        self.result['limitations'] = self.result['boundary']['unproven']

    def renderer_loss(self):
        self.session_loss('renderer-loss','renderer-stopped','rendererLoss')

    def session_loss(self, mode, expected_code, record_key):
        if not self.result['app']['debuggable']:
            raise CheckFailed('Native session-destruction diagnostics require an authorized debug build')
        pid = self.adb_run('shell', 'pidof', self.args.package).split()
        if len(pid) != 1:
            raise CheckFailed('Expected one current target app process')
        socket = 'webview_devtools_remote_' + pid[0]
        unix = self.adb_run('shell', 'cat', '/proc/net/unix')
        if not any(line.endswith('@' + socket) for line in unix.splitlines()):
            raise CheckFailed('Current app has no observable WebView debug socket')
        # Only forward this app's observed socket. Remove only our own allocated port.
        port = self.adb_run('forward', 'tcp:0', 'localabstract:' + socket)
        if not port.isdigit():
            raise CheckFailed('ADB did not allocate a diagnostic port')
        try:
            def targets():
                with urlopen('http://127.0.0.1:' + port + '/json/list', timeout=2) as response:
                    rows = json.load(response)
                if not isinstance(rows, list):
                    raise CheckFailed('Unexpected WebView target inventory')
                return [{k: row.get(k) for k in ('id', 'type', 'url')} for row in rows]
            before = targets()
            pages = [row for row in before if row['type'] == 'page']
            if len(pages) != 1 or not pages[0]['url'].startswith('https://appassets.androidplatform.net/assets/runtime/index.html?'):
                raise CheckFailed('Expected one actual host executable target before the destructive probe')
            self.result[record_key] = {'appPidBefore': pid[0], 'targetsBefore': before}
            node = shutil.which('node')
            if not node:
                raise CheckFailed('Pinned Node unavailable')
            probe_path = self.out / (mode+'.json')
            run([node, ROOT/'tests/native/webview-probe.mjs', '--serial', self.args.serial,
                 '--package', self.args.package, '--mode', mode, '--output', probe_path],
                timeout=30, check=False)
            probe = json.loads(probe_path.read_text())
            self.result[record_key]['probe'] = probe
            if probe.get('status') != 'passed':
                raise CheckFailed(mode+' unsupported or unobserved: '+str(probe.get('error')))
            expected = 'Runtime unavailable: '+expected_code
            _, nodes = self.wait(lambda ns: any(label(n) == expected for n in ns),
                                 'native '+expected_code+' callback', expected_error=expected)
            self.check('native-'+expected_code, 'Native diagnostic observed independently in Android hierarchy')
            if any(n.get('class') == 'android.webkit.WebView' for n in nodes):
                raise CheckFailed('Native error was reported but WebView remains attached')
            self.check('native-webview-removed', 'No native or virtual WebView remains in target app hierarchy')
            after_pid = self.adb_run('shell', 'pidof', self.args.package).split()
            if after_pid != pid:
                raise CheckFailed('Target app process was restarted or stopped; destruction not isolated to renderer')
            self.check('native-app-survived', {'sameAppPid': pid[0]})
            deadline = time.monotonic() + 8
            after = None
            while time.monotonic() < deadline:
                try:
                    after = targets()
                    if not after:
                        break
                except Exception as error:
                    unix = self.adb_run('shell', 'cat', '/proc/net/unix')
                    if not any(line.endswith('@' + socket) for line in unix.splitlines()):
                        after = {'socketRemoved': True, 'inventoryError': str(error)}
                        break
                time.sleep(0.2)
            else:
                raise CheckFailed('An app-specific WebView debugging target survives session destruction')
            self.result[record_key]['targetsAfter'] = after
            self.check('no-executable-webview-target', after)
            self.capture('02-'+expected_code)
            self.result['limitations'] = [
                'This destructive mode proves only '+mode+'; its probe records the exact authority and trigger. No broad process kill or new native test bridge is used.',
                'The app is intentionally left at its captured native error screen; explicitly relaunch for a fresh session.',
                'Other navigation/SSL triggers, stale generation replay, direct forged native origin/isMainFrame, pre-ready traffic and unregistered siblings remain phase 06 evidence gaps.',
                'Independent receiver-side egress observation and release-mode hostile fixtures remain phase 06 requirements.',
                'No release, physical-device, identity/signing or full v1 acceptance is claimed.']
        finally:
            self.adb_run('forward', '--remove', 'tcp:' + port, check=False)

    def run_probe(self, mode, **extra):
        node = shutil.which('node')
        if not node:
            raise CheckFailed('Pinned Node unavailable')
        output = self.out / (mode+'.json')
        command = [node,ROOT/'tests/native/webview-probe.mjs','--serial',self.args.serial,
                   '--package',self.args.package,'--mode',mode,'--output',output]
        for key,value in extra.items():
            command.extend(['--'+key,value])
        run(command,timeout=45,check=False)
        value=json.loads(output.read_text())
        self.result[mode]=value
        if value.get('status')!='passed':
            raise CheckFailed(mode+' probe failed: '+str(value.get('error')))
        return value

    def network_receiver(self):
        nonce=secrets.token_hex(12)
        with Receiver() as receiver:
            port=str(receiver.port)
            self.adb_run('reverse','--no-rebind','tcp:'+port,'tcp:'+port)
            def control(stage,websocket=False):
                kind='ws' if websocket else 'http'
                path='/control/'+nonce+'/'+stage+'/'+kind
                headers=['GET '+path+' HTTP/1.1','Host: 127.0.0.1:'+port]
                if websocket:
                    headers.extend(['Upgrade: websocket','Connection: Upgrade',
                                    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==','Sec-WebSocket-Version: 13'])
                else:
                    headers.append('Connection: close')
                payload=('\r\n'.join(headers)+'\r\n\r\n').encode()
                process=subprocess.Popen([self.adb,'-s',self.args.serial,'shell','toybox','nc','-w','3','-W','3',
                                          '127.0.0.1',port],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
                try:
                    # Android toybox nc can exit on stdin EOF before forwarding
                    # queued bytes. Keep only this process's stdin open until its
                    # observed HTTP response closes the socket; no timing guess.
                    process.stdin.write(payload)
                    process.stdin.flush()
                    process.wait(timeout=7)
                except Exception:
                    process.kill()
                    process.wait(timeout=3)
                    raise
                finally:
                    process.stdin.close()
                response=process.stdout.read().decode(errors='replace')
                stderr=process.stderr.read().decode(errors='replace')
                self.result.setdefault('receiverControlObservations',[]).append(
                    {'path':path,'returnCode':process.returncode,'response':response,'stderr':stderr})
                status='101' if websocket else '200'
                if websocket and 'Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=' not in response:
                    raise CheckFailed('WebSocket control lacked the correct handshake response')
                if not re.match(r'HTTP/1\.1 '+status+r'\b',response):
                    raise CheckFailed('Device-to-receiver '+kind+' positive control failed')
                if not any(row['path']==path for row in receiver.receipts):
                    raise CheckFailed('Positive control missing from independent receiver')
                return {'path':path,'status':status,'deviceTransport':'ADB shell toybox nc over scoped reverse',
                        'sameWebViewPolicy':False}
            try:
                before=[control('before'),control('before',True)]
                value=self.run_probe('network-receiver',endpoint='http://127.0.0.1:'+port+'/attempt/'+nonce)
                # Errors/CSP events are already observed. This bounded quiet period
                # records receiver silence rather than fabricating browser success.
                time.sleep(1)
                after=[control('after'),control('after',True)]
                attempts=[row for row in receiver.receipts if row['path'].startswith('/attempt/'+nonce+'/')]
                report={'nonce':nonce,'receiverBind':'127.0.0.1','receiverPort':receiver.port,
                        'positiveControlsBefore':before,'positiveControlsAfter':after,
                        'receipts':receiver.receipts,'attemptReceipts':attempts,'quietWindowSeconds':1,
                        'limits':['Controls prove Android-device transport to the receiver, not permission from the sandboxed WebView.',
                                  'Only the recorded nonce-specific HTTP/WS child attempts are measured; no general egress claim.',
                                  'CSP, mixed-content and native network layers remain enabled; denial is not attributed to an unobserved single layer.']}
                self.result['receiver']=report
                (self.out/'receiver.json').write_text(json.dumps(report,indent=2)+'\n')
                if attempts:
                    raise CheckFailed('Independent receiver observed forbidden child traffic')
                self.check('independent-receiver-controls',{'before':before,'after':after})
                self.check('no-nonce-specific-child-receipts',{'attemptReceipts':len(attempts),'quietWindowSeconds':1})
                self.wait(lambda ns:any(label(n)=='Runtime connected' for n in ns),'continued native connection')
                self.capture('02-receiver')
                self.result['limitations']=report['limits']+value['unproven']
            finally:
                self.result['receiverReceipts']=list(receiver.receipts)
                # This reverse was created with --no-rebind, so we own its removal.
                self.adb_run('reverse','--remove','tcp:'+port,check=False)

    def navigation_boundary(self):
        surfaces=self.run_probe('navigation-surfaces')
        self.wait(lambda ns:any(label(n)=='Runtime connected' for n in ns),'continued native connection after non-destructive navigation attempts')
        self.check('navigation-surfaces-denied',surfaces['checks'])
        self.capture('02-navigation-surfaces')
        self.session_loss('self-navigation','frame-navigation','navigationLoss')
        self.result['limitations'].extend(surfaces['unproven'])

    def diagnostic_boundary(self):
        rejections=self.run_probe('diagnostic-rejections')
        self.wait(lambda ns:any(label(n)=='Runtime connected' for n in ns),'continued native ready after invalid diagnostics')
        # Fresh attachment performs a real post-rejection fixture/theme observation.
        if self.dom_snapshot()['theme']!='Host colors':
            raise CheckFailed('Real runtime was not usable after rejected diagnostics')
        self.check('invalid-diagnostics-preserve-session',rejections['diagnostics'])
        self.capture('02-diagnostic-rejections')
        self.session_loss('diagnostic-control','diagnostic-probe','diagnosticLoss')
        self.result['limitations'].extend(rejections['unproven'])

    def save(self):
        self.result['finishedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
        (self.out/'result.json').write_text(json.dumps(self.result,indent=2)+'\n')

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial',required=True,help='Explicit authorized Android target')
    parser.add_argument('--package',default='org.nostrocket.hypergolic.dev')
    parser.add_argument('--adb')
    parser.add_argument('--timeout',type=float,default=25)
    parser.add_argument('--launch',action='store_true',help='Start existing app; never installs, force-stops or clears data')
    parser.add_argument('scenario')
    parser.add_argument('--output',required=True,help='Fresh private evidence directory')
    args=parser.parse_args()
    if args.scenario not in IMPLEMENTED:
        parser.error('Scenario is not implemented: '+args.scenario)
    if not re.fullmatch(r'[A-Za-z0-9_.]+',args.package):
        parser.error('Invalid Android package')
    driver=None
    try:
        driver=Driver(args)
        driver.metadata()
        driver.connect()
        {'trace-host':driver.trace, 'host-boundary':driver.boundary,
         'renderer-loss':driver.renderer_loss,'network-receiver':driver.network_receiver,
         'navigation-boundary':driver.navigation_boundary,
         'diagnostic-boundary':driver.diagnostic_boundary}[args.scenario]()
        driver.result['status']='passed'
        return 0
    except Exception as exc:
        if driver:
            driver.result['status']='failed'
            driver.result['error']=str(exc)[:1200]
            try: driver.capture('failure')
            except Exception as capture_error: driver.result['captureError']=str(capture_error)[:400]
        print('FAILED: '+str(exc),file=sys.stderr)
        return 1
    finally:
        if driver:
            driver.save()
            print(json.dumps({'status':driver.result['status'],'scenario':args.scenario,
                              'checks':len(driver.result['checks']),'result':str(driver.out/'result.json')}))

if __name__=='__main__':
    sys.exit(main())
