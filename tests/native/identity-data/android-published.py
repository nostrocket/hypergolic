#!/usr/bin/env python3
"""Normal signed State/Feed admission and selected identity/cache decisions; diagnostic frames."""
import argparse,importlib.util,json,re,time
from pathlib import Path
from evidence import ROOT,sha,sources
spec=importlib.util.spec_from_file_location('native_ui',ROOT/'tests/native/upload/android-upload.py');ui=importlib.util.module_from_spec(spec);spec.loader.exec_module(ui)
PACKAGE='org.nostrocket.hypergolic.identitypublishedfixture';ui.PACKAGE=PACKAGE;ui.sources=sources
class Journey(ui.Journey):
 def stats(self):
  pattern=r'Identity request count: (\d+); query calls (\d+); frames (\d+); artifact queries (\d+)'
  values=[re.fullmatch(pattern,n.get('text','')) for n in self.nodes()];rows=[tuple(map(int,value.groups())) for value in values if value];assert len(rows)==1;return rows[0]
 def settings_find(self,label):
  for direction in ['up','down']:
   for _ in range(20):
    nodes=self.nodes();matches=[n for n in nodes if label in (n.get('text'),n.get('content-desc'),n.get('resource-id')) and self.visible(n)]
    if len(matches)==1:return matches[0]
    views=[n for n in nodes if n.get('class')=='android.widget.ScrollView' and self.visible(n)];assert len(views)==1
    x1,y1,x2,y2=map(int,re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',views[0].get('bounds')).groups());high=y1+int((y2-y1)*.25);low=y1+int((y2-y1)*.8)
    args=['swipe',str((x1+x2)//2),str(low if direction=='up' else high),str((x1+x2)//2),str(high if direction=='up' else low),'400'];self.report['inputs'].append({'control':'observed Settings scroll','input':args});self.adb('shell','input',*args);time.sleep(.2)
  raise AssertionError('Settings control not exposed: '+label)
 def settings_tap(self,label):self.settings_find(label);self.tap(label)
 def guest_find(self,label):
  for direction in ['up','down']:
   for _ in range(16):
    nodes=self.nodes();views=[n for n in nodes if n.get('class')=='android.webkit.WebView' and n.get('text')=='Hypergolic runtime' and self.visible(n)];assert len(views)==1
    a,b,c,d=map(int,re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',views[0].get('bounds')).groups())
    def matches(rows):
     result=[]
     for n in rows:
      if label not in (n.get('text'),n.get('content-desc'),n.get('resource-id')) or not self.visible(n):continue
      x1,y1,x2,y2=map(int,re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',n.get('bounds')).groups())
      if a<=(x1+x2)//2<c and b<=(y1+y2)//2<d:result.append(n)
     return result
    first=matches(nodes)
    if first:
     time.sleep(.2);second=matches(self.nodes())
     if any(x.get('bounds')==y.get('bounds') for x in first for y in second):return
    self.guest_scroll(direction);time.sleep(.2)
  raise AssertionError('Settled guest control not exposed: '+label)
 def guest(self,label):self.baseline=self.stats();self.guest_find(label);self.tap(label)
 def delivered(self):
  deadline=time.monotonic()+15
  while time.monotonic()<deadline:
   value=self.stats()
   if value[0]==self.baseline[0]+1:return value
   time.sleep(.1)
  raise AssertionError('New SDK request did not finish')
 def result(self,expected):
  for _ in range(20):
   for node in self.nodes():
    try:value=json.loads(node.get('text',''))
    except ValueError:continue
    if value==expected:self.delivered();self.report.setdefault('originalSDKResults',[]).append(value);return
   self.guest_scroll('up')
  raise AssertionError('Original SDK result differs from independent signed fixture')
 def run(self):
  self.report.update(kind='hypergolic-android-identity-published-v1',scope=__doc__)
  build=json.loads(self.args.build.read_text());assert build['status']=='built' and build['suite']=='published' and build['sourceAfter']==sources()
  path=self.adb('shell','pm','path',PACKAGE).removeprefix('package:');actual=self.adb('exec-out','cat',path,binary=True);assert sha(actual)==sha(self.args.apk.read_bytes())==build['productSha256'];self.report['installedApkSha256']=sha(actual)
  fixture=json.loads((ROOT/'tests/native/identity-data/public-list-fixture.json').read_text());expected=fixture['expected']
  def launch():self.adb('shell','am','force-stop',PACKAGE);self.adb('shell','am','start','-W','-n',PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity');self.find('signed-state-address')
  def review(allow):self.find('Allow public list access?');self.find('Publisher');assert not any(n.get('text')=='Reviewed bundled fixture' for n in self.nodes());self.capture('list-review-'+str(len(self.report['checks'])));self.tap('Allow public lists' if allow else 'Decline public lists')
  def success(label,kind,wanted):self.guest(label);self.guest_find('Public '+kind+' read complete.');self.result(wanted)
  def error():self.guest_find('Public mutes read failed: identity request denied');self.delivered()
  def open_signed(role,reject=False):
   address=self.find('signed-'+role+'-address').get('content-desc');assert address.startswith('naddr1');self.tap('shell-settings');self.settings_tap('settings-napplet-address');self.adb('shell','input','text',address);self.adb('shell','input','keyevent','4');self.settings_tap('settings-open-napplet');self.settings_find('Allow this napplet?');self.settings_find('Requested access: identity, '+('storage' if role=='state' else 'relay'));self.capture(role+'-domain-consent')
   if reject:
    self.settings_tap('settings-napplet-reject');self.settings_tap('settings-open-napplet');self.settings_find('Allow this napplet?')
   self.settings_tap('settings-napplet-approve');self.find('Identity connected' if role=='state' else 'Ready to query.');self.capture(role+'-admitted');self.check('signed-'+role+'-normal-admission')
   if reject:assert self.stats()[1:3]==(0,0);self.check('domain-consent-decline-no-identity-query')
  self.adb('shell','pm','clear',PACKAGE);launch();open_signed('state',True)
  success('Read follows','follows',expected['follows']);self.check('signed-state-selected-follows')
  self.guest('Read mutes');review(False);error();self.check('separate-list-decline')
  self.guest('Read mutes');review(True);self.guest_find('Public mutes read complete.');self.result(expected['mutes']);self.check('separate-list-approval-exact-source')
  success('Read selected list','list',expected['bookmarks']);self.check('remembered-same-app-list-access')
  self.tap('Use controlled offline cache');launch();self.find('Identity connected');assert self.stats()[1:3]==(0,0)
  success('Read mutes','mutes',expected['mutes']);assert self.stats()[1:]==(1,0,0);self.check('cold-signed-grant-and-older-offline-cache');self.capture('cold-offline-cache')
  self.tap('Use online diagnostic frames');success('Read mutes','mutes',expected['mutes']);assert self.stats()[2]==1;self.check('stale-cache-bounded-refresh')
  self.tap('shell-settings');self.settings_tap('Revoke public lists for signed-identity-state-lab');self.settings_find('No remembered public list access.');self.capture('normal-settings-revocation');self.tap('settings-done')
  self.guest('Read mutes');review(False);error();self.check('normal-settings-revoke-blocks-cache')
  self.guest('Read mutes');review(True);self.guest_find('Public mutes read complete.');self.result(expected['mutes'])
  self.tap('shell-settings');self.settings_tap('identity-select-'+fixture['other']);self.settings_find('Switch identity?');self.settings_tap('identity-change-confirm');self.find('Open this napplet?');self.find('Access: identity, storage');self.capture('new-user-domain-consent');self.tap('Allow and open');self.find('Identity connected')
  self.guest('Read mutes');review(False);error();self.check('normal-confirmed-identity-isolates-permission');success('Read follows','follows',[]);self.check('normal-confirmed-identity-isolates-source');self.capture('new-identity-empty-follows')
  self.tap('shell-settings');self.settings_tap('identity-select-'+fixture['user']);self.settings_tap('identity-change-confirm');self.find('Identity connected');success('Read mutes','mutes',expected['mutes']);self.check('return-to-identity-restores-own-permission')
  open_signed('feed');before=self.stats();self.guest('Read follows');self.guest_find('Follows read complete.');self.result(expected['follows']);assert self.stats()[1:3]==(before[1]+1,before[2]+1);self.check('signed-feed-explicit-follows-no-routing-change');self.capture('signed-feed-follows')
  self.report['sourceAfter']=sources();assert self.report['sourceBefore']==self.report['sourceAfter'];self.report['status']='passed'
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--serial',required=True)
for name in ['build','apk','output']:p.add_argument('--'+name,type=Path,required=True)
a=p.parse_args();j=Journey(a)
try:j.run()
except Exception as error:
 j.report.update(status='failed',error=str(error))
 try:j.capture('failure')
 except Exception:pass
 raise
finally:(a.output/'result.json').write_text(json.dumps(j.report,indent=2)+'\n')
