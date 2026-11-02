#!/usr/bin/env python3
"""Signed local artifact through normal shell, consent, persisted grant and native upload."""
import argparse,json,re,time,os,xml.etree.ElementTree as ET
from pathlib import Path
from importlib.util import spec_from_file_location,module_from_spec
from evidence import ROOT,sha,sources,large_wav
spec=spec_from_file_location('journey',Path(__file__).with_name('android-upload.py'));module=module_from_spec(spec);spec.loader.exec_module(module)
class Published(module.Journey):
    picker=False
    def nodes(self):
        if not self.picker:return super().nodes()
        deadline=time.monotonic()+15
        while time.monotonic()<deadline:
            self.adb('shell','uiautomator','dump','--compressed','/data/local/tmp/hg-upload.xml')
            self.xml=self.adb('exec-out','cat','/data/local/tmp/hg-upload.xml',binary=True);nodes=list(ET.fromstring(self.xml).iter('node'))
            packages={n.get('package') for n in nodes}
            if 'com.google.android.documentsui' in packages:return nodes
            assert module.PACKAGE in packages,'Unexpected foreground during picker handoff'
            time.sleep(.2)
        raise AssertionError('Known document picker did not become foreground')
    def selected_wav(self):
        wav=large_wav();expected='Selected bytes: '+str(len(wav))+'; SHA-256: '+sha(wav)
        seed=self.args.output/'published-proof.wav';seed.write_bytes(wav);self.adb('shell','mkdir','-p','/sdcard/Download/UploadPublished');self.adb('push',str(seed),'/sdcard/Download/UploadPublished/published-proof.wav')
        self.guest_find('selection');self.tap('selection');self.picker=True
        self.tap('Show roots');self.tap('sdk_gphone64_arm64');self.tap('Download');self.tap('UploadPublished');self.capture('system-selected-WAV');self.tap('published-proof.wav');self.picker=False
        self.find('selected-status');assert expected in self.find('selected-status').get('text','');self.capture('selected-WAV-guest-handoff')
        baseline=self.observer()
        def review():
            self.guest_find('Request selected upload');self.tap('Request selected upload');self.find('Approve file upload');self.find('upload-attachment-inspection');assert self.find('Approve once').get('enabled')=='true';self.capture('selected-WAV-review')
        review();self.tap('Reject upload');self.find('Upload cancelled.');assert self.observer()==baseline;self.tap('upload-outcome');self.guest_find('Read selected file');self.tap('Read selected file');assert expected in self.find('selected-status').get('text','');self.check('normal signed system picker retains exact selected WAV after upload rejection')
        review();self.tap('Approve once');self.find('Upload confirmed by server.');value=self.observer();rows=value['requests'][len(baseline['requests']):];assert len(rows)==1 and rows[0]['sha256']==sha(wav) and rows[0]['size']==len(wav) and rows[0]['mimeType']=='audio/wav' and rows[0]['signatureVerified'];self.capture('selected-WAV-confirmed');self.check('normal signed selected WAV exact body and signature');self.tap('upload-outcome')

    def settings_find(self,label):
        for _ in range(20):
            nodes=self.nodes();matches=[n for n in nodes if label in (n.get('text'),n.get('content-desc'),n.get('resource-id')) and self.visible(n)]
            if len(matches)==1:return matches[0]
            views=[n for n in nodes if n.get('class')=='android.widget.ScrollView' and self.visible(n)]
            assert len(views)==1,'Settings scroll view not uniquely observed'
            x1,y1,x2,y2=map(int,re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',views[0].get('bounds')).groups())
            args=['swipe',str((x1+x2)//2),str(y1+int((y2-y1)*.8)),str((x1+x2)//2),str(y1+int((y2-y1)*.25)),'400']
            self.report['inputs'].append({'control':'observed settings scroll','input':args});self.adb('shell','input',*args)
        raise AssertionError('Settings control not exposed: '+label)
    def settings_tap(self,label):
        self.settings_find(label);self.tap(label)
    def start(self):self.adb('shell','am','start','-W','-n',module.PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity')
    def run(self):
        build=json.loads(self.args.build.read_text());assert build['status']=='built' and build['entry']=='published' and build['sourceAfter']==self.report['sourceBefore'] and build['productSha256']==sha(self.args.apk.read_bytes())
        installed=self.adb('shell','pm','path',module.PACKAGE).removeprefix('package:');assert sha(self.adb('exec-out','cat',installed,binary=True))==build['productSha256']
        self.report.update(kind='hypergolic-android-published-upload-v1',productSha256=build['productSha256'],scope='Actual normal IdentityShell/Settings/consent/SQLite/cache/runtime/native owner with signed local artifact, public disposable identity and proof TLS. No public relay/provider or protected-device claim.')
        control=self.args.observer.parent/'control.json';control.write_text(json.dumps({'put':'normal','get':'normal','release':False}));baseline=self.observer();self.report['observerBefore']=baseline
        self.adb('shell','am','force-stop',module.PACKAGE);self.adb('shell','pm','clear',module.PACKAGE);self.start()
        address=self.find('signed-upload-address').get('content-desc');assert address.startswith('naddr1');self.tap('shell-settings');self.settings_tap('settings-napplet-address');self.adb('shell','input','text',address);self.adb('shell','input','keyevent','4')
        self.settings_tap('settings-open-napplet');self.settings_find('Allow this napplet?');self.capture('first-open-consent')
        self.settings_find('Requested access: upload');self.settings_find('Upload access allows this napplet to read files you select. Every upload still needs your separate approval of the file, identity and server.')
        self.settings_tap('settings-napplet-reject');assert self.observer()==baseline;self.check('normal first-open rejection has zero TLS and no grant')
        self.settings_tap('settings-open-napplet');self.settings_find('Allow this napplet?');self.settings_tap('settings-napplet-approve');self.find('Ready to request a PNG upload.');self.capture('signed-sdk-ready');self.check('signed manifest admitted through normal settings and native binding')
        self.guest_find('Read upload limits');self.tap('Read upload limits');self.find('upload-info')
        deadline=time.monotonic()+10
        while time.monotonic()<deadline:
            text=self.find('upload-info').get('text','')
            if 'maxBytes' in text:break
            time.sleep(.1)
        info=json.loads(text);assert info['maxBytes']==10485760 and info['rails']==[{'rail':'blossom','enabled':True,'returns':['https','blossom']},{'rail':'nip96','enabled':False}] and self.observer()==baseline;self.capture('native-SDK-upload-info');self.check('native SDK advisory upload info without network')
        self.review();self.tap('Reject upload');self.find('Upload cancelled.');assert self.observer()==baseline;self.check('upload rejection zero TLS');self.tap('upload-outcome')
        self.review();self.tap('Approve once');self.find('Upload confirmed by server.');self.capture('confirmed');value=self.observer();requests=value['requests'][len(baseline['requests']):]
        assert len(requests)==1 and value['connections']==baseline['connections']+1 and requests[0]['sha256']==module.HASH and requests[0]['size']==71 and requests[0]['signatureVerified'] and not value['errors'];self.check('approved exact bytes and independent Schnorr signature')
        self.tap('upload-outcome');self.guest_find('Read upload status');self.tap('Read upload status');self.guest_find('Upload complete.');self.capture('original-sdk-receipt')
        receipt=next((json.loads(n.get('text','')) for n in self.nodes() if '\"status\": \"complete\"' in n.get('text','') and module.HASH in n.get('text','')),None)
        assert receipt and receipt['sha256']==module.HASH and receipt['size']==71 and receipt['mimeType']=='image/png' and receipt['url']=='https://files.example.com:19943/'+module.HASH+'.png';self.check('original signed recipient SDK receipt')
        self.selected_wav()
        before=self.observer();self.adb('shell','am','force-stop',module.PACKAGE);self.start();self.find('Ready to request a PNG upload.');self.capture('persisted-cold-restart');assert self.observer()==before and not any(n.get('text')=='Allow this napplet?' for n in self.nodes());self.check('cold restart restores cached signed workspace and grant without automatic upload')
        self.report['observerAfter']=self.observer();self.report['sourceAfter']=sources();assert self.report['sourceBefore']==self.report['sourceAfter'];self.report['status']='passed'
if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for name in ['serial','apk','build','observer','output']:p.add_argument('--'+name,required=True,type=str if name=='serial' else Path)
    journey=Published(p.parse_args())
    try:journey.run()
    except Exception as error:
        journey.report.update(status='failed',error=str(error))
        try:journey.capture('failure')
        except Exception:pass
        raise
    finally:(journey.args.output/'result.json').write_text(json.dumps(journey.report,indent=2)+'\n')
