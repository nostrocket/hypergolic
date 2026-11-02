#!/usr/bin/env python3
"""Actual Android prepared photo selection with decoded review and independent pixel/TLS observation."""
import argparse,json,re,subprocess,time,xml.etree.ElementTree as ET
from pathlib import Path
from evidence import ROOT,sha,sources
PACKAGE='org.nostrocket.hypergolic.uploadfixture'
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--cases',type=Path,required=True)
for name in ['serial','apk','build','observer','fixtures','output']:p.add_argument('--'+name,required=True,type=str if name=='serial' else Path)
a=p.parse_args();a.output.mkdir(parents=True,exist_ok=False)
r={'kind':'hypergolic-android-selected-photos-v1','status':'running','sourceBefore':sources(),'checks':[],'inputs':[],
   'scope':'Actual selected photos, decoded trusted review, zero-network rejection, continued reading, exact prepared signed TLS bytes and independent orientation/color/metadata; disposable identity. Revoked-picker and protected/published acceptance remain open.'}
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
    xml,tree=nodes();(a.output/(name+'.xml')).write_bytes(xml);(a.output/(name+'.png')).write_bytes(adb('exec-out','screencap','-p',binary=True));return tree
def scroll():
    adb('shell','input','swipe','530','2110','530','1160','400');r['inputs'].append({'control':'fixture scroll','input':'vertical native swipe'})
def file_list_scroll(direction):
    _,tree=nodes();lists=[n for n in tree if n.get('resource-id')=='com.google.android.documentsui:id/dir_list' and n.get('scrollable')=='true']
    assert len(lists)==1,'System file list not uniquely observed'
    x1,y1,x2,y2=map(int,re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',lists[0].get('bounds','')).groups())
    low=y1+int((y2-y1)*.82);high=y1+int((y2-y1)*.36);x=(x1+x2)//2
    args=['swipe',str(x),str(low if direction=='up' else high),str(x),str(high if direction=='up' else low),'400']
    r['inputs'].append({'control':'observed system file list','input':args});adb('shell','input',*args)
def visible_names():
    _,tree=nodes();return [n.get('text') for n in tree if n.get('resource-id')=='android:id/title']
def find_file(label):
    _,tree=nodes()
    if any(n.get('text')==label for n in tree):return
    previous=visible_names()
    for _ in range(8):
        file_list_scroll('down');current=visible_names()
        if current==previous:break
        previous=current
    for _ in range(8):
        _,tree=nodes()
        if any(n.get('text')==label for n in tree):return
        file_list_scroll('up')
    raise AssertionError('Selected system file not observed: '+label)
observed_selection=None
def selected():
    global observed_selection
    _,tree=nodes();matches=[n for n in tree if n.get('resource-id')=='selected-status']
    found=re.search(r'Selected bytes: (\d+); SHA-256: ([0-9a-f]{64}); type: image/png;',matches[0].get('text','')) if matches else None
    if found:
        value={'size':int(found.group(1)),'sha256':found.group(2)}
        if observed_selection is not None:assert observed_selection==value,'Selected bytes changed after rejection'
        observed_selection=value;return True
    return False
def wait_selected():
    until=time.monotonic()+15
    while time.monotonic()<until:
        if selected():return
    raise AssertionError('Exact sanitized guest bytes not observed')
def review(label):
    tap('Request selected upload');find('Approve file upload');tree=capture(label+'-trusted-selected-review')
    assert any('Exact photo selected for upload' in (n.get('text'),n.get('content-desc')) for n in tree)
    approve=[n for n in tree if 'Approve once' in (n.get('text'),n.get('content-desc')) and n.get('clickable')=='true'];assert len(approve)==1 and approve[0].get('enabled')=='true'

try:
    build=json.loads(a.build.read_text());assert build['status']=='built' and build['platform']=='android' and build['sourceAfter']==r['sourceBefore']
    assert build['productSha256']==sha(a.apk.read_bytes());r['buildManifestSha256']=sha(a.build.read_bytes())
    path=adb('shell','pm','path',PACKAGE).removeprefix('package:');r['installedApkSha256']=sha(adb('exec-out','cat',path,binary=True));assert r['installedApkSha256']==build['productSha256']
    manifest=json.loads((a.fixtures/'photos.json').read_text());names=json.loads(a.cases.read_text());items=[next(item for item in manifest['files'] if item['file']==name) for name in names];r['fixtures']=items
    baseline=json.loads(a.observer.read_text());r['observerBefore']=baseline
    for item in items:
        body=(a.fixtures/item['file']).read_bytes();assert sha(body)==item['inputSha256']
        adb('shell','mkdir','-p','/sdcard/Download/UploadPhotos');adb('push',str(a.fixtures/item['file']),'/sdcard/Download/UploadPhotos/'+item['file'])
    adb('shell','am','force-stop',PACKAGE);adb('shell','am','start','-W','-n',PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity');find('Native host connected');find('Ready to request a PNG upload.')
    for index,item in enumerate(items):
        before=json.loads(a.observer.read_text());observed_selection=None
        tap('selection');tap('Show roots');tap('sdk_gphone64_arm64');tap('Download');tap('UploadPhotos');find_file(item['file']);capture(item['file']+'-system-selection');tap(item['file'])
        wait_selected();capture(item['file']+'-guest-handoff');r['checks'].append(item['file']+': sanitized PNG guest handoff');r.setdefault('selections',[]).append({'file':item['file'],**observed_selection})
        review(item['file']);tap('Reject upload');find('Upload cancelled.')
        observed=json.loads(a.observer.read_text());assert observed['connections']==before['connections'] and observed['requests']==before['requests'];r['checks'].append(item['file']+': rejection zero TLS')
        tap('upload-outcome');tap('Read selected file');wait_selected();capture(item['file']+'-guest-read-after-reject');r['checks'].append(item['file']+': read after rejection')
        review(item['file']);tap('Approve once');find('Upload confirmed by server.');capture(item['file']+'-confirmed')
        observed=json.loads(a.observer.read_text());new=observed['requests'][len(before['requests']):]
        assert len(new)==1 and observed['connections']==before['connections']+1 and not observed['errors']
        assert new[0]['sha256']==observed_selection['sha256'] and new[0]['size']==observed_selection['size'] and new[0]['signatureVerified'] is True and new[0]['mimeType']=='image/png' and item['file'] in new[0]['photoMatches']
        r['checks'].append(item['file']+': exact approved upload and signature');r['observerAfterApprove']=observed;print('Passed selected photo: '+item['file'],flush=True)
        tap('upload-outcome')
    r['sourceAfter']=sources();assert r['sourceAfter']==r['sourceBefore'];r['status']='passed';print('PASS Android selected photos/decoded review/reject/read/exact signed TLS and independent orientation/color/metadata')
except Exception as error:
    r.update(status='failed',error=str(error))
    try:capture('failure')
    except Exception:pass
    raise
finally:(a.output/'result.json').write_text(json.dumps(r,indent=2)+'\n')
