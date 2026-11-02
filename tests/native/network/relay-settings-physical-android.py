#!/usr/bin/env python3
"""Physical ordinary Android relay-settings edits and exact baseline restoration."""
from pathlib import Path
import argparse,importlib.util,sys,json,hashlib,time,traceback,subprocess
ROOT=Path(__file__).resolve().parents[3];sys.path.insert(0,str(ROOT/'tests/native/presentation'))
spec=importlib.util.spec_from_file_location('notify_version',ROOT/'tests/native/presentation/notify-version-physical-android.py');base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
from evidence import sha,sources
PACKAGE='org.nostrocket.hypergolic.emptyacceptance'
DEFAULTS=json.loads((ROOT/'src/config/default-relays.json').read_text())
class Journey(base.Journey):
 def __init__(self,args):
  super().__init__(args);self.changed=False;self.staged=False;self.report.update(observerSha256=sha(Path(__file__).read_bytes()),kind='hypergolic-ordinary-android-relay-settings',scope='Actual ordinary protected-owner native settings edits, invalid URL rejection, role separation, empty-list persistence and explicit restoration. No external event publication, routing delivery, iOS or fresh-profile physical seeding claim.')
  (args.output/'executed-observer.py').write_bytes(Path(__file__).read_bytes())
 def rows(self,role,name):
  self.settings_tap('relay-role-'+role);self.settings_find('relay-input-'+role)
  nodes=self.nodes();selected=[n for n in nodes if n.get('resource-id')=='relay-role-'+role]
  assert len(selected)==1 and selected[0].get('selected')=='true','Native selected relay role differs'
  values=[n.get('text') for n in nodes if n.get('text','').startswith('wss://') and n.get('class')=='android.widget.TextView']
  assert len(set(values))==len(values),'Ambiguous relay URL rows'
  self.report.setdefault('relaySnapshots',[]).append({'role':role,'name':name,'values':values,'xmlSha256':sha(self.xml)})
  self.capture(name);return values
 def expect(self,role,values,name):
  actual=self.rows(role,name);assert actual==values,(role,name,actual,values)
 def add(self,role,value,error=None):
  self.edit('relay-input-'+role,value);self.settings_tap('relay-add-'+role)
  if error:self.settings_find(error);self.capture('invalid-'+role+'-'+str(len(self.report.get('rejectedURLs',[]))));self.report.setdefault('rejectedURLs',[]).append({'role':role,'value':value,'error':error})
  else:
   deadline=time.monotonic()+12
   while time.monotonic()<deadline:
    if self.find('relay-input-'+role).get('text','') in ['', 'wss://relay.example.org']:return
    time.sleep(.2)
   raise AssertionError('Successful native add did not clear input')
 def edit(self,label,value):
  self.settings_tap(label)
  assert self.find(label).get('focused')=='true','Native URL input not focused'
  self.adb('shell','input','keyevent','KEYCODE_MOVE_END');self.adb('shell','input','keycombination','113','29');self.adb('shell','input','keyevent','67')
  assert self.find(label).get('text','') in ['', 'wss://relay.example.org'],'URL field did not clear to its empty placeholder'
  self.adb('shell','input','text',value)
  assert self.find(label).get('text')==value,'Typed URL differed from native readback'
  self.report.setdefault('nativeFieldInputs',[]).append({'field':label,'publicValue':value,'nativeReadbackVerified':True});self.persist()
  self.adb('shell','input','keyevent','4');assert self.find(label).get('text')==value,'Keyboard dismissal changed URL input'
 def remove(self,role,value):
  self.settings_tap('Remove '+value)
 def restart(self,name):
  self.tap('settings-done');old=self.adb('shell','pidof',PACKAGE);self.adb('shell','am','force-stop',PACKAGE)
  absent=subprocess.run([str(ROOT/'.tools/android-sdk/platform-tools/adb'),'-s',self.args.serial,'shell','pidof',PACKAGE],capture_output=True,text=True);assert absent.returncode!=0 and not absent.stdout.strip(),'Process did not stop'
  self.launch();new=self.adb('shell','pidof',PACKAGE);assert old and new and old!=new
  self.find('empty-open-napplet');self.settings();self.report.setdefault('coldProcesses',[]).append({'name':name,'before':old,'notRunningVerified':True,'after':new})
 def run(self):
  policy=self.adb('shell','dumpsys','window','policy');assert 'showing=false' in policy and 'inputRestricted=false' in policy,'Device locked'
  self.report['deviceAPI']=self.adb('shell','getprop','ro.build.version.sdk');self.report['deviceModel']=self.adb('shell','getprop','ro.product.model')
  self.report['inventoryBefore']=self.adb('shell','pm','list','packages','-3').splitlines()
  self.report['installedPathBefore']=self.adb('shell','pm','path',PACKAGE)
  self.report['installedApkSha256']=sha(self.adb('exec-out','cat',self.report['installedPathBefore'].removeprefix('package:'),binary=True));assert self.report['installedApkSha256']==sha(self.args.apk.read_bytes())
  old=json.loads((self.args.build.parent/'source-inputs.json').read_text());changed=[p for p,h in old.items() if not (ROOT/p).is_file() or sha((ROOT/p).read_bytes())!=h];assert all(p.startswith(('docs/','.planning/','tests/')) for p in changed),'Packaged product input drift'
  self.report['changedNonProductInputsSincePackaging']=changed
  absent=subprocess.run([str(ROOT/'.tools/android-sdk/platform-tools/adb'),'-s',self.args.serial,'shell','test','!','-e','/data/local/tmp/hg-notify-uia.jar'],capture_output=True);assert absent.returncode==0,'Preserve existing observer'
  absent_xml=subprocess.run([str(ROOT/'.tools/android-sdk/platform-tools/adb'),'-s',self.args.serial,'shell','test','!','-e','/data/local/tmp/hg-notify.xml'],capture_output=True);assert absent_xml.returncode==0,'Preserve existing snapshot'
  self.adb('push',str(self.args.ui_jar),'/data/local/tmp/hg-notify-uia.jar');self.staged=True
  assert sha(self.adb('exec-out','cat','/data/local/tmp/hg-notify-uia.jar',binary=True))==sha(self.args.ui_jar.read_bytes())
  self.launch();self.find('empty-open-napplet');self.settings()
  self.expect('network',DEFAULTS['networkRelays'],'native-network-default-baseline');self.expect('lookup',DEFAULTS['lookupRelays'],'native-lookup-default-baseline');self.check('ordinary-exact-shipped-role-defaults')
  self.changed=True
  for role in ['network','lookup']:
   self.settings_tap('relay-role-'+role)
   for value in ['ws://relay.example.org','https://relay.example.org','wss://127.0.0.1','wss://localhost','wss://user@relay.example.org']:
    self.add(role,value,'Enter a valid secure WebSocket URL using wss:// and a public DNS host.')
    self.expect(role,DEFAULTS[role+'Relays'],'native-invalid-unchanged-'+role+'-'+str(len(self.report['rejectedURLs'])))
   self.add(role,DEFAULTS[role+'Relays'][0],'That relay is already in this list.');self.expect(role,DEFAULTS[role+'Relays'],'native-duplicate-unchanged-'+role)
  self.check('native-invalid-and-duplicate-adds-leave-both-role-lists-unchanged')
  modified={}
  for role in ['network','lookup']:
   self.settings_tap('relay-role-'+role);self.remove(role,DEFAULTS[role+'Relays'][0]);new='wss://'+role+'.phase2.example.org';self.add(role,new);modified[role]=DEFAULTS[role+'Relays'][1:]+[new];self.expect(role,modified[role],'native-modified-'+role)
  self.expect('network',modified['network'],'native-network-retained-after-lookup-edit');self.check('native-remove-add-appends-in-role-and-preserves-other-role')
  self.restart('modified-lists');self.expect('network',modified['network'],'native-cold-network-modified');self.expect('lookup',modified['lookup'],'native-cold-lookup-modified');self.check('real-cold-restart-retains-edits-without-automatic-default-reset')
  for role in ['network','lookup']:
   self.settings_tap('relay-role-'+role)
   for value in modified[role]:self.remove(role,value)
   self.expect(role,[],'native-empty-'+role)
  self.restart('empty-lists');self.expect('network',[],'native-cold-empty-network');self.expect('lookup',[],'native-cold-empty-lookup');self.check('real-cold-restart-retains-both-explicitly-empty-role-lists')
  self.settings_tap('relay-role-network');self.settings_tap('relay-restore-network');self.expect('network',DEFAULTS['networkRelays'],'native-explicit-network-default-restore');self.expect('lookup',[],'native-lookup-empty-after-network-restore');self.check('explicit-default-restore-changes-only-selected-role')
  self.settings_tap('relay-restore-lookup');self.expect('lookup',DEFAULTS['lookupRelays'],'native-explicit-lookup-default-restore');self.restart('restored-defaults');self.expect('network',DEFAULTS['networkRelays'],'native-cold-restored-network');self.expect('lookup',DEFAULTS['lookupRelays'],'native-cold-restored-lookup');self.check('explicit-restored-exact-defaults-persist-after-final-cold-start');self.report['status']='passed-ordinary-relay-settings-workflow'
 def cleanup(self):
  if self.staged:
   self.adb('shell','am','start','-W','-n',PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity')
   if self.present('settings-done'):self.adb('shell','input','keyevent','4')
   if not self.present('settings-done'):self.settings()
   if self.changed:
    for role in ['network','lookup']:
     self.settings_tap('relay-role-'+role);self.settings_tap('relay-restore-'+role);self.expect(role,DEFAULTS[role+'Relays'],'cleanup-exact-original-'+role)
   self.tap('settings-done');self.find('empty-open-napplet');self.report['selectedDevelopmentNpub']=self.args.npub
   assert self.adb('shell','pm','path',PACKAGE)==self.report['installedPathBefore'];assert sha(self.adb('exec-out','cat',self.report['installedPathBefore'].removeprefix('package:'),binary=True))==self.report['installedApkSha256'];assert self.adb('shell','pm','list','packages','-3').splitlines()==self.report['inventoryBefore'];self.report['keeperAndInventoryUnchanged']=True
   assert sha(self.adb('exec-out','cat','/data/local/tmp/hg-notify-uia.jar',binary=True))==sha(self.args.ui_jar.read_bytes());self.adb('shell','rm','/data/local/tmp/hg-notify-uia.jar','/data/local/tmp/hg-notify.xml');self.report['ownedObserverRemoved']=True
  self.report['sourceAfter']=sources();assert self.report['sourceAfter']==self.report['sourceBefore'];self.persist()
p=argparse.ArgumentParser()
for n in ['serial','npub']:p.add_argument('--'+n,required=True)
for n in ['ui-jar','build','apk','output']:p.add_argument('--'+n,type=Path,required=True)
p.add_argument('--recover',type=Path)
a=p.parse_args();a.section='relay-settings';j=Journey(a)
if a.recover:
 j.report=json.loads(a.recover.read_text());j.changed=True;j.staged=True
 j.cleanup();j.report['recoveryStatus']='baseline-and-owned-observer-restored';(a.output/'result.json').write_text(json.dumps(j.report,indent=2)+'\n');print('recovery complete');sys.exit(0)
try:j.run()
except BaseException as e:
 j.report.update(status='failed',error=str(e),traceback=traceback.format_exc());j.persist()
 try:j.capture('failure')
 except Exception:pass
finally:
 try:j.cleanup()
 except BaseException as e:j.report.update(status='failed-cleanup',cleanupError=str(e),cleanupTraceback=traceback.format_exc())
 (a.output/'result.json').write_text(json.dumps(j.report,indent=2)+'\n')
print(j.report['status']);sys.exit(0 if j.report['status']=='passed-ordinary-relay-settings-workflow' else 1)
