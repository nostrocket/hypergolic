#!/usr/bin/env python3
"""Actual Android picker cancel, malformed photo and stale Home/return callback denial."""
import argparse,json,re,subprocess,xml.etree.ElementTree as ET
from pathlib import Path
from evidence import ROOT,sha,sources
PACKAGE='org.nostrocket.hypergolic.uploadfixture'
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--recipient-faults',action='store_true')
for key in ['serial','apk','build','fixtures','observer','output']:p.add_argument('--'+key,required=True,type=str if key=='serial' else Path)
a=p.parse_args();a.output.mkdir(parents=True,exist_ok=False)
r={'status':'running','scope':__doc__,'sourceBefore':sources(),'checks':[],'inputs':[]}
def adb(*args,binary=False):
 data=subprocess.check_output([str(ROOT/'.tools/android-sdk/platform-tools/adb'),'-s',a.serial,*args],timeout=30)
 return data if binary else data.decode().strip()
def tree():
 adb('shell','uiautomator','dump','--compressed','/data/local/tmp/hg-picker-denials.xml')
 xml=adb('exec-out','cat','/data/local/tmp/hg-picker-denials.xml',binary=True);return xml,list(ET.fromstring(xml).iter('node'))
def find(label,attempts=8):
 for _ in range(attempts):
  _,nodes=tree();matches=[n for n in nodes if label in (n.get('text'),n.get('content-desc'),n.get('resource-id'))]
  buttons=[n for n in matches if n.get('clickable')=='true']
  if len(buttons)==1:return buttons[0]
  if len(matches)==1:return matches[0]
 raise AssertionError('Control not observed: '+label)
def tap_node(node,label):
 x1,y1,x2,y2=map(int,re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',node.get('bounds','')).groups());assert x2>x1 and y2>y1
 args=['tap',str((x1+x2)//2),str((y1+y2)//2)];r['inputs'].append({'control':label,'input':args});adb('shell','input',*args)
def tap(label):tap_node(find(label),label)
def key(label):r['inputs'].append({'control':label,'input':['keyevent',label]});adb('shell','input','keyevent',label)
def capture(name):
 xml,_=tree();(a.output/(name+'.xml')).write_bytes(xml);(a.output/(name+'.png')).write_bytes(adb('exec-out','screencap','-p',binary=True))
def no_file(name):
 find('Native host connected');_,nodes=tree()
 assert not any(n.get('resource-id')=='selected-status' and 'Selected bytes:' in n.get('text','') for n in nodes),'Revoked picker delivered bytes'
 assert find('selected-request').get('enabled')=='false','Revoked picker enabled upload'
 current=json.loads(a.observer.read_text());assert current['connections']==before['connections'] and current['requests']==before['requests']
 capture(name);r['checks'].append(name);print('Observed no file/zero TLS: '+name,flush=True)
def open_files():
 tap('selection');find('Show roots');tap('Show roots');tap('sdk_gphone64_arm64');tap('Download');tap('UploadDenied')
try:
 build=json.loads(a.build.read_text());assert build['status']=='built' and build['platform']=='android' and build['sourceAfter']==r['sourceBefore']
 assert sha(a.apk.read_bytes())==build['productSha256'];r['buildManifestSha256']=sha(a.build.read_bytes())
 path=adb('shell','pm','path',PACKAGE).removeprefix('package:');r['installedApkSha256']=sha(adb('exec-out','cat',path,binary=True));assert r['installedApkSha256']==build['productSha256']
 before=json.loads(a.observer.read_text());r['observerBefore']=before
 adb('shell','mkdir','-p','/sdcard/Download/UploadDenied')
 for name in ['jpeg-orientation-1.jpeg','malformed-exif.jpeg']:adb('push',str(a.fixtures/name),'/sdcard/Download/UploadDenied/'+name)
 if a.recipient_faults:
  r['scope']='Actual native timed close/configuration replacement/identity rejection and renderer termination while DocumentsUI is pending; QA-only disposable host, not ordinary workspace identity switching.'
  for action in ['close','replace','identity','renderer']:
   adb('shell','am','force-stop',PACKAGE);adb('shell','am','start','-W','-n',PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity');find('Ready to request a PNG upload.')
   pid=adb('shell','pidof',PACKAGE);r.setdefault('appPids',[]).append({'action':action,'pidBefore':pid})
   tap('Arm picker '+action);find('Picker fault armed: '+action)
   open_files();capture(action+'-pending-system-picker')
   # The native Handler runs after 12 seconds even while React Native is paused.
   import time
   time.sleep(14)
   capture(action+'-stale-picker-after-native-fault');tap('jpeg-orientation-1.jpeg')
   expected='proof-close' if action=='close' else 'renderer-stopped' if action=='renderer' else 'session-reuse-blocked'
   find('Native host failed: '+expected);capture(action+'-native-revoked')
   _,nodes=tree();assert not any(n.get('class')=='android.webkit.WebView' for n in nodes),'Revoked WebView survived'
   assert adb('shell','pidof',PACKAGE)==pid,'App process died rather than captured host'
   tap('Open Upload Lab');find('Ready to request a PNG upload.');no_file(action+'-fresh-recipient-no-late-file')
 else:
  adb('shell','am','force-stop',PACKAGE);adb('shell','am','start','-W','-n',PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity');find('Ready to request a PNG upload.')
  tap('selection');find('Show roots');capture('system-picker-before-cancel')
  for _ in range(8):
   key('KEYCODE_BACK');_,nodes=tree()
   if any(n.get('text')=='Native host connected' for n in nodes):break
  no_file('system-cancel')
  open_files();capture('malformed-photo-before-selection');tap('malformed-exif.jpeg');no_file('malformed-photo-denied')
  open_files();capture('pending-picker-before-home');key('KEYCODE_HOME');capture('home');key('KEYCODE_APP_SWITCH')
  _,nodes=tree();cards=[]
  for node in nodes:
   if node.get('content-desc')=='Hypergolic':
    x1,y1,x2,y2=map(int,re.findall(r'\d+',node.get('bounds','')))
    if x2-x1>540:cards.append(node)
  assert len(cards)==1,'Native Recents card not unique';capture('observed-recents-card');tap_node(cards[0],'observed Hypergolic Recents card')
  _,nodes=tree();late=[n for n in nodes if n.get('text')=='jpeg-orientation-1.jpeg']
  if late:
   assert len(late)==1;capture('stale-picker-return');tap_node(late[0],'stale selected file')
  no_file('home-late-callback-revoked')
  tap('selection');find('Show roots')
  for _ in range(8):
   key('KEYCODE_BACK');_,nodes=tree()
   if any(n.get('text')=='Native host connected' for n in nodes):break
  no_file('fresh-picker-after-revocation')
 r['sourceAfter']=sources();assert r['sourceAfter']==r['sourceBefore'];r['observerAfter']=json.loads(a.observer.read_text());r['status']='passed';print('PASS actual Android picker denials and stale Home callback revocation',flush=True)
except Exception as error:
 r.update(status='failed',error=str(error))
 try:capture('failure')
 except Exception:pass
 raise
finally:(a.output/'result.json').write_text(json.dumps(r,indent=2)+'\n')
