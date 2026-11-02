#!/usr/bin/env python3
"""Checked ordinary Android Settings input: one warm open/return pair, exact owned cleanup."""
from pathlib import Path
import argparse,hashlib,json,subprocess,traceback,xml.etree.ElementTree as ET,time
ROOT=Path(__file__).resolve().parents[3]
p=argparse.ArgumentParser(description=__doc__)
for name in ['serial','npub']:p.add_argument('--'+name,required=True)
for name in ['apk','ui-jar','output']:p.add_argument('--'+name,type=Path,required=True)
a=p.parse_args();OUT=a.output;OUT.mkdir(exist_ok=False)
ADB=[str(ROOT/'.tools/android-sdk/platform-tools/adb'),'-s',a.serial]
PKG='org.nostrocket.hypergolic.emptyacceptance';REMOTE='/data/local/tmp/hg-checked-input.jar';XML='/data/local/tmp/hg-checked-input.xml'
NPUB=a.npub
APK=a.apk
sha=lambda b:hashlib.sha256(b).hexdigest()
R={'status':'running','scope':'Shell-UID UI Automator checked physical native input and ordinary retained app readback. No app installation, key access, guest state injection, product repair or historical root-cause claim. Accessibility services may be suppressed by this legacy observer; not screen-reader acceptance.','actions':[],'checks':[],'captures':[],'sourceHead':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'executedDriverSha256':sha(Path(__file__).read_bytes()),'javaSha256':sha((ROOT/'tests/native/presentation/CheckedUiInput.java').read_bytes()),'jarSha256':sha(a.ui_jar.read_bytes())};staged=False
(OUT/'executed-driver.py').write_bytes(Path(__file__).read_bytes())
def save(): (OUT/'receipt.json').write_text(json.dumps(R,indent=2)+'\n')
def adb(*a,check=True,binary=False):
 r=subprocess.run(ADB+list(a),capture_output=True,timeout=40);assert not check or r.returncode==0,(a,r.stderr.decode(errors='replace'));return r if not check else r.stdout if binary else r.stdout.decode().strip()
def action(label,target=None,expected=None):
 cmd=['shell','CLASSPATH=/system/framework/android.test.base.jar:/system/framework/android.test.runner.jar:/system/framework/uiautomator.jar:'+REMOTE,'app_process','/system/bin','com.android.commands.uiautomator.Launcher','runtest','-c','org.nostrocket.hypergolic.proof.CheckedUiInput','-e','jars',REMOTE]
 if target: cmd+=['-e','target',target,'-e','expected',expected]
 started=time.time();log=adb(*cmd);(OUT/(label+'.log')).write_text(log+'\n');raw=adb('exec-out','cat',XML,binary=True);assert b'nsec1' not in raw
 (OUT/(label+'.xml')).write_bytes(raw);assert raw.lstrip().startswith(b'<?xml') or raw.lstrip().startswith(b'<hierarchy'),repr(raw[:180]);ns=list(ET.fromstring(raw).iter('node')); assert any(n.get('package')==PKG for n in ns),'Expected app not foreground'
 (OUT/(label+'.xml')).write_bytes(raw);png=adb('exec-out','screencap','-p',binary=True);assert png.startswith(b'\x89PNG');(OUT/(label+'.png')).write_bytes(png)
 result=[json.loads(line.split('CHECKED_UI_RESULT ',1)[1]) for line in log.splitlines() if 'CHECKED_UI_RESULT ' in line]
 R['captures'].append({'name':label,'xmlSha256':sha(raw),'pngSha256':sha(png),'logSha256':sha((log+'\n').encode())})
 R['actions'].append({'name':label,'target':target,'expected':expected,'startedAt':started,'completedAt':time.time(),'results':result});save()
 assert 'OK (1 test)' in log and 'INSTRUMENTATION_STATUS_CODE: 0' in log and 'FAILURES!!!' not in log,log[-1000:]
 if target:assert len(result)==1 and result[0]['inputAccepted'] and result[0]['postconditionObserved']
 return ns
try:
 policy=adb('shell','dumpsys','window','policy');assert 'showing=false' in policy and 'inputRestricted=false' in policy,'Device locked'
 R['inventoryBefore']=adb('shell','pm','list','packages','-3').splitlines();R['installedPathBefore']=adb('shell','pm','path',PKG);path=R['installedPathBefore'].removeprefix('package:')
 R['installedApkSha256']=sha(adb('exec-out','cat',path,binary=True));assert R['installedApkSha256']==sha(APK.read_bytes())
 old=json.loads((APK.parent/'source-inputs.json').read_text());changed=[p for p,h in old.items() if not (ROOT/p).is_file() or sha((ROOT/p).read_bytes())!=h];assert all(p.startswith(('docs/','.planning/','tests/')) for p in changed),'Packaged owning source differs'
 R['changedNonProductInputsSincePackaging']=changed;R['sourceInputsBefore']={p:sha((ROOT/p).read_bytes()) for p in old if (ROOT/p).is_file()}
 for f in [REMOTE,XML]:assert adb('shell','test','!','-e',f,check=False).returncode==0,'Preserve existing observer file'
 adb('push',str(a.ui_jar),REMOTE);staged=True;assert sha(adb('exec-out','cat',REMOTE,binary=True))==R['jarSha256']
 adb('shell','am','start','-W','-n',PKG+'/org.nostrocket.hypergolic.dev.MainActivity')
 ns=action('00-baseline');assert any(n.get('resource-id')=='empty-open-napplet' for n in ns),'Retained workspace not empty'
 assert any(n.get('resource-id')=='shell-settings' and n.get('content-desc')=='Settings for '+NPUB for n in ns),'Unexpected selected identity'
 R['baselineEmptyDevelopmentIdentityVerified']=True;save()
 (OUT/'before-input-dispatcher.txt').write_text(adb('shell','dumpsys','input')+'\n')
 ns=action('warm-open','shell-settings','settings-full-npub');assert any(n.get('resource-id')=='settings-full-npub' and n.get('text')==NPUB for n in ns)
 ns=action('warm-done','settings-done','empty-open-napplet');R['checks'].append({'name':'single-checked-warm-settings-open-and-return','passed':True});save();print('PASS warm pair',flush=True)
 R['status']='passed-scoped-checked-native-input'
except BaseException as e:
 R.update(status='failed',error=str(e),traceback=traceback.format_exc());print('FAILED '+str(e),flush=True)
finally:
 try:
  if staged:
   (OUT/'after-input-dispatcher.txt').write_text(adb('shell','dumpsys','input')+'\n')
   assert sha(adb('exec-out','cat',REMOTE,binary=True))==R['jarSha256'];adb('shell','rm','-f',REMOTE,XML)
   for f in [REMOTE,XML]:assert adb('shell','test','!','-e',f,check=False).returncode==0
   R['ownedObserverRemoved']=True
  R['inventoryAfter']=adb('shell','pm','list','packages','-3').splitlines();assert R['inventoryBefore']==R['inventoryAfter']
  assert R['installedPathBefore']==adb('shell','pm','path',PKG) and R['installedApkSha256']==sha(adb('exec-out','cat',path,binary=True))
  assert all(sha((ROOT/p).read_bytes())==h for p,h in R['sourceInputsBefore'].items());R['retainedApkPathInventoryAndSourcePreserved']=True
 except BaseException as e:R.update(status='failed-cleanup',cleanupError=str(e))
 save()
if R['status']!='passed-scoped-checked-native-input':raise SystemExit(1)
