#!/usr/bin/env python3
"""Protected-owner Android signed notification publisher isolation; locally supplied transport."""
import argparse,importlib.util,json,re,subprocess,sys,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'tests/native/presentation'))
from evidence import sha,sources
spec=importlib.util.spec_from_file_location('ordinary_notify',ROOT/'tests/native/presentation/notify-physical-android.py');base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
rows=json.loads((ROOT/'tests/native/presentation/published-fixture.ts').read_text().split(' = ',1)[1].rsplit(' as const;',1)[0]);fixtures={row['role']:row for row in rows}
def frame(node):return tuple(map(int,re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',node.get('bounds')).groups()))
def visible(node):
 try:a,b,c,d=frame(node);return c>a and d>b
 except (AttributeError,ValueError):return False
def permission_button(nodes,publisher,app,channel):
 origins=[n for n in nodes if n.get('text')==publisher and visible(n)];assert len(origins)==1,'Permission publisher not uniquely visible'
 origin=origins[0];a,b,c,d=frame(origin);label='notify-revoke-'+app+'-'+(channel or 'general')
 buttons=[n for n in nodes if n.get('resource-id')==label and n.get('clickable')=='true' and n.get('enabled')=='true' and visible(n) and frame(n)[1]>=d];assert buttons,'No exact publisher revoke control'
 buttons.sort(key=lambda n:frame(n)[1]);button=buttons[0];bottom=frame(button)[1]
 titles=[n for n in nodes if n.get('text')==app and visible(n) and frame(n)[3]<=b];assert titles,'Permission app title absent';titles.sort(key=lambda n:frame(n)[3]);title=titles[-1]
 assert not any(n.get('text')==app and visible(n) and d<=frame(n)[1]<bottom for n in nodes),'Next publisher row cannot supply this revoke button'
 labels=[n for n in nodes if n.get('text')==(channel or 'General notifications') and visible(n) and d<=frame(n)[1] and frame(n)[3]<=bottom];assert len(labels)==1,'Permission channel not bound to publisher row'
 assert frame(title)[1]<b<d<=frame(labels[0])[1]<bottom,'Native permission row order invalid'
 return button
class Journey(base.Journey):
 def __init__(self,args):
  super().__init__(args);self.publisher_grants=set();self.role_ids={};self.report.update(kind='hypergolic-protected-android-notification-publisher-v1',section='publishers',observerSha256=sha(Path(__file__).read_bytes()),scope='Physical real protected owner, genuine SDK and normal verified signed loader. Exact local signed sources; no external relay/HTTPS publication, identity/version parity or complete CAP-10 claim.',fixtureEvents={role:fixtures[role]['event']['id'] for role in ['caller','notify-collision']})
 def baseline(self):
  policy=self.adb('shell','dumpsys','window','policy');assert 'showing=false' in policy and 'inputRestricted=false' in policy
  self.report['inventoryBefore']=self.adb('shell','pm','list','packages','-3').splitlines();receipt=json.loads(self.args.build.read_text());assert receipt['status']=='built' and receipt['package']==base.PACKAGE and receipt['sourceRestored'] and receipt['productionCompositionRestored'] and receipt['realIdentityOwnerUnchanged'];current=sources();previous=receipt['sourceAfter'];changed=[name for name in sorted(set(previous)|set(current)) if previous.get(name)!=current.get(name)];allowed={'tests/native/presentation/notify-publisher-physical-android.py','tests/native/presentation/notify-physical-android.py','tests/native/presentation/test-physical-navigation.py','tests/native/presentation/test-protected-builder-restoration.py','tests/native/presentation/notify-version-physical-android.py'};assert set(changed)<=allowed,'Owning packaged product source changed';self.report['changedHostOnlyInputsSincePackaging']=changed
  digest=sha(self.args.apk.read_bytes());assert receipt['productSha256']==digest;actual=self.adb('exec-out','cat',self.adb('shell','pm','path',base.PACKAGE).removeprefix('package:'),binary=True);assert sha(actual)==digest;self.report.update(installedApkSha256=digest,buildReceiptSha256=sha(self.args.build.read_bytes()),sourceHead=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),selectedDevelopmentNpub=self.args.npub)
  local=sha(self.args.ui_jar.read_bytes());assert sha(self.adb('exec-out','cat','/data/local/tmp/hg-notify-uia.jar',binary=True))==local;self.report.update(nativeObserverJarSha256=local,nativeObserverSourceSha256=sha((ROOT/'tests/native/presentation/NotifyUiDump.java').read_bytes()))
  self.launch();self.find('empty-open-napplet');self.started_empty=True;self.settings();assert self.permission_count()==0,'Preserve existing notify grants; require empty selected-owner baseline';self.settings_tap('notify-permissions-open');self.find('notify-permissions-empty');self.capture('native-zero-permissions-protected-baseline');self.permissions_empty=True;self.tap('notify-permissions-close');self.tap('settings-done');self.capture('native-empty-protected-baseline')
 def open_signed(self,role):
  self.report['pendingOwnedOpen']={'role':role,'eventId':fixtures[role]['event']['id']};self.persist();self.settings();self.enter_address(fixtures[role]['address']);self.settings_tap('settings-open-napplet');deadline=time.monotonic()+45
  while time.monotonic()<deadline:
   nodes=self.nodes()
   if any(n.get('resource-id')=='settings-napplet-approve' for n in nodes):
    self.settings_find('Allow this napplet?');self.settings_find('Requested access: notify');self.capture('native-signed-access-review-'+role);self.settings_tap('settings-napplet-approve');self.report.setdefault('signedAccessReviews',[]).append({'role':role,'eventId':fixtures[role]['event']['id'],'domain':'notify'});break
   if any(n.get('text')=='SDK ready for routing.' for n in nodes) and not any(n.get('resource-id')=='settings-done' and self.visible(n) for n in nodes):break
   time.sleep(.2)
  else:raise AssertionError('Signed loader did not reach exact consent or restored SDK')
  self.find('SDK ready for routing.');id=self.instance();assert id not in self.owned;self.owned.append(id);self.role_ids[role]=id;self.report['signedInstances']=self.role_ids;self.persist();assert self.find('focused-napplet-name').get('text')==fixtures[role]['appId'];self.capture('native-signed-sdk-ready-'+role);return id
 def permission_signed(self,role,remembered=False):
  row=fixtures[role];self.guest('Request notification permission')
  if not remembered:
   self.find('Allow notifications?');self.find(row['appId']);self.find(base.base.npub(row['event']['pubkey']));self.find(self.args.npub);assert self.find('notify-review-channel').get('text')=='General notifications';self.capture('native-exact-notify-review-'+role);self.publisher_grants.add((row['event']['pubkey'],row['appId'],''));self.report['newlyApprovedPublisherScopes']=sorted(self.publisher_grants);self.persist();self.tap('notify-allow')
  self.find('Notification permission granted.');assert self.data('notify-permission-result')=={'granted':True};self.absent('Allow notifications?')
 def card(self,id,role):
  self.tap('notify-centre-open');self.find('Notifications');nodes=self.nodes();containers=[n for n in nodes if n.get('resource-id')=='notify-card-'+id and visible(n)];assert len(containers)==1,'Exact native source card absent';a,b,c,d=frame(containers[0]);members=[n for n in nodes if visible(n) and a<=frame(n)[0]<frame(n)[2]<=c and b<=frame(n)[1]<frame(n)[3]<=d];row=fixtures[role];assert sum(n.get('text')=='From '+row['appId'] for n in members)==1;assert sum(n.get('text')==base.base.npub(row['event']['pubkey']) for n in members)==1;assert sum(n.get('resource-id')=='notify-click-'+id and n.get('content-desc')=='Routing Lab alert\nExact SDK notification + ⚡' for n in members)==1;self.report.setdefault('signedNativeCardOrigins',[]).append({'notificationId':id,'role':role,'publisher':row['event']['pubkey'],'appId':row['appId'],'instance':self.role_ids[role],'bounds':[a,b,c,d]})
 def revoke_publisher(self,publisher,app,channel):
  scope=(publisher,app,channel);assert self.permissions_empty and scope in self.publisher_grants,'Refuse touching unknown/preexisting grant';self.settings();self.settings_tap('notify-permissions-open');self.settings_find(base.base.npub(publisher));nodes=self.nodes();button=permission_button(nodes,base.base.npub(publisher),app,channel);self.capture('native-publisher-row-revoke-'+publisher[:8]);a,b,c,d=frame(button);args=['tap',str((a+c)//2),str((b+d)//2)];self.report['inputs'].append({'control':'Exact publisher/app/channel native revoke row','publisher':publisher,'appId':app,'channel':channel,'bounds':[a,b,c,d],'snapshotSha256':sha(self.xml),'input':args});self.adb('shell','input',*args);self.find('Notification permission revoked.');self.capture('native-publisher-revoked-'+publisher[:8]);self.tap('notify-permissions-close');self.tap('settings-done');self.publisher_grants.remove(scope)
 def run(self):
  self.baseline();caller=self.open_signed('caller');self.permission_signed('caller');first=self.send();self.card(first,'caller');self.capture('native-caller-real-publisher-card');self.tap('notify-centre-close');self.check('physical-signed-caller-exact-publisher-review-and-sdk-send')
  collision=self.open_signed('notify-collision');self.guest('Send notification');self.find('Request failed: permission denied');self.card(first,'caller');self.capture('native-collision-denied-caller-card-retained');self.tap('notify-centre-close');assert self.events()==[];self.check('physical-same-app-and-html-different-publisher-does-not-inherit-grant')
  self.focus_instance(caller);self.guest('Dismiss last notification');self.find('Dismissal requested.');assert self.events(1)==[{'kind':'dismissed','notificationId':first,'reason':'user'}];self.focus_instance(collision);self.permission_signed('notify-collision');second=self.send();self.card(second,'notify-collision');self.capture('native-collision-own-review-positive-card');self.tap('notify-centre-close');self.check('physical-collision-own-publisher-approval-positive-sdk-send')
  self.revoke_publisher(fixtures['caller']['event']['pubkey'],fixtures['caller']['appId'],'');self.card(second,'notify-collision');self.tap('notify-centre-close');self.focus_instance(caller);self.guest('Send notification');self.find('Request failed: permission denied');self.capture('sdk-revoked-caller-denied-other-publisher-retained');self.check('physical-exact-publisher-revoke-retains-other-publisher-grant-and-card')
  self.card(second,'notify-collision');self.tap('notify-click-'+second);self.tap('notify-centre-close');assert self.events(1)==[{'kind':'dismissed','notificationId':first,'reason':'user'}];self.focus_instance(collision);assert self.events(1)==[{'kind':'clicked','notificationId':second}];self.capture('sdk-exact-unfocused-publisher-click');self.check('physical-unfocused-signed-publisher-callback-no-caller-delivery')
  before=self.adb('shell','pidof',base.PACKAGE);self.launch(cold=True);self.find('SDK ready for routing.');after=self.adb('shell','pidof',base.PACKAGE);assert after and after!=before and self.instance()==collision;assert self.events()==[];self.permission_signed('notify-collision',remembered=True);third=self.send();self.card(third,'notify-collision');self.capture('native-cold-signed-publisher-permission-card');self.tap('notify-centre-close');self.report['coldRestartPids']={'before':before,'after':after};self.check('physical-cold-signed-publisher-grant-restores-without-old-callback-replay');self.report['status']='passed-scoped-physical-notifications'
 def cleanup(self):
  if self.started_empty:
   self.launch()
   for _ in range(8):
    nodes=self.nodes()
    if any(n.get('resource-id') in ['notify-allow','notify-centre-close','notify-permissions-close'] for n in nodes):self.adb('shell','input','keyevent','4');continue
    if any(n.get('resource-id')=='settings-done' and self.visible(n) for n in nodes):self.tap('settings-done');continue
    break
   for publisher,app,channel in sorted(self.publisher_grants.copy()):self.revoke_publisher(publisher,app,channel)
  super().cleanup()
if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--serial',required=True);p.add_argument('--npub',required=True);p.add_argument('--ui-jar',type=Path,required=True)
 for name in ['build','apk','output']:p.add_argument('--'+name,type=Path,required=True)
 a=p.parse_args();a.section='publishers';j=Journey(a)
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
