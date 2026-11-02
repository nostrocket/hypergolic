#!/usr/bin/env python3
"""Ordinary protected-owner Android notification journey; preserves retained app data."""
import argparse, importlib.util, json, re, subprocess, time, xml.etree.ElementTree as ET
from pathlib import Path
import sys
ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'tests/native/presentation'))
from evidence import sha,sources
spec=importlib.util.spec_from_file_location('physical_geometry',ROOT/'tests/native/presentation/config-namespace-android.py')
base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
PACKAGE='org.nostrocket.hypergolic.emptyacceptance'
COMPONENT=PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity'
PUBLISHER='f'*64
class Journey(base.Journey):
 def __init__(self,args):
  super().__init__(args)
  self.owned=[];self.granted=set();self.permissions_empty=False;self.started_empty=False
  self.report.update(kind='hypergolic-ordinary-android-notifications-v1',section=args.section,scope='Physical ordinary Android app, real protected identity owner and genuine bundled SDK. Reserved unsigned fixture publisher; no signed published, OS push, iOS or complete security claim.',observerSha256=sha(Path(__file__).read_bytes()),ownedViews=self.owned)
 def persist(self):
  (self.args.output/'progress.json').write_text(json.dumps(self.report,indent=2)+'\n')
 def check(self,name):
  super().check(name);self.persist()
 def guest_viewport(self,nodes):
  for attempt in range(8):
   views=[n for n in nodes if n.get('class')=='android.webkit.WebView' and self.visible(n)]
   frames={n.get('bounds') for n in views}
   parse=lambda n:tuple(map(int,re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',n.get('bounds')).groups()))
   if len(frames)==1:return parse(views[0])
   if views:
    bounds=[parse(n) for n in views]
    nested=all(any(child is second for child in first.iter('node')) or any(child is first for child in second.iter('node')) for i,first in enumerate(views) for second in views[i+1:])
    if nested and all(max(b[i] for b in bounds)-min(b[i] for b in bounds)<=1 for i in range(4)):
     intersection=(max(b[0] for b in bounds),max(b[1] for b in bounds),min(b[2] for b in bounds),min(b[3] for b in bounds))
     self.report.setdefault('nestedGuestFrameRounding',[]).append({'frames':sorted(frames),'intersection':intersection,'snapshotSha256':sha(self.xml)})
     return intersection
   self.report.setdefault('unsettledGuestFrames',[]).append({'attempt':attempt,'frames':sorted(frames),'snapshotSha256':sha(self.xml)})
   if hasattr(self,'args'):(self.args.output/('unsettled-guest-viewport-'+str(len(self.report['unsettledGuestFrames']))+'.xml')).write_bytes(self.xml)
   self.persist();time.sleep(.2);nodes=self.nodes()
  raise AssertionError('Focused native guest geometry did not settle uniquely')
 def guest_find(self,label):
  deadline=time.monotonic()+75;stalled=0;previous=None
  for attempt in range(14):
   nodes=self.nodes();a,b,c,d=self.guest_viewport(nodes);matches=[n for n in nodes if label in (n.get('resource-id'),n.get('text'),n.get('content-desc'))];assert len(matches)<=1,'Ambiguous SDK control: '+label
   target=matches[0] if matches else None
   if target is not None:
    x1,y1,x2,y2=map(int,re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',target.get('bounds')).groups())
    if x2>x1 and y2-y1>40 and a<(x1+x2)//2<c and b+80<(y1+y2)//2<d-80:return
    direction='up' if (y1+y2)//2>(b+d)//2 else 'down'
   else:direction='up'
   fingerprint=sha(self.xml);stalled=stalled+1 if fingerprint==previous else 0;previous=fingerprint
   self.report['currentSDKNavigation']={'control':label,'attempt':attempt,'direction':direction,'unchangedSnapshots':stalled};self.persist()
   if stalled>=4 or time.monotonic()>=deadline:self.capture('bounded-guest-navigation-stall');raise AssertionError('Bounded actual guest navigation did not expose '+label)
   # Bring a clipped/near-edge control into the safe region without a full-page fling.
   centre=(y1+y2)//2 if target is not None else (d if direction=='up' else b)
   needed=centre-(d-120) if direction=='up' else b+120-centre
   distance=max(96,min((d-b)//4,needed));middle=(b+d)//2;x=a+(c-a)//4
   start=middle+distance//2 if direction=='up' else middle-distance//2;end=start-distance if direction=='up' else start+distance
   args=['swipe',str(x),str(start),str(x),str(end),'600'];self.report['inputs'].append({'control':'observed physical guest viewport measured slow drag','bounds':[a,b,c,d],'targetBounds':target.get('bounds') if target is not None else None,'input':args});self.adb('shell','input',*args);time.sleep(.2)
  self.capture('bounded-guest-navigation-exhausted');raise AssertionError('Actual SDK control not exposed within bounded drags: '+label)
 def nodes(self):
  if self.args.ui_jar:
   self.adb('shell','rm','-f','/data/local/tmp/hg-notify.xml');remote='/data/local/tmp/hg-notify-uia.jar';result=self.adb('shell','CLASSPATH=/system/framework/android.test.base.jar:/system/framework/android.test.runner.jar:/system/framework/uiautomator.jar:'+remote,'app_process','/system/bin','com.android.commands.uiautomator.Launcher','runtest','-c','org.nostrocket.hypergolic.proof.NotifyUiDump','-e','jars',remote);assert 'aborted' not in result and 'INSTRUMENTATION_STATUS_CODE: 0' in result and 'OK (1 test)' in result,'Fresh native observer failed'
  else:self.adb('shell','uiautomator','dump','--compressed','/data/local/tmp/hg-notify.xml')
  self.xml=self.adb('exec-out','cat','/data/local/tmp/hg-notify.xml',binary=True)
  rows=list(ET.fromstring(self.xml).iter('node'));assert any(n.get('package')==PACKAGE for n in rows),'Retained Hypergolic is not foreground';return rows
 def data(self,label,minimum_events=0,previous_id=None):
  deadline=time.monotonic()+40
  while time.monotonic()<deadline:
   rows=[n for n in self.nodes() if n.get('resource-id')==label];assert len(rows)<=1,'Ambiguous SDK report: '+label
   if rows:
    try:value=json.loads(rows[0].get('text',''))
    except json.JSONDecodeError:value=None
    if value is not None and (not minimum_events or isinstance(value,list) and len(value)>=minimum_events) and (previous_id is None or isinstance(value,dict) and value.get('notificationId')!=previous_id):return value
   time.sleep(.2)
  raise AssertionError('Fresh bounded original SDK report absent: '+label)
 def present(self,label):return any(label in (n.get('resource-id'),n.get('text'),n.get('content-desc')) for n in self.nodes())
 def launch(self,cold=False):
  if cold:self.adb('shell','am','force-stop',PACKAGE)
  self.adb('shell','am','start','-W','-n',COMPONENT);self.find('shell-settings')
 def settings(self):
  self.tap('shell-settings')
  try:self.find('settings-full-npub',timeout=6)
  except Exception:
   self.capture('first-settings-input-miss');self.report.setdefault('settingsInputMisses',0);self.report['settingsInputMisses']+=1;self.tap('shell-settings');self.find('settings-full-npub')
  assert self.find('settings-full-npub').get('text')==self.args.npub,'Selected identity changed'
 def permission_count(self):
  node=self.settings_find('notify-permissions-open');text=' '.join(n.get('text','')+' '+n.get('content-desc','') for n in node.iter('node'))
  match=re.search(r'Manage notification permissions \((\d+)\)',text);assert match,'Native permission count absent';return int(match[1])
 def baseline(self):
  if self.args.ui_jar:
   local=sha(self.args.ui_jar.read_bytes());assert sha(self.adb('exec-out','cat','/data/local/tmp/hg-notify-uia.jar',binary=True))==local;self.report['nativeObserverJarSha256']=local;self.report['nativeObserverSourceSha256']=sha((ROOT/'tests/native/presentation/NotifyUiDump.java').read_bytes())
  policy=self.adb('shell','dumpsys','window','policy');assert 'showing=false' in policy and 'inputRestricted=false' in policy,'Device is locked'
  self.report['inventoryBefore']=self.adb('shell','pm','list','packages','-3').splitlines()
  receipt=json.loads(self.args.build.read_text());assert receipt['status']=='passed-signed-isolated-package-subset' and receipt['applicationId']==PACKAGE
  apkhash=sha(self.args.apk.read_bytes());assert receipt['signedApkSha256']==apkhash
  installed=self.adb('exec-out','cat',self.adb('shell','pm','path',PACKAGE).removeprefix('package:'),binary=True);assert sha(installed)==apkhash
  old=json.loads((self.args.build.parent/'source-inputs.json').read_text());changed=[p for p,h in old.items() if not (ROOT/p).is_file() or sha((ROOT/p).read_bytes())!=h]
  assert all(p.startswith(('docs/','.planning/','tests/native/presentation/')) for p in changed),'Owning product inputs differ from installed normal build'
  self.report.update(installedApkSha256=apkhash,buildReceiptSha256=sha(self.args.build.read_bytes()),packagedSourceHead=receipt['sourceHead'],changedNonProductInputsSincePackaging=changed,selectedDevelopmentNpub=self.args.npub,sourceHead=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),webView=self.adb('shell','dumpsys','webviewupdate'),reservedUnsignedPublisher=PUBLISHER)
  self.launch();self.find('empty-open-napplet');self.started_empty=True;self.settings();assert self.permission_count()==0,'Existing permissions preserved; this journey requires an empty permission baseline'
  self.settings_tap('notify-permissions-open');self.find('notify-permissions-empty');self.capture('native-empty-permissions-baseline');self.permissions_empty=True;self.tap('notify-permissions-close');self.tap('settings-done');self.capture('native-empty-workspace-baseline')
 def open_lab(self,peer=False):
  self.settings();self.settings_tap('settings-open-routing-lab-peer' if peer else 'settings-open-routing-lab');self.find('SDK ready for routing.')
  identity=self.instance();assert identity.startswith('routing-lab-peer-' if peer else 'routing-lab-');assert identity not in self.owned;self.owned.append(identity);self.persist()
  title=self.find('focused-napplet-name').get('text');self.report.setdefault('opened',[]).append({'instance':identity,'title':title,'appId':'routing-lab-peer' if peer else 'routing-lab'})
  self.capture('peer-sdk-ready' if peer else 'caller-sdk-ready');return identity
 def permission(self,channel='',allow=True,remembered=False,app='routing-lab'):
  self.guest('Request notification permission')
  if not remembered:
   self.find('Allow notifications?');self.find(app);self.find(base.npub(PUBLISHER));self.find(self.args.npub);assert self.find('notify-review-channel').get('text')==(channel or 'General notifications')
   self.capture('native-'+app+'-'+(channel or 'general')+('-allow-review' if allow else '-deny-review'))
   if allow:self.granted.add((app,channel));self.report['newlyApprovedScopes']=sorted(self.granted);self.persist()
   self.tap('notify-allow' if allow else 'notify-deny')
  self.find('Notification permission granted.' if allow else 'Notification permission denied.');assert self.data('notify-permission-result')=={'granted':allow};self.absent('Allow notifications?')
 def send(self,previous=None):
  self.guest('Send notification');self.find('Notification sent.');value=self.data('notify-result',previous_id=previous);assert isinstance(value.get('notificationId'),str) and value['notificationId'];self.report.setdefault('sdkSendReceipts',[]).append({'instance':self.instance(),**value});return value['notificationId']
 def source_attribution(self,label,source_text,click_id=None):
  nodes=self.nodes();containers=[n for n in nodes if n.get('resource-id')==label];assert len(containers)==1,'Native attributed container is not unique'
  def frame(node):return tuple(map(int,re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',node.get('bounds')).groups()))
  a,b,c,d=frame(containers[0]);assert c>a and d>b,'Native attributed container is not visible'
  members=[]
  for node in nodes:
   x1,y1,x2,y2=frame(node)
   if x2>x1 and y2>y1 and a<=x1<x2<=c and b<=y1<y2<=d:members.append(node)
  assert sum(n.get('text')==source_text for n in members)==1,'Native source text is not bound to this container'
  assert sum(n.get('text')==base.npub(PUBLISHER) for n in members)==1,'Native publisher is not bound to this container'
  if click_id:
   clicks=[n for n in members if n.get('resource-id')==click_id];assert len(clicks)==1 and clicks[0].get('content-desc')=='Routing Lab alert\nExact SDK notification + ⚡','Exact body/click is not bound to this card'
  self.report.setdefault('nativeSourceAttributions',[]).append({'containerId':label,'sourceText':source_text,'publisher':PUBLISHER,'bounds':[a,b,c,d],'clickId':click_id})
 def centre(self,id=None,app='routing-lab'):
  self.tap('notify-centre-open');self.find('Notifications')
  if id:
   self.source_attribution('notify-card-'+id,'From '+app,'notify-click-'+id)
 def events(self,count=0):
  initial=self.find('notify-events').get('text','');value=[] if count==0 and initial=='' else self.data('notify-events',minimum_events=count);assert isinstance(value,list);self.report.setdefault('sdkEventSnapshots',[]).append({'instance':self.instance(),'events':value});return value
 def edit_channel(self,value):
  self.guest_find('notify-channel');self.tap('notify-channel');self.find('notify-channel');self.adb('shell','input','keyevent','KEYCODE_MOVE_END');self.adb('shell','input','keycombination','113','29');self.adb('shell','input','keyevent','67')
  if value:self.adb('shell','input','text',value)
  assert self.find('notify-channel').get('text','')==value,'Guest channel input was not reflected';self.adb('shell','input','keyevent','4');assert self.find('notify-channel').get('text','')==value
 def revoke(self,app,channel):
  assert self.permissions_empty and (app,channel) in self.granted,'Refuse revoking a pre-existing or unknown grant'
  self.settings();self.settings_tap('notify-permissions-open');self.settings_tap('notify-revoke-'+app+'-'+(channel or 'general'));self.find('Notification permission revoked.');self.capture('native-revoked-'+app+'-'+(channel or 'general'));self.tap('notify-permissions-close');self.tap('settings-done');self.granted.remove((app,channel))
 def background(self,name):
  self.adb('shell','input','keyevent','3');deadline=time.monotonic()+20
  while time.monotonic()<deadline:
   dump=self.adb('shell','dumpsys','activity','activities');blocks=re.split(r'\* Hist\s+#\d+:',dump);owned=[b for b in blocks[1:] if COMPONENT in b.splitlines()[0]]
   resumed=[line.strip() for line in dump.splitlines() if 'topResumedActivity=' in line or 'mResumedActivity:' in line]
   if len(owned)==1 and re.search(r'\b(?:mState|state)=(?:STOPPED|PAUSED)\b',owned[0]) and resumed and all(PACKAGE not in line for line in resumed):break
   time.sleep(.5)
  else:raise AssertionError('Exact keeper activity did not enter observed background')
  (self.args.output/(name+'-activity.txt')).write_text(dump+'\n');self.report.setdefault('confirmedBackground',[]).append({'name':name,'keeperActivity':COMPONENT,'resumed':resumed,'state':re.search(r'\b(?:mState|state)=(STOPPED|PAUSED)\b',owned[0])[1]});self.launch();self.find('SDK ready for routing.')
 def close_owned(self,id):
  assert id in self.owned;self.tap('handle-right');self.find('napplet-overview');self.tap('overview-close-'+id);self.find('close-confirm');self.capture('native-owned-close-review');self.tap('close-confirm');self.find('napplet-overview');self.absent('overview-card-'+id);self.report.setdefault('closedOwnedViews',[]).append(id)
 def callbacks(self):
  caller=self.open_lab();controls=self.data('notify-controls');assert set(controls)=={'toasts','badges','actions','channels'};self.report['sdkControls']=controls;self.check('physical-original-sdk-in-app-notification-controls')
  self.permission(allow=False);self.check('physical-native-denial-original-sdk-result')
  self.permission();self.check('physical-native-source-identity-general-approval')
  first=self.send();self.centre(first);self.capture('native-attributed-card-action');self.tap('notify-action-reply');self.tap('notify-centre-close');assert self.events(1)==[{'kind':'action','notificationId':first,'actionId':'reply'}];self.check('physical-exact-action-original-sdk-callback')
  second=self.send(first);self.centre(second);self.capture('native-attributed-card-click');self.tap('notify-click-'+second);self.tap('notify-centre-close');assert self.events(2)[-1]=={'kind':'clicked','notificationId':second};self.check('physical-exact-click-original-sdk-callback')
  third=self.send(second);self.centre(third);self.capture('native-attributed-card-dismiss');self.tap('notify-dismiss-'+third);self.tap('notify-centre-close');assert self.events(3)[-1]=={'kind':'dismissed','notificationId':third,'reason':'user'};self.capture('sdk-three-native-callbacks');self.check('physical-exact-user-dismiss-original-sdk-callback')
  self.permission(remembered=True);self.check('physical-remembered-general-grant-without-review')
  self.guest('Send oversized notification');denied=self.data('notify-oversized-result');assert denied.get('accepted') is False and denied.get('error');self.report['sdkOversized']=denied;self.capture('sdk-oversized-denial');self.check('physical-oversized-sdk-request-timely-denial')
  live=self.send(third);before=self.events(3);self.guest('Send invalid notification controls');self.find('Invalid guest notification controls sent.');assert self.events(3)==before;self.centre(live);self.absent('Forged source');self.capture('native-forged-controls-retained-card');self.tap('notify-centre-close');self.check('physical-forged-controls-no-sdk-callback-retains-card-subset')
  self.guest('Set notification badge');self.find('Badge requested.');self.centre(live);self.source_attribution('notify-badge-routing-lab','routing-lab');self.find('Badge count: 3');self.capture('native-source-attributed-badge');self.tap('notify-centre-close');self.check('physical-native-source-attributed-badge')
  peer=self.open_lab(True);self.centre(live);self.find('notify-badge-routing-lab');self.capture('native-foreground-peer-retains-caller-card-badge');self.tap('notify-centre-close');assert self.events()==[];self.focus_instance(caller);assert self.events(3)==before;self.check('physical-loaded-foreground-switch-retains-caller-no-peer-callback')
  self.background('ordinary-background');self.absent('notify-centre-open');self.absent('notify-toast');self.capture('native-background-return-no-backlog');self.check('physical-confirmed-os-background-clears-cards-and-badges')
  self.permission(remembered=True);self.send(live);pid=self.adb('shell','pidof',PACKAGE);self.report['pidBeforeCold']=pid;self.launch(cold=True);self.find('SDK ready for routing.');assert self.instance()==caller;after=self.adb('shell','pidof',PACKAGE);assert after and after!=pid;self.report['pidAfterCold']=after;self.absent('notify-centre-open');assert self.events()==[];self.permission(remembered=True);self.capture('native-process-death-no-backlog-remembered-grant');self.check('physical-process-death-no-replay-keeps-exact-general-grant')
  self.revoke('routing-lab','');self.guest('Send notification');self.find('Request failed: permission denied');self.check('physical-native-settings-revoke-denies-sdk-send')
  self.permission();self.send();self.check('physical-revoked-general-grant-fresh-review-positive-send')
 def channels(self):
  caller=self.open_lab();self.permission();self.guest('Register messages channel');self.find('Channel registration sent.');self.edit_channel('messages');self.guest('Send notification');self.find('Request failed: permission denied');self.capture('sdk-general-grant-channel-denied');self.check('physical-general-grant-does-not-authorize-messages-channel')
  self.permission('messages');live=self.send();self.centre(live);self.capture('native-channel-positive-attributed-card');self.tap('notify-centre-close');self.check('physical-exact-messages-native-review-positive-sdk-send')
  peer=self.open_lab(True);self.guest('Send notification');self.find('Request failed: permission denied');assert self.events()==[];self.capture('sdk-distinct-app-grant-denied');self.centre(live);self.tap('notify-action-reply');self.tap('notify-centre-close');assert self.events()==[];self.focus_instance(caller);assert self.events(1)==[{'kind':'action','notificationId':live,'actionId':'reply'}];self.check('physical-native-action-while-peer-focused-reaches-only-caller');live=self.send(live);self.centre(live);self.tap('notify-centre-close');self.check('physical-different-app-no-caller-grant-retains-caller-card')
  self.revoke('routing-lab','messages');self.absent('notify-centre-open');self.guest('Send notification');self.find('Request failed: permission denied');self.check('physical-exact-channel-revoke-clears-card-denies-sdk-send')
  self.edit_channel('');general=self.send(live);self.centre(general);self.tap('notify-centre-close');self.check('physical-channel-revoke-preserves-general-grant')
  self.edit_channel('messages');self.permission('messages');new=self.send(general);self.check('physical-revoked-channel-fresh-review-positive-send')
  self.guest('Run notification flood');rows=self.data('notify-flood-result')['results'];accepted=[r['notificationId'] for r in rows if r.get('ok')];assert len(rows)==20 and 0<len(accepted)<=6 and len(accepted)==len(set(accepted)) and all(r.get('error')=='rate limited' for r in rows if not r.get('ok'));self.report['sdkFlood']=rows;self.capture('sdk-bounded-sequential-flood');self.check('physical-sequential-sdk-flood-bounded-unique-receipts')
  self.close_owned(caller);self.absent('notify-centre-open');self.absent('notify-toast');self.capture('native-close-removes-exact-source-alerts');self.check('physical-owned-caller-close-clears-native-alert-source')
  self.tap('overview-card-'+peer);self.find('SDK ready for routing.');assert self.instance()==peer and self.events()==[];self.check('physical-closed-caller-no-peer-callback-subset')
 def cleanup(self):
  if not self.started_empty:return
  self.launch();
  for _ in range(8):
   rows=self.nodes()
   if any(n.get('resource-id') in ['notify-allow','notify-centre-close','notify-permissions-close'] for n in rows):self.adb('shell','input','keyevent','4');continue
   if any(n.get('resource-id')=='settings-done' and self.visible(n) for n in rows):self.tap('settings-done');continue
   if any(n.get('resource-id')=='close-confirm' and self.visible(n) for n in rows):self.tap('close-confirm');continue
   break
  if self.permissions_empty:
   for app,channel in sorted(self.granted.copy()):self.revoke(app,channel)
   self.settings();assert self.permission_count()==0;self.settings_tap('notify-permissions-open');self.find('notify-permissions-empty');self.capture('native-final-empty-permissions');self.tap('notify-permissions-close');self.tap('settings-done');self.report['permissionBaselineRestored']=True
  for _ in range(5):
   if self.present('empty-open-napplet'):break
   if not self.present('napplet-overview'):self.tap('handle-right');self.find('napplet-overview')
   closers=[n.get('resource-id').removeprefix('overview-close-') for n in self.nodes() if n.get('resource-id','').startswith('overview-close-') and self.visible(n)];assert closers and set(closers)<=set(self.owned),'Refuse cleanup of unowned workspace'
   id=closers[0];self.tap('overview-close-'+id);self.find('close-confirm');self.tap('close-confirm');self.report.setdefault('closedOwnedViews',[]).append(id)
  self.find('empty-open-napplet');self.absent('notify-centre-open');self.settings();self.capture('native-final-retained-identity');self.tap('settings-done');self.capture('native-final-empty-workspace');self.report['emptyWorkspaceRestored']=True
  self.report['inventoryAfter']=self.adb('shell','pm','list','packages','-3').splitlines();assert self.report['inventoryAfter']==self.report['inventoryBefore'];self.report['installedApkSha256After']=sha(self.adb('exec-out','cat',self.adb('shell','pm','path',PACKAGE).removeprefix('package:'),binary=True));assert self.report['installedApkSha256After']==self.report['installedApkSha256'];self.report['sourceAfter']=sources();assert self.report['sourceAfter']==self.report['sourceBefore'];self.report['retainedAppInventoryAndInputsUnchanged']=True
 def run(self):
  self.baseline();self.callbacks() if self.args.section=='callbacks' else self.channels();self.report['status']='passed-scoped-physical-notifications'
if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--serial',required=True);p.add_argument('--npub',required=True);p.add_argument('--section',choices=['callbacks','channels'],required=True);p.add_argument('--ui-jar',type=Path)
 for name in ['build','apk','output']:p.add_argument('--'+name,type=Path,required=True)
 a=p.parse_args();j=Journey(a)
 try:j.run()
 except BaseException as error:
  j.report.update(status='failed',error=str(error) or type(error).__name__);j.persist()
  try:j.capture('failure')
  except Exception:pass
 finally:
  try:j.cleanup()
  except BaseException as error:j.report.update(status='failed-cleanup',cleanupError=str(error) or type(error).__name__)
  finally:(a.output/'result.json').write_text(json.dumps(j.report,indent=2)+'\n')
 if j.report['status']!='passed-scoped-physical-notifications':raise SystemExit(1)
