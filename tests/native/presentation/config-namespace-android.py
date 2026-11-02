#!/usr/bin/env python3
"""Physical configuration namespace/update observer, using the original SDK and native UI."""
import argparse, importlib.util, json, re, subprocess, time
from pathlib import Path
import sys
ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'tests/native/presentation'))
from evidence import sha,sources
spec=importlib.util.spec_from_file_location('config_lifecycle',ROOT/'tests/native/presentation/lifecycle-android.py');base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
PACKAGE=base.PACKAGE
EXPECTED_NPUB='npub183rrxlc9zht3lptqrjd98rxztxu5yztsek5thjwq7xp9vmr4ya6sx97kd5'
fixtures=json.loads((ROOT/'tests/native/presentation/published-fixture.ts').read_text().split(' = ',1)[1].rsplit(' as const;',1)[0])
by_role={row['role']:row for row in fixtures}
DEFAULTS=base.config.DEFAULTS
OLD_TOKEN='public-namespace-original-token'
COLLISION_TOKEN='public-namespace-other-publisher'
def npub(pub):
 return subprocess.check_output(['node','--input-type=module','-e','import {npubEncode} from "nostr-tools/nip19"; console.log(npubEncode(process.argv[1]))',pub],cwd=ROOT,text=True).strip()
def version(role):return next(t[1] for t in by_role[role]['event']['tags'] if t[:1]==['x'])
class Journey(base.Journey):
 def __init__(self,args):
  super().__init__(args);self.empty_baseline=False;self.samples_absent=False;self.navigation_top=None
 def tap(self,label):
  if label not in ['shell-settings','handle-left','handle-right','qa-offer-config-incompatible-update']:return super().tap(label)
  n=self.find(label);x1,y1,x2,y2=map(int,re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',n.get('bounds')).groups());assert x2>x1 and y2>y1;x=(x1+x2)//2;y=(y1+y2)//2
  args=['swipe',str(x),str(y),str(x),str(y),'120'];self.report['inputs'].append({'control':label,'input':args,'meaning':'Observed 120ms native press; no instant-press UX acceptance claim'});self.adb('shell','input',*args)
 def open_role(self,role,domain,first=True):
  address=self.find('signed-'+role+'-address').get('content-desc');self.tap('shell-settings');self.enter_address(address);self.settings_tap('settings-open-napplet')
  deadline=time.monotonic()+45
  while time.monotonic()<deadline:
   nodes=self.nodes()
   if any(n.get('resource-id')=='settings-napplet-approve' for n in nodes):
    self.settings_find('Allow this napplet?');self.settings_find('Requested access: '+domain);self.capture('exact-signed-access-review-'+role);self.settings_tap('settings-napplet-approve');self.report.setdefault('signedAccessReviews',[]).append({'role':role,'eventId':by_role[role]['event']['id'],'domain':domain});break
   if any(n.get('text')=='SDK ready for routing.' for n in nodes) and not any(n.get('resource-id')=='settings-done' and self.visible(n) for n in nodes):
    self.report.setdefault('rememberedSignedAccess',[]).append({'role':role,'eventId':by_role[role]['event']['id'],'basis':'Normal shell closed Settings and restored connected verified SDK without another review; version/publisher are independently checked in native editor.'});break
   time.sleep(.2)
  else:raise AssertionError('Neither exact signed access review nor approved connected view was observed')
  self.find('SDK ready for routing.')
 def update_check(self):
  self.settings_tap('published-update-check-'+self.report['originalInstance'])
 def guest_viewport(self,nodes):
  # Physical Android exposes nested, unlabeled WebView nodes with identical frames.
  frames={n.get('bounds') for n in nodes if n.get('class')=='android.webkit.WebView' and self.visible(n)}
  assert len(frames)==1,'Focused guest geometry is not unique'
  return tuple(map(int,re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',next(iter(frames))).groups()))
 def guest_scroll(self,direction):
  a,b,c,d=self.guest_viewport(self.nodes());x=(a+c)//2;high=b+(d-b)//4;low=b+(d-b)*3//4
  args=['swipe',str(x),str(low if direction=='up' else high),str(x),str(high if direction=='up' else low),'500'];self.report['inputs'].append({'control':'observed unique physical guest viewport scroll','bounds':[a,b,c,d],'input':args});self.adb('shell','input',*args)
 def guest_find(self,label):
  for _ in range(45):
   nodes=self.nodes();a,b,c,d=self.guest_viewport(nodes);matches=[n for n in nodes if label in (n.get('resource-id'),n.get('text'),n.get('content-desc'))]
   for node in matches:
    x1,y1,x2,y2=map(int,re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',node.get('bounds')).groups())
    if x2>x1 and y2-y1>40 and a<(x1+x2)//2<c and b+80<(y1+y2)//2<d-80:return
   target=matches[0] if len(matches)==1 else None
   if target is not None:
    _,y1,_,y2=map(int,re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',target.get('bounds')).groups());direction='up' if (y1+y2)//2>(b+d)//2 else 'down'
   else:direction='up'
   self.guest_scroll(direction);time.sleep(.2)
  raise AssertionError('Original SDK control not exposed in actual physical guest viewport: '+label)
 def edit(self,label,value):
  self.settings_tap(label)
  for _ in range(12):
   field=self.find(label)
   if field.get('focused')=='true':break
   time.sleep(.2)
  else:raise AssertionError('Native field was not focused: '+label)
  self.adb('shell','input','keyevent','KEYCODE_MOVE_END');self.adb('shell','input','keycombination','113','29');self.adb('shell','input','keyevent','67')
  for _ in range(15):
   if self.find(label).get('text','')=='':break
   time.sleep(.2)
  else:raise AssertionError('Native field did not clear before new public input: '+label)
  self.adb('shell','input','text',value)
  secret=field.get('password')=='true'
  for _ in range(15):
   observed=self.find(label)
   if (secret and observed.get('password')=='true' and observed.get('text','') and observed.get('text')!=value) or (not secret and observed.get('text')==value):break
   time.sleep(.2)
  else:raise AssertionError('Native public input was not reflected before keyboard dismissal: '+label)
  self.report.setdefault('nativeFieldInputs',[]).append({'field':label,'publicValue':value,'nativeReadbackVerified':not secret,'nativePasswordMaskVerified':secret})
  self.adb('shell','input','keyevent','4')
  if not secret:assert self.find(label).get('text')==value,'Native public field changed after keyboard dismissal'
 def settings_tap(self,label):
  self.settings_find(label);self.tap(label)
  if label=='config-save':
   for _ in range(20):
    nodes=self.nodes()
    if not any(n.get('resource-id')=='configuration-settings' for n in nodes):return
    errors=[n.get('text') for n in nodes if n.get('resource-id')=='config-save-error' and n.get('text')]
    if errors:raise AssertionError('Native configuration save rejected: '+errors[0])
    time.sleep(.2)
   raise AssertionError('Native configuration save did not close its editor')
 def settings_find(self,label):
  if self.navigation_top is None:
   height=int(re.search(r'Physical size: \d+x(\d+)',self.adb('shell','wm','size'))[1]);windows=self.adb('shell','dumpsys','window','windows');bottoms={int(v) for v in re.findall(r'type=navigationBars[^\n]*insetsSize=Insets\{left=0, top=0, right=0, bottom=(\d+)\}',windows) if int(v)>0};assert len(bottoms)==1,'OS navigation inset is not uniquely observed';self.navigation_top=height-next(iter(bottoms));self.report['observedNavigationTop']=self.navigation_top
  for direction in ['up','down']:
   for _ in range(30):
    nodes=self.nodes();matches=[n for n in nodes if label in (n.get('text'),n.get('content-desc'),n.get('resource-id')) and self.visible(n)]
    clickable=[n for n in matches if n.get('clickable')=='true' and tuple(map(int,re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',n.get('bounds')).groups()))[3]<=self.navigation_top and tuple(map(int,re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',n.get('bounds')).groups()))[3]-tuple(map(int,re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',n.get('bounds')).groups()))[1]>=100]
    if len(clickable)==1:return clickable[0]
    if not any(n.get('clickable')=='true' for n in matches) and len(matches)==1:return matches[0]
    views=[n for n in nodes if n.get('class')=='android.widget.ScrollView' and self.visible(n)]
    if not views:time.sleep(.2);continue
    assert len(views)==1,'Native settings scroll container is ambiguous'
    x1,y1,x2,y2=map(int,re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',views[0].get('bounds')).groups());high=y1+(y2-y1)//4;low=y1+(y2-y1)*4//5;x=(x1+x2)//2
    args=['swipe',str(x),str(low if direction=='up' else high),str(x),str(high if direction=='up' else low),'500'];self.report['inputs'].append({'control':'observed central Settings scroll','input':args});self.adb('shell','input',*args);time.sleep(.2)
  raise AssertionError('Native Settings control unavailable: '+label)
 def protected_baseline(self):
  self.find('empty-open-napplet');self.empty_baseline=True;self.tap('shell-settings')
  try:self.find('settings-full-npub',timeout=6)
  except Exception:
   self.capture('cold-first-settings-miss');self.report['coldFirstSettingsMiss']=True;self.tap('shell-settings');self.find('settings-full-npub')
  assert self.find('settings-full-npub').get('text')==EXPECTED_NPUB;self.report['selectedDevelopmentNpub']=EXPECTED_NPUB;self.capture('real-owner-empty-workspace-baseline');self.tap('settings-done')
  self.tap('qa-check-config-empty');self.find('Exact configuration samples initially absent.');self.samples_absent=True;self.report['exactConfigurationScopesInitiallyAbsent']=True
 def cleanup(self):
  if PACKAGE!='org.nostrocket.hypergolic.emptyacceptance' or not self.empty_baseline:return
  # Original workspace was empty. Close only the observed signed configuration samples.
  for _ in range(8):
   nodes=self.nodes()
   if any(n.get('resource-id')=='configuration-settings' for n in nodes):self.adb('shell','input','keyevent','4');continue
   if any(n.get('resource-id')=='settings-done' and self.visible(n) for n in nodes):self.tap('settings-done');continue
   if any(n.get('resource-id')=='close-confirm' and self.visible(n) for n in nodes):self.tap('close-confirm');continue
   if any(n.get('resource-id')=='empty-open-napplet' and self.visible(n) for n in nodes):break
   closers=[n for n in nodes if n.get('resource-id','').startswith('overview-close-') and self.visible(n)]
   if not closers and any(n.get('resource-id')=='focused-napplet-name' and n.get('text')=='signed-config-caller-lab' for n in nodes):self.tap('handle-right');self.find('napplet-overview');continue
   assert 1<=len(closers)<=2,'Refuse cleanup of unknown workspace'
   self.report.setdefault('closedOwnedViews',[]).append(closers[0].get('resource-id').removeprefix('overview-close-'));self.tap(closers[0].get('resource-id'));self.find('close-confirm');self.tap('close-confirm')
  self.find('empty-open-napplet');assert not any(n.get('resource-id','').startswith('overview-card-') for n in self.nodes());self.report['emptyWorkspaceRestored']=True
  if self.samples_absent:
   self.tap('qa-clean-config-samples');self.find('Exact configuration samples erased.');self.tap('qa-check-config-empty');self.find('Exact configuration samples initially absent.');self.report['exactOwnedConfigurationScopesErased']=True
  self.tap('shell-settings');assert self.find('settings-full-npub').get('text')==EXPECTED_NPUB;self.capture('real-owner-final-identity');self.tap('settings-done');self.capture('real-owner-final-empty-workspace')
 def instance(self):
  rows=[n.get('resource-id') for n in self.nodes() if n.get('resource-id','').startswith('runtime-status-') and self.visible(n)]
  assert len(rows)==1;return rows[0].removeprefix('runtime-status-')
 def focus_instance(self,id):
  self.tap('handle-right');self.find('napplet-overview');self.find('overview-card-'+id);self.tap('overview-card-'+id);self.find('SDK ready for routing.');assert self.instance()==id
 def editor_source(self,role):
  self.settings_find('Napplet configuration');self.settings_find(npub(by_role[role]['event']['pubkey']));self.settings_find('Version: '+version(role));self.capture('trusted-source-'+role)
 def run(self):
  self.report.update(kind='hypergolic-physical-config-namespace-v1',section=self.args.section,scope=('Physical Android ordinary protected owner and native configuration with a test-only signed local transport. Real vault and identity owner preserved; no external relay/HTTPS publication or iOS claim.' if PACKAGE=='org.nostrocket.hypergolic.emptyacceptance' else 'Physical Android signed-local SDK/native configuration with isolated public-only identities; no protected identity, external publication or iOS claim.'),fixtureEvents={role:by_role[role]['event']['id'] for role in ['config-caller','config-collision','config-incompatible-update']},fixtureVersions={role:version(role) for role in ['config-caller','config-collision','config-incompatible-update']},observerSha256=sha(Path(__file__).read_bytes()))
  build=json.loads(self.args.build.read_text());assert build['status']=='built' and build['sourceAfter']==sources()
  actual=self.adb('exec-out','cat',self.adb('shell','pm','path',PACKAGE).removeprefix('package:'),binary=True);assert sha(actual)==sha(self.args.apk.read_bytes())==build['productSha256'];self.report['installedApkSha256']=sha(actual)
  self.launch();
  if PACKAGE=='org.nostrocket.hypergolic.emptyacceptance':self.protected_baseline()
  self.open_role('config-caller','config');self.register();assert self.get()==DEFAULTS
  original=self.instance();self.report['originalInstance']=original
  self.guest('Open configuration settings');self.editor_source('config-caller');self.settings_tap('config-choice-theme-1');self.edit('config-field-count','8');self.edit('config-secret-token',OLD_TOKEN);self.settings_tap('config-save')
  old={**DEFAULTS,'theme':'light','count':8,'token':OLD_TOKEN};assert self.get()==old;self.capture('original-public-config-values');
  if self.args.section!='updates':self.check('physical-source-version-attributed-original-save')
  else:self.report['updatePreparationExactOldValues']=old
  if self.args.section!='updates':
   self.open_role('config-collision','config');self.register();assert self.get()==DEFAULTS;collision=self.instance();assert collision!=original;self.report['collisionInstance']=collision;self.check('physical-same-app-hash-different-publisher-starts-defaults')
   self.guest('Open configuration settings');self.editor_source('config-collision');self.edit('config-field-count','5');self.edit('config-secret-token',COLLISION_TOKEN);self.settings_tap('config-save');other={**DEFAULTS,'count':5,'token':COLLISION_TOKEN};assert self.get()==other;self.capture('collision-public-config-values');self.check('physical-second-publisher-separate-save')
   self.focus_instance(original);assert self.get()==old;self.capture('original-config-after-collision-save');self.check('physical-second-publisher-write-does-not-change-original')
   self.focus_instance(collision);assert self.get()==other;self.check('physical-original-read-does-not-change-other-publisher')
   self.tap('handle-right');self.find('napplet-overview');self.tap('overview-close-'+collision);self.find('close-confirm');self.tap('close-confirm');self.find('napplet-overview');assert not any(n.get('resource-id')=='overview-card-'+collision for n in self.nodes());self.tap('overview-card-'+original);self.find('SDK ready for routing.');assert self.instance()==original
  if self.args.section=='publishers':
   self.report['sourceAfter']=sources();assert self.report['sourceAfter']==self.report['sourceBefore'];self.report['status']='passed';return
  self.tap('qa-offer-config-incompatible-update');self.find('Incompatible update offered.');self.tap('shell-settings');self.update_check();self.settings_find('Use this verified update?');self.settings_find(by_role['config-incompatible-update']['event']['id']);self.capture('incompatible-signed-update-review');self.settings_tap('Keep current version');self.tap('settings-done');assert self.instance()==original and self.get()==old;self.check('physical-declined-incompatible-update-retains-instance-and-values')
  self.tap('shell-settings');self.update_check();self.settings_find('Use this verified update?');self.settings_tap('Close and use update');self.find('SDK ready for routing.');fresh=self.instance();assert fresh!=original;self.report['updatedInstance']=fresh;self.register()
  new={**DEFAULTS,'count':'fresh-version'};assert self.get()==new;self.capture('fresh-incompatible-version-defaults');self.check('physical-accepted-incompatible-hash-starts-fresh-string-no-old-token')
  self.guest('Open configuration settings');self.editor_source('config-incompatible-update');self.settings_tap('config-choice-count-1');self.settings_tap('config-choice-theme-1');self.settings_tap('config-save');saved={**new,'count':'other-version','theme':'light'};assert self.get()==saved;self.capture('new-string-schema-save');self.check('physical-new-schema-positive-write')
  old_pid=self.adb('shell','pidof',PACKAGE);self.launch();new_pid=self.adb('shell','pidof',PACKAGE);assert old_pid and new_pid and old_pid!=new_pid;self.find('SDK ready for routing.');self.register();assert self.get()==saved;self.capture('cold-new-version-pinned-readback');self.report['coldRestartPids']={'old':old_pid,'new':new_pid};self.check('physical-cold-restored-exact-new-version-values')
  self.report['sourceAfter']=sources();assert self.report['sourceAfter']==self.report['sourceBefore'];self.report['status']='passed';print(json.dumps({'status':'passed','checks':self.report['checks']}),flush=True)
if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--serial',required=True);p.add_argument('--section',choices=['all','publishers','updates'],default='all');p.add_argument('--package',choices=['org.nostrocket.hypergolic.presentationfixture','org.nostrocket.hypergolic.emptyacceptance'],default=PACKAGE)
 for name in ['build','apk','output']:p.add_argument('--'+name,type=Path,required=True)
 args=p.parse_args();PACKAGE=args.package
 for module in [base,base.config,base.config.base,base.config.base.ui,base.config.base.routing,base.config.base.routing.ui]:module.PACKAGE=PACKAGE
 j=Journey(args)
 try:j.run()
 except Exception as error:
  j.report.update(status='failed',error=str(error))
  try:j.capture('failure')
  except Exception:pass
  raise
 finally:
  try:j.cleanup()
  except Exception as error:
   j.report.update(status='failed',cleanupError=str(error))
   try:j.capture('cleanup-failure')
   except Exception:pass
  (args.output/'result.json').write_text(json.dumps(j.report,indent=2)+'\n')
 assert j.report['status']=='passed'
