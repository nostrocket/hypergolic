#!/usr/bin/env python3
"""Actual SDK/native review journey checked against a separate TLS observer."""
import argparse,json,os,re,subprocess,time,xml.etree.ElementTree as ET
from pathlib import Path
from evidence import ROOT,sha,sources
PACKAGE='org.nostrocket.hypergolic.uploadfixture'
HASH='5a852fbaaaecaf4cd14c01e150c7f881c5c5894b0a1e3c53be7e007c58374ee6'
class Journey:
    def __init__(self,args):
        self.args=args;args.output.mkdir(parents=True,exist_ok=False)
        self.report={'kind':'hypergolic-android-upload-v1','status':'running','checks':[],'inputs':[],'sourceBefore':sources(),'scope':'Actual isolated SDK/Kehto/native review and loopback TLS with a disposable identity. No picker, protected-device identity or public provider acceptance.'}
    def adb(self,*args,binary=False):
        data=subprocess.check_output([str(ROOT/'.tools/android-sdk/platform-tools/adb'),'-s',self.args.serial,*args],timeout=30)
        return data if binary else data.decode().strip()
    def nodes(self):
        if os.environ.get('HYPERGOLIC_UPLOAD_UI_DUMP') == 'fast':
            self.adb('shell','rm','-f','/data/local/tmp/hg-upload.xml')
            result=self.adb('shell','CLASSPATH=/system/framework/android.test.base.jar:/system/framework/android.test.runner.jar:/system/framework/uiautomator.jar:/data/local/tmp/hg-upload-uia.jar','app_process','/system/bin','com.android.commands.uiautomator.Launcher','runtest','-c','org.nostrocket.hypergolic.proof.FastUiDump','-e','jars','/data/local/tmp/hg-upload-uia.jar')
            assert 'aborted' not in result and 'INSTRUMENTATION_STATUS_CODE: 0' in result and 'OK (1 test)' in result,'Native UI observer failed'
        else:self.adb('shell','uiautomator','dump','--compressed','/data/local/tmp/hg-upload.xml')
        self.xml=self.adb('exec-out','cat','/data/local/tmp/hg-upload.xml',binary=True)
        nodes=list(ET.fromstring(self.xml).iter('node'))
        assert any(n.get('package')==PACKAGE for n in nodes),'Upload fixture is not foreground'
        return nodes
    def visible(self,node):
        bounds=re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',node.get('bounds',''))
        if not bounds:return False
        x1,y1,x2,y2=map(int,bounds.groups());return x2>x1 and y2>y1
    def find(self,label,timeout=25):
        deadline=time.monotonic()+timeout
        while time.monotonic()<deadline:
            matches=[n for n in self.nodes() if label in (n.get('text'),n.get('content-desc'),n.get('resource-id'))]
            buttons=[n for n in matches if n.get('clickable')=='true' and self.visible(n)]
            if len(buttons)==1:return buttons[0]
            if len(matches)==1:return matches[0]
            time.sleep(.2)
        raise RuntimeError('Control not observed: '+label)
    def tap(self,label):
        node=self.find(label);bounds=re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',node.get('bounds',''))
        assert bounds,'No native bounds for '+label
        x1,y1,x2,y2=map(int,bounds.groups());assert x2>x1 and y2>y1
        args=['tap',str((x1+x2)//2),str((y1+y2)//2)]
        self.report['inputs'].append({'control':label,'input':args});self.adb('shell','input',*args)
    def capture(self,name):
        self.nodes();(self.args.output/(name+'.xml')).write_bytes(self.xml)
        (self.args.output/(name+'.png')).write_bytes(self.adb('exec-out','screencap','-p',binary=True))
    def observer(self):return json.loads(self.args.observer.read_text())
    def check(self,name):self.report['checks'].append(name);print('PASS '+name,flush=True)
    def guest_scroll(self,direction):
        views=[n for n in self.nodes() if n.get('class')=='android.webkit.WebView' and n.get('text')=='Hypergolic runtime' and self.visible(n)]
        assert len(views)==1,'Guest WebView not uniquely observed'
        x1,y1,x2,y2=map(int,re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',views[0].get('bounds','')).groups())
        high=y1+int((y2-y1)*.15);low=y1+int((y2-y1)*.45);x=(x1+x2)//2
        args=['swipe',str(x),str(low if direction=='up' else high),str(x),str(high if direction=='up' else low),'400']
        self.report['inputs'].append({'control':'observed guest WebView scroll','input':args});self.adb('shell','input',*args)
    def guest_find(self,label):
        def exposed(node,nodes):
            if not self.visible(node):return False
            x1,y1,x2,y2=map(int,re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',node.get('bounds','')).groups());x=(x1+x2)//2;y=(y1+y2)//2
            for overlay in nodes:
                if overlay.get('resource-id') not in ['upload-recovery-open','upload-outcome','upload-progress'] or not self.visible(overlay):continue
                a,b,c,d=map(int,re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',overlay.get('bounds','')).groups())
                if a<=x<c and b<=y<d:return False
            return True
        for direction in ['down','up']:
            for _ in range(12):
                nodes=self.nodes()
                if any(exposed(n,nodes) and label in (n.get('text'),n.get('content-desc'),n.get('resource-id')) for n in nodes):return
                self.guest_scroll(direction)
        raise AssertionError('Guest control not exposed: '+label)
    def originals(self):
        items=json.loads((ROOT/'napplets/upload-lab/src/public-synthetic-photos.json').read_text())['files']
        self.report['scope']='Actual guest-owned original JPEG/HEIC through genuine SDK, sanitized native review/reject/approved exact signed PNG output; picker bypass and independent orientation/color/metadata verification. Disposable signing, controlled TLS.'
        self.report['fixtures']=items
        for item,kind in zip(items,['JPEG','HEIC']):
            assert sha((ROOT/'napplets/upload-lab/src'/item['file']).read_bytes())==item['inputSha256']
            baseline=self.observer();label='Request original '+kind
            def review():
                self.guest_find(label);self.tap(label);self.find('Approve file upload');self.find('Exact photo selected for upload')
                assert self.find('Approve once').get('enabled')=='true'
                assert any('image/png' in n.get('text','') for n in self.nodes()),'Reviewed output MIME is not PNG'
                self.capture(kind+'-trusted-native-prepared-review')
            review();self.tap('Reject upload');self.find('Upload cancelled.')
            denied=self.observer();assert denied['connections']==baseline['connections'] and denied['requests']==baseline['requests']
            self.tap('upload-outcome');self.guest_find('original-status');self.capture(kind+'-original-input-after-reject')
            text=self.find('original-status').get('text','');assert str(item['size']) in text and item['inputSha256'] in text
            self.check(kind+': original guest bytes and zero-dispatch rejection')
            review();self.tap('Approve once');self.find('Upload confirmed by server.');self.capture(kind+'-confirmed')
            observed=self.observer();new=observed['requests'][len(baseline['requests']):]
            assert len(new)==1 and observed['connections']==baseline['connections']+1 and not observed['errors']
            actual=new[0];assert actual['mimeType']=='image/png' and actual['sha256']!=item['inputSha256'] and actual['signatureVerified'] and item['recipe'] in actual['photoMatches']
            self.report.setdefault('outputs',[]).append(actual);self.check(kind+': exact sanitized PNG hash/body/signature and independent pixels')
            self.tap('upload-outcome');self.guest_find('Read upload status');self.tap('Read upload status');self.capture(kind+'-sdk-receipt')
            assert any('"status": "complete"' in n.get('text','') and actual['sha256'] in n.get('text','') for n in self.nodes())
            self.check(kind+': original scoped SDK receipt')
        self.report['sourceAfter']=sources();assert self.report['sourceBefore']==self.report['sourceAfter'];self.report['status']='passed'
    def review(self):
        self.guest_find('Request PNG upload');self.tap('Request PNG upload');self.find('Approve file upload');self.find('Exact photo selected for upload')
        node=self.find('Approve once');assert node.get('enabled')=='true','Native preview must decode before approval'
        self.capture('trusted-review')
    def run(self):
        build=json.loads(self.args.build.read_text());assert build['status']=='built' and build['platform']=='android'
        assert build['sourceAfter']==self.report['sourceBefore'],'Build inputs differ from current source'
        assert build['productSha256']==sha(self.args.apk.read_bytes()),'Supplied APK differs from sealed build'
        self.report['buildManifestSha256']=sha(self.args.build.read_bytes())
        path=self.adb('shell','pm','path',PACKAGE).removeprefix('package:')
        installed=self.adb('exec-out','cat',path,binary=True);assert sha(installed)==sha(self.args.apk.read_bytes())
        self.report['installedApkSha256']=sha(installed);self.report['webView']=self.adb('shell','dumpsys','webviewupdate')
        baseline=self.observer();self.report['observerBefore']=baseline
        self.adb('shell','am','force-stop',PACKAGE)
        self.adb('shell','am','start','-W','-n',PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity')
        self.find('Native host connected');self.find('Ready to request a PNG upload.');self.capture('sdk-ready')
        if self.args.originals:self.originals();return
        self.review();self.tap('Reject upload');self.find('Upload cancelled.')
        rejected=self.observer();assert rejected['connections']==baseline['connections'] and rejected['requests']==baseline['requests']
        self.report['observerAfterReject']=rejected;self.capture('rejected');self.check('reject-zero-network')
        self.tap('upload-outcome');self.review();self.tap('Approve once')
        self.find('Upload confirmed by server.');self.capture('confirmed')
        observed=self.observer();new=observed['requests'][len(baseline['requests']):]
        assert len(new)==1 and observed['connections']==baseline['connections']+1 and not observed['errors']
        assert new[0]['sha256']==HASH and new[0]['size']==71 and new[0]['signatureVerified'] is True
        self.report['observerAfterApprove']=observed;self.check('approved-exact-bytes-and-real-signature')
        self.tap('upload-outcome');self.guest_find('Read upload status');self.tap('Read upload status');self.capture('sdk-final-status')
        assert any('"status": "complete"' in n.get('text','') and HASH in n.get('text','') for n in self.nodes()),'Final SDK receipt not observed'
        self.check('original-sdk-final-receipt')
        self.adb('shell','am','force-stop',PACKAGE);self.adb('shell','am','start','-W','-n',PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity')
        self.find('Ready to request a PNG upload.');self.capture('cold-launch');self.check('cold-launch')
        self.report['sourceAfter']=sources();assert self.report['sourceBefore']==self.report['sourceAfter'],'Inputs changed during journey'
        self.report['status']='passed'
if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--originals',action='store_true');p.add_argument('--serial',required=True);p.add_argument('--apk',type=Path,required=True);p.add_argument('--build',type=Path,required=True);p.add_argument('--observer',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    journey=Journey(p.parse_args())
    try:journey.run()
    except Exception as error:
        journey.report.update(status='failed',error=str(error))
        try:journey.capture('failure')
        except Exception:pass
        raise
    finally:(journey.args.output/'result.json').write_text(json.dumps(journey.report,indent=2)+'\n')
