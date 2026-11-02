#!/usr/bin/env python3
"""Physical disposable normal-Expo storage faults; exact owned cleanup is mandatory."""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import re
import subprocess
import time
import uuid
import xml.etree.ElementTree as ET

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
PACKAGE = 'org.nostrocket.hypergolic.identitystorageprobe'
KEEPER = 'org.nostrocket.hypergolic.emptyacceptance'
KEEPER_HASH = '9efd2af6933a9da5ff9e399117dd8f6b8488bdebad5f14bdf795a9437ae73046'
RUNNER = 'org.nostrocket.hypergolic.identityowner.StorageFaultInstrumentation'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def decode_npub(value):
    alphabet = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
    if not re.fullmatch('npub1[023456789acdefghjklmnpqrstuvwxyz]{58}', value):
        raise RuntimeError('Invalid public identity encoding')
    words = [alphabet.index(c) for c in value[5:]]
    expanded = [ord(c) >> 5 for c in 'npub'] + [0] + [ord(c) & 31 for c in 'npub']
    check = 1
    for v in expanded + words:
        top = check >> 25
        check = ((check & 0x1ffffff) << 5) ^ v
        for i, generator in enumerate([0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]):
            if (top >> i) & 1:
                check ^= generator
    if check != 1:
        raise RuntimeError('Public identity checksum differs')
    bits = 0
    acc = 0
    raw = bytearray()
    for v in words[:-6]:
        acc = (acc << 5) | v
        bits += 5
        if bits >= 8:
            bits -= 8
            raw.append((acc >> bits) & 255)
    if len(raw) != 32 or bits >= 5 or (acc & ((1 << bits) - 1)):
        raise RuntimeError('Invalid public identity padding')
    return raw.hex()


class Proof:
    def __init__(self, serial, build, output):
        self.serial, self.build, self.output = serial, build.resolve(), output.resolve()
        self.output.mkdir(parents=True, exist_ok=False)
        self.adb = str(REPO / '.tools/android-sdk/platform-tools/adb')
        self.r = {'status': 'incomplete', 'dateUTC': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'scope': 'Fresh disposable normal Expo app, actual SDK encrypted records/native Keystore, six faults and two cold failed starts each. No owner data access, device reboot, system-auth or actual backup-transport proof.',
            'driverSha256': sha(Path(__file__)), 'installations': [], 'native': [], 'starts': [], 'captures': [], 'cleanup': []}
        self.owned = {}
        self.baseline = None
        self.selected = None
        self.native_process = None
        self.install_process = None
        self.save()

    def save(self):
        (self.output / 'receipt.json').write_text(json.dumps(self.r, indent=2) + '\n')

    def call(self, *args, timeout=25, binary=False):
        return subprocess.run([self.adb, '-s', self.serial, *args], capture_output=True, text=not binary, timeout=timeout)

    def ok(self, *args, timeout=25, binary=False):
        result = self.call(*args, timeout=timeout, binary=binary)
        if result.returncode != 0:
            self.r.setdefault('adbFailures', []).append({'command': list(args), 'exitCode': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr})
            self.save()
            raise RuntimeError('ADB action failed: ' + ' '.join(args[:3]) + ' exit ' + str(result.returncode))
        return result.stdout if binary else result.stdout.strip()

    def installed(self, pkg):
        result = self.call('shell', 'pm', 'path', pkg)
        if result.returncode == 1 and not result.stdout.strip() and not result.stderr.strip():
            return None
        if result.returncode or not re.fullmatch(r'package:/data/app/[A-Za-z0-9_~+/=.\-]+/base\.apk', result.stdout.strip()):
            raise RuntimeError('Unexpected installed package response')
        return self.ok('shell', 'sha256sum', result.stdout.strip()[8:]).split()[0]

    def rows(self, installer=False):
        remote = '/sdcard/hg-storage-observer-' + uuid.uuid4().hex + '.xml'
        try:
            for attempt in range(4):
                result = self.call('shell', 'uiautomator', 'dump', '--compressed', remote)
                if result.returncode == 0:
                    break
                self.r.setdefault('observerFailures', []).append({'attempt': attempt+1, 'exitCode': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr, 'inputReplayed': False})
                self.save()
                if result.returncode != 137 or attempt == 3:
                    raise RuntimeError('Read-only UI observer failed exit ' + str(result.returncode))
                time.sleep(.5)
            raw = self.ok('exec-out', 'cat', remote, binary=True)
        finally:
            self.call('shell', 'rm', remote)
        if b'nsec1' in raw:
            raise RuntimeError('Unexpected private-key surface; refuse capture')
        rows = [dict(n.attrib) for n in ET.fromstring(raw).iter('node')]
        pkg = 'com.miui.securitycenter' if installer else PACKAGE
        if not any(n.get('package') == pkg for n in rows):
            raise RuntimeError('Expected owned UI not foreground')
        return raw, rows

    def capture(self, name, raw=None):
        if raw is None:
            raw, _ = self.rows()
        png = self.ok('exec-out', 'screencap', '-p', binary=True)
        if not png.startswith(b'\x89PNG'):
            raise RuntimeError('Invalid original screenshot')
        (self.output / (name + '.xml')).write_bytes(raw)
        (self.output / (name + '.png')).write_bytes(png)
        self.r['captures'].append({'name': name, 'xmlSha256': hashlib.sha256(raw).hexdigest(), 'pngSha256': hashlib.sha256(png).hexdigest(), 'visuallyReviewed': False})
        self.save()

    def wait(self, predicate, label, limit=45):
        deadline = time.monotonic() + limit
        while time.monotonic() < deadline:
            raw, rows = self.rows()
            if predicate(rows):
                return raw, rows
            time.sleep(.2)
        raise RuntimeError('Owned UI deadline: ' + label)

    def press(self, node):
        if node.get('package') not in [PACKAGE, 'com.miui.securitycenter'] or node.get('enabled') != 'true':
            raise RuntimeError('Invalid owned enabled button')
        b = list(map(int, re.findall(r'\d+', node.get('bounds', ''))))
        if len(b) != 4 or b[2] <= b[0] or b[3] <= b[1]:
            raise RuntimeError('Invalid observed button bounds')
        x, y = str((b[0]+b[2])//2), str((b[1]+b[3])//2)
        self.ok('shell', 'input', 'touchscreen', 'swipe', x, y, x, y, '120')

    def install(self, kind):
        pkg = PACKAGE + ('.test' if kind == 'test' else '')
        record = {'package': pkg, 'kind': kind, 'attempts': 1, 'expectedSha256': self.owned[pkg]}
        self.r['installations'].append(record)
        self.save()
        with (self.output / (kind + '-install.log')).open('w') as log:
            process = subprocess.Popen([self.adb, '-s', self.serial, 'install', '-t', str(self.build / (kind + '.apk'))], stdout=log, stderr=subprocess.STDOUT)
            self.install_process = process
            deadline = time.monotonic() + 18
            while process.poll() is None and time.monotonic() < deadline:
                top = self.ok('shell', 'dumpsys', 'activity', 'activities')
                if 'com.miui.permcenter.install.AdbInstallActivity' not in '\n'.join(l for l in top.splitlines() if 'topResumedActivity' in l):
                    time.sleep(.2)
                    continue
                raw, rows = self.rows(installer=True)
                texts = [n.get('text', '') for n in rows if n.get('package') == 'com.miui.securitycenter']
                buttons = [n for n in rows if n.get('package') == 'com.miui.securitycenter' and n.get('text') in ['Install', 'INSTALL', 'Allow', 'ALLOW'] and n.get('enabled') == 'true' and n.get('clickable') == 'true']
                if 'Hypergolic Storage Test' not in texts or len(buttons) != 1:
                    raise RuntimeError('Unexpected installer identity/buttons; no decision sent')
                (self.output / (kind + '-installer.xml')).write_bytes(raw)
                record['ordinaryInstallButton'] = {'text': buttons[0]['text'], 'bounds': buttons[0]['bounds']}
                self.save()
                self.press(buttons[0])
                break
            try:
                record['exitCode'] = process.wait(timeout=40)
            except subprocess.TimeoutExpired:
                # A client observation timeout is not proof of native terminal state.
                record['uncertainInstall'] = True
                self.save()
                process.wait(timeout=40)
                record['exitCode'] = process.returncode
            self.install_process = None
            self.save()
            if record['exitCode'] != 0 or self.installed(pkg) != self.owned[pkg]:
                raise RuntimeError('Installation denied or incomplete; no automatic retry')
        print('Installed ' + kind, flush=True)

    def stop(self):
        self.ok('shell', 'am', 'force-stop', PACKAGE)
        value = self.call('shell', 'pidof', PACKAGE)
        if value.returncode != 1 or value.stdout.strip():
            raise RuntimeError('Owned app did not stop')

    def start(self, label, failed=False):
        self.stop()
        result = self.ok('shell', 'am', 'start', '-W', '-n', PACKAGE + '/org.nostrocket.hypergolic.dev.MainActivity', timeout=45)
        if 'Error:' in result:
            raise RuntimeError('Ordinary activity launch failed')
        if failed:
            raw, rows = self.wait(lambda n: any(a.get('resource-id') == 'identity-entry-status' for a in n) and any(a.get('text') == 'Your identity needs attention' for a in n), label)
            if any(a.get('resource-id') == 'shell-settings' or a.get('class') == 'android.webkit.WebView' or a.get('resource-id') in ['napplet','identity'] for a in rows):
                raise RuntimeError('Fault startup admitted identity shell or guest')
            if not any(a.get('text') == 'Your saved identity could not be opened. Restart the app to try again. Hypergolic has not replaced your identity.' for a in rows):
                raise RuntimeError('Expected exact recovery detail missing')
        else:
            raw, rows = self.wait(lambda n: any(a.get('resource-id') == 'shell-settings' and a.get('content-desc','').startswith('Settings for npub1') for a in n), label)
            found = [a['content-desc'][13:] for a in rows if a.get('resource-id') == 'shell-settings']
            if len(found) != 1:
                raise RuntimeError('Ambiguous shell identity')
            public = decode_npub(found[0])
            if self.selected is not None and public != self.selected:
                raise RuntimeError('Original disposable identity changed')
            self.selected = public
            self.r['selectedPublicKey'], self.r['selectedNpub'] = public, found[0]
        pid = self.ok('shell', 'pidof', PACKAGE)
        self.r['starts'].append({'label': label, 'failedClosed': failed, 'stoppedBeforeLaunch': True, 'pidAfter': pid})
        self.capture(label, raw)
        print(label, flush=True)

    def reveal(self, resource):
        for _ in range(30):
            raw, rows = self.rows()
            found = [n for n in rows if n.get('package') == PACKAGE and n.get('resource-id') == resource]
            if len(found) == 1:
                b = list(map(int,re.findall(r'\d+',found[0].get('bounds',''))))
                if len(b) == 4 and b[3]-b[1] > 50:
                    return found[0]
            scrolls = [n for n in rows if n.get('package') == PACKAGE and n.get('scrollable') == 'true']
            if not scrolls:
                scrolls = [n for n in rows if n.get('package') == PACKAGE and n.get('resource-id') == 'napplet']
            if not scrolls:
                raise RuntimeError('Observed scroll container unavailable for '+resource)
            b = list(map(int,re.findall(r'\d+',scrolls[-1]['bounds'])))
            x = str(b[0]+(b[2]-b[0])//20)
            self.ok('shell','input','swipe',x,str(b[1]+(b[3]-b[1])*4//5),x,str(b[1]+(b[3]-b[1])*3//5),'600')
        raise RuntimeError('Original control unreachable: '+resource)

    def open_state_lab(self):
        self.press(self.reveal('shell-settings'))
        self.wait(lambda n:any(a.get('resource-id')=='settings-full-npub' for a in n),'normal Settings')
        self.press(self.reveal('settings-open-state-lab'))
        self.wait(lambda n:any(a.get('resource-id')=='identity' and a.get('text')==self.selected for a in n),'original SDK public key')
        value = 'development-storage-'+uuid.uuid4().hex
        self.r['guestSavedValue'] = value
        self.save()
        self.press(self.reveal('value'))
        self.ok('shell','input','text',value)
        self.ok('shell','input','keyevent','4')
        self.press(self.reveal('write'))
        self.wait(lambda n:any(a.get('resource-id')=='status' and a.get('text')=='Write confirmed.' for a in n),'original SDK confirmed write')
        self.capture('normal-state-lab-write')
        print('Original State Lab SDK write confirmed',flush=True)

    def check_saved_guest(self,label):
        self.wait(lambda n:any(a.get('resource-id')=='identity' and a.get('text')==self.selected for a in n),'restored original SDK identity')
        self.press(self.reveal('read'))
        raw, _ = self.wait(lambda n:any(a.get('resource-id')=='result' and a.get('text')==self.r['guestSavedValue'] for a in n),'original SDK saved value reuse')
        self.capture(label,raw)
        self.r.setdefault('guestContinuity',[]).append({'label':label,'exactPublicIdentity':self.selected,'exactSavedValue':self.r['guestSavedValue'],'originalSdkRead':True})
        self.save()

    def native(self, mode):
        self.stop()
        path = self.output / ('native-' + str(len(self.r['native'])+1).zfill(2) + '-' + mode + '.log')
        with path.open('w') as log:
            self.native_process = subprocess.Popen([self.adb, '-s', self.serial, 'shell', 'am', 'instrument', '-w', '-r', '-e', 'mode', mode, '-e', 'selected', self.selected, PACKAGE+'.test/'+RUNNER], stdout=log, stderr=subprocess.STDOUT)
            try:
                rc = self.native_process.wait(timeout=90)
            except subprocess.TimeoutExpired:
                self.r['nativeTimeout'] = {'mode': mode, 'clientPid': self.native_process.pid}
                self.save()
                self.stop()
                self.native_process.wait(timeout=25)
                raise RuntimeError('Owned native job cancelled after deadline; original retained')
            finally:
                if self.native_process.poll() is not None:
                    self.native_process = None
        raw = path.read_text()
        if 'nsec1' in raw:
            raise RuntimeError('Unexpected private native result')
        fields = {}
        for line in raw.splitlines():
            if line.startswith('INSTRUMENTATION_RESULT: '):
                k, v = line[len('INSTRUMENTATION_RESULT: '):].split('=',1)
                if k in fields:
                    raise RuntimeError('Duplicate native result')
                fields[k] = v
        entry = {'mode': mode, 'exitCode': rc, 'fields': fields, 'logSha256': sha(path)}
        self.r['native'].append(entry)
        self.save()
        if rc != 0 or fields.get('result') != 'passed' or fields.get('selectedPublicKey') != self.selected or int(fields.get('assertions','0')) <= 0 or 'INSTRUMENTATION_CODE: -1' not in raw:
            raise RuntimeError('Native proof failed at ' + fields.get('step',mode))
        if mode == 'checkpoint' and fields.get('noNewWrappingAliasOrMetadataIdentity') != 'true':
            raise RuntimeError('Native no-replacement checkpoint absent')
        print('Native ' + mode + ': ' + fields['assertions'] + ' assertions', flush=True)

    def cleanup(self):
        if self.install_process is not None and self.install_process.poll() is None:
            # Reconcile this exact live installation before any uninstall. Never replay it.
            self.install_process.wait(timeout=45)
        if self.native_process is not None and self.native_process.poll() is None:
            self.stop()
            self.native_process.wait(timeout=25)
        for pkg, digest in reversed(list(self.owned.items())):
            current = self.installed(pkg)
            if current is None:
                self.r['cleanup'].append({'package':pkg,'alreadyAbsent':True})
                continue
            if current != digest:
                raise RuntimeError('Refuse removal of changed owned app')
            action = {'package':pkg,'expectedSha256':digest,'uninstallSent':True}
            self.r['cleanup'].append(action)
            self.save()
            value = self.call('uninstall',pkg,timeout=40)
            action['exitCode'],action['result'] = value.returncode,value.stdout.strip()
            if value.returncode != 0 or value.stdout.strip() != 'Success' or self.installed(pkg) is not None:
                raise RuntimeError('Owned cleanup incomplete')
            action['absenceVerified'] = True
            self.save()
        if self.installed(KEEPER) != KEEPER_HASH:
            raise RuntimeError('Retained Hypergolic APK changed')
        inventory = self.ok('shell','pm','list','packages','hypergolic').splitlines()
        if inventory != ['package:'+KEEPER]:
            raise RuntimeError('Unexpected post-batch Hypergolic packages')
        self.r['packageInventoryAfter'] = inventory
        self.r['keeperApkUnchanged'] = True
        self.r['ownedPackagesRemoved'] = True
        self.ok('shell','input','keyevent','3')
        self.save()

    def run(self):
        try:
            build = json.loads((self.build/'receipt.json').read_text())
            if build['status'] != 'compiled-not-executed' or not build['sourceInputsUnchanged'] or build['applicationId'] != PACKAGE:
                raise RuntimeError('Unsealed or wrong build')
            inputs = json.loads((self.build/'source-inputs.json').read_text())
            if any(not (REPO/name).is_file() or sha(REPO/name) != digest for name,digest in inputs.items()):
                raise RuntimeError('Compiled source input changed')
            if self.ok('get-state') != 'device' or self.ok('shell','getprop','ro.kernel.qemu') == '1' or int(self.ok('shell','getprop','ro.build.version.sdk')) < 31:
                raise RuntimeError('Physical API31+ Android required')
            if self.installed(KEEPER) != KEEPER_HASH:
                raise RuntimeError('Retained app differs from approved current app')
            self.r['packageInventoryBefore'] = self.ok('shell','pm','list','packages','hypergolic').splitlines()
            self.r['sourceHead'] = subprocess.check_output(['git','rev-parse','HEAD'],cwd=REPO,text=True).strip()
            self.r['compiledInputCount'] = len(inputs)
            for kind in ['app','test']:
                pkg = PACKAGE + ('.test' if kind == 'test' else '')
                if self.installed(pkg) is not None:
                    raise RuntimeError('Fresh test target required; refuse existing app')
                digest = build['products'][kind]['sha256']
                if sha(self.build/(kind+'.apk')) != digest:
                    raise RuntimeError('Sealed APK bytes changed')
                self.owned[pkg] = digest
            self.save()
            self.install('app')
            self.install('test')
            self.start('normal-first-start')
            self.open_state_lab()
            self.native('snapshot')
            for mode in ['corrupt-inventory','corrupt-secret','missing-inventory','missing-secret','legacy-inventory','missing-wrapping-key']:
                self.native(mode)
                self.start(mode+'-cold-1',failed=True)
                self.start(mode+'-cold-2',failed=True)
                self.native('checkpoint')
                if mode != 'missing-wrapping-key':
                    self.native('restore')
                    self.start(mode+'-restored')
                    self.check_saved_guest(mode+'-restored-guest')
            if any(not (REPO/name).is_file() or sha(REPO/name) != digest for name,digest in inputs.items()):
                raise RuntimeError('Compiled inputs changed during physical execution')
            self.r['compiledInputsUnchanged'] = True
            self.r['status'] = 'passed-scoped-normal-expo-storage-faults-awaiting-original-visual-review'
        except BaseException as error:
            self.r['status'] = 'failed-or-incomplete'
            self.r['failureType'],self.r['failure'] = type(error).__name__,str(error)
            print(self.r['failure'],flush=True)
        finally:
            self.save()
            self.cleanup()
            self.save()
        print(json.dumps({'status':self.r['status'],'nativeCases':len(self.r['native']),'starts':len(self.r['starts']),'ownedPackagesRemoved':self.r.get('ownedPackagesRemoved')}),flush=True)
        if self.r['status'] == 'failed-or-incomplete':
            raise SystemExit(1)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial',required=True)
    parser.add_argument('--build',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args = parser.parse_args()
    Proof(args.serial,args.build,args.output).run()
