#!/usr/bin/env python3
"""Actual Android system-file PNG selection with independently checked SDK/native TLS upload."""
import argparse,json,re,subprocess,time,xml.etree.ElementTree as ET
from pathlib import Path
from evidence import ROOT,sha,sources
PACKAGE='org.nostrocket.hypergolic.uploadfixture'
HASH='5a852fbaaaecaf4cd14c01e150c7f881c5c5894b0a1e3c53be7e007c58374ee6'
p=argparse.ArgumentParser(description=__doc__)
for name in ['serial','apk','build','observer','seed','output']:p.add_argument('--'+name,required=True,type=str if name=='serial' else Path)
a=p.parse_args();a.output.mkdir(parents=True,exist_ok=False)
r={'kind':'hypergolic-android-selected-png-v1','status':'running','sourceBefore':sources(),'checks':[],'inputs':[],
   'scope':'Actual Android document picker, selected PNG sanitation, guest read after rejected upload and disposable signed loopback TLS. Broader formats, revocation and production identity remain open.'}
def adb(*args,binary=False):
    data=subprocess.check_output([str(ROOT/'.tools/android-sdk/platform-tools/adb'),'-s',a.serial,*args],timeout=30)
    return data if binary else data.decode().strip()
def nodes():
    adb('shell','uiautomator','dump','--compressed','/data/local/tmp/hg-picker-proof.xml')
    xml=adb('exec-out','cat','/data/local/tmp/hg-picker-proof.xml',binary=True);return xml,list(ET.fromstring(xml).iter('node'))
def find(label,timeout=20):
    until=time.monotonic()+timeout
    while time.monotonic()<until:
        _,tree=nodes();matches=[n for n in tree if label in (n.get('text'),n.get('content-desc'),n.get('resource-id'))]
        buttons=[n for n in matches if n.get('clickable')=='true']
        if len(buttons)==1:return buttons[0]
        if len(matches)==1:return matches[0]
    raise AssertionError('Control not observed: '+label)
def tap(label):
    node=find(label);x1,y1,x2,y2=map(int,re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',node.get('bounds','')).groups())
    assert x2>x1 and y2>y1
    args=['tap',str((x1+x2)//2),str((y1+y2)//2)];r['inputs'].append({'control':label,'input':args});adb('shell','input',*args)
def capture(name):
    xml,_=nodes();(a.output/(name+'.xml')).write_bytes(xml);(a.output/(name+'.png')).write_bytes(adb('exec-out','screencap','-p',binary=True))
def scroll():
    adb('shell','input','swipe','530','2110','530','1160','400');r['inputs'].append({'control':'fixture scroll','input':'vertical native swipe'})
def selected():
    _,tree=nodes();matches=[n for n in tree if n.get('resource-id')=='selected-status']
    return bool(matches and 'Selected bytes: 71; SHA-256: '+HASH in matches[0].get('text',''))
def wait_selected():
    until=time.monotonic()+15
    while time.monotonic()<until:
        if selected():return
    raise AssertionError('Exact sanitized guest bytes not observed')
def review():
    tap('Request selected upload');find('Approve file upload');find('Exact photo selected for upload');assert find('Approve once').get('enabled')=='true';capture('trusted-selected-review')
try:
    build=json.loads(a.build.read_text());assert build['status']=='built' and build['platform']=='android' and build['sourceAfter']==r['sourceBefore']
    assert build['productSha256']==sha(a.apk.read_bytes());r['buildManifestSha256']=sha(a.build.read_bytes())
    path=adb('shell','pm','path',PACKAGE).removeprefix('package:');r['installedApkSha256']=sha(adb('exec-out','cat',path,binary=True));assert r['installedApkSha256']==build['productSha256']
    r['seed']=json.loads(a.seed.with_suffix('.json').read_text());assert sha(a.seed.read_bytes())==r['seed']['originalSha256']
    adb('shell','mkdir','-p','/sdcard/Download/UploadLab');adb('push',str(a.seed),'/sdcard/Download/UploadLab/selected-photo.png')
    baseline=json.loads(a.observer.read_text());r['observerBefore']=baseline
    adb('shell','am','force-stop',PACKAGE);adb('shell','am','start','-W','-n',PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity');find('Native host connected');find('Ready to request a PNG upload.')
    tap('selection');find('Show roots');tap('Show roots');tap('sdk_gphone64_arm64');tap('Download');tap('UploadLab');find('selected-photo.png');capture('system-file-selection');tap('selected-photo.png')
    wait_selected();capture('sanitized-guest-handoff');r['checks'].append('system-selected-file-sanitized-before-guest-handoff')
    review();tap('Reject upload');find('Upload cancelled.');observed=json.loads(a.observer.read_text());assert observed['connections']==baseline['connections'] and observed['requests']==baseline['requests'];r['observerAfterReject']=observed;r['checks'].append('rejection-zero-network')
    tap('upload-outcome');tap('Read selected file');wait_selected();capture('guest-read-after-rejection');r['checks'].append('guest-readable-after-rejected-upload')
    review();tap('Approve once');find('Upload confirmed by server.');capture('selected-upload-confirmed')
    observed=json.loads(a.observer.read_text());new=observed['requests'][len(baseline['requests']):];assert len(new)==1 and observed['connections']==baseline['connections']+1 and not observed['errors'];assert new[0]['sha256']==HASH and new[0]['size']==71 and new[0]['signatureVerified'] is True
    r['observerAfterApprove']=observed;r['checks'].append('exact-sanitized-upload-and-real-signature')
    r['sourceAfter']=sources();assert r['sourceAfter']==r['sourceBefore'];r['status']='passed';print('PASS Android selected PNG handoff/reject/read/approved exact TLS bytes')
except Exception as error:
    r.update(status='failed',error=str(error))
    try:capture('failure')
    except Exception:pass
    raise
finally:(a.output/'result.json').write_text(json.dumps(r,indent=2)+'\n')
