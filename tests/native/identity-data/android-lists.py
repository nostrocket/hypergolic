#!/usr/bin/env python3
"""Actual Android SDK/SQLite/trusted-list-review with explicitly diagnostic signed relay frames."""
import argparse,importlib.util,json,time,re
from pathlib import Path
from evidence import ROOT,sha,sources
spec=importlib.util.spec_from_file_location('native_ui',ROOT/'tests/native/upload/android-upload.py');ui=importlib.util.module_from_spec(spec);spec.loader.exec_module(ui)
PACKAGE='org.nostrocket.hypergolic.identitylistsfixture';ui.PACKAGE=PACKAGE;ui.sources=sources
class Journey(ui.Journey):
 def count(self):
  values=[re.fullmatch(r'Identity request count: (\d+)',node.get('text','')) for node in self.nodes()]
  found=[int(match[1]) for match in values if match];assert len(found)==1,'Native identity request count not observed';return found[0]
 def delivered(self):
  self.find('Identity request count: '+str(self.pending_count+1))
 def guest_find(self,label):
  for direction in ['up','down']:
   for _ in range(16):
    nodes=self.nodes();views=[node for node in nodes if node.get('class')=='android.webkit.WebView' and node.get('text')=='Hypergolic runtime' and self.visible(node)]
    assert len(views)==1,'Guest WebView not uniquely observed'
    a,b,c,d=map(int,re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',views[0].get('bounds')).groups())
    def candidates(rows):
     found=[]
     for node in rows:
      if label not in (node.get('text'),node.get('content-desc'),node.get('resource-id')) or not self.visible(node):continue
      x1,y1,x2,y2=map(int,re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',node.get('bounds')).groups())
      if a<=(x1+x2)//2<c and b<=(y1+y2)//2<d:found.append(node)
     return found
    first=candidates(nodes)
    if first:
     time.sleep(.2);second=candidates(self.nodes())
     if any(one.get('bounds')==two.get('bounds') for one in first for two in second):return
    self.guest_scroll(direction);time.sleep(.25)
  raise AssertionError('Settled guest control not exposed: '+label)
 def result(self,expected):
  for _ in range(20):
   for node in self.nodes():
    try:actual=json.loads(node.get('text',''))
    except ValueError:continue
    if actual==expected:self.delivered();self.report.setdefault('originalSDKResults',[]).append(actual);return
   self.guest_scroll('up')
  raise AssertionError('Original SDK value differs from signed public fixture')
 def guest(self,label):
  if label in ['Read relay preferences','Read follows','Read mutes','Read accepted badges','Read selected list','Check blocks support','Check zaps support']:self.pending_count=self.count()
  self.guest_find(label);self.tap(label)
 def success(self,label,kind,expected):
  self.guest(label);self.guest_find('Public '+kind+' read complete.');self.result(expected)
 def run(self):
  self.report.update(kind='hypergolic-android-identity-lists-v1',scope=__doc__)
  fixture=json.loads((ROOT/'tests/native/identity-data/public-list-fixture.json').read_text());expected=fixture['expected'];build=json.loads(self.args.build.read_text());assert build['status']=='built' and build['suite']=='lists' and build['sourceAfter']==sources()
  path=self.adb('shell','pm','path',PACKAGE).removeprefix('package:');actual=self.adb('exec-out','cat',path,binary=True);assert sha(actual)==sha(self.args.apk.read_bytes())==build['productSha256'];self.report['installedApkSha256']=sha(actual);self.report['buildSha256']=sha(self.args.build.read_bytes())
  self.adb('shell','pm','clear',PACKAGE)
  def launch():self.adb('shell','am','force-stop',PACKAGE);self.adb('shell','am','start','-W','-n',PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity');self.find('Native public lists connected');self.find('Identity connected')
  def next_case(name):self.tap('Next public lists case');self.find('Public lists case: '+name);self.find('Native public lists connected');self.find('Identity connected')
  def review(allow):
   self.find('Allow public list access?');self.find('Reviewed bundled fixture');self.find('Publisher namespace');self.capture('review-'+str(len(self.report['checks'])));self.tap('Allow public lists' if allow else 'Decline public lists')
  def error(kind,message):self.guest_find('Public '+kind+' read failed: '+message);self.delivered()
  def settings_revoke():
   self.tap('Public list Settings');self.find('Public list permissions');self.tap('Revoke public lists for state-lab');self.find('No remembered public list access.');self.capture('settings-revoked');self.tap('Close public list Settings')
  def category(name):self.guest('list-type');self.tap(name);self.find(name)
  launch()
  self.success('Read relay preferences','relays',expected['relays']);self.check('signed-relay-preferences-data-only');self.capture('relays')
  self.success('Read follows','follows',expected['follows']);self.check('signed-follows');self.capture('follows')
  self.guest('Read mutes');review(False);error('mutes','identity request denied');self.check('trusted-decline-no-list-data');self.capture('declined')
  self.guest('Read mutes');review(True);self.guest_find('Public mutes read complete.');self.result(expected['mutes']);self.check('trusted-approve-public-mutes');self.capture('mutes')
  self.success('Read selected list','list',expected['bookmarks']);self.check('global-bookmarks-public-references')
  category('Pins');self.success('Read selected list','list',expected['pins']);self.check('global-pins-exact-mapping')
  category('Interests');self.success('Read selected list','list',expected['interests']);self.check('global-interests-literal')
  category('Unsupported category');self.guest('Read selected list');error('list','identity list type unsupported');self.check('unknown-category-explicit-error')
  self.success('Read accepted badges','badges',expected['badges']);self.check('accepted-badge-exact-signed-join');self.capture('badges')
  self.guest('Check blocks support');error('blocked','identity block list unsupported');self.guest('Check zaps support');error('zaps','identity zaps deferred');self.check('unsupported-blocks-deferred-zaps')
  launch();self.success('Read mutes','mutes',expected['mutes']);self.find('Identity receipt: identity.getMutes; calls 0; frames 0; cancelled 0; reply success');self.check('cold-native-permission-and-cache')
  settings_revoke();self.guest('Read mutes');review(False);error('mutes','identity request denied');self.check('settings-revocation-blocks-fresh-cache')
  self.guest('Read mutes');review(True);self.guest_find('Public mutes read complete.');self.result(expected['mutes'])
  next_case('offline');self.success('Read mutes','mutes',expected['mutes']);self.find('Identity receipt: identity.getMutes; calls 1; frames 0; cancelled 0; reply success');self.check('older-validated-list-controlled-offline')
  next_case('other-app');self.guest('Read mutes');review(False);error('mutes','identity request denied');self.check('permission-app-isolation')
  next_case('other-publisher');self.guest('Read mutes');review(False);error('mutes','identity request denied');self.check('permission-publisher-isolation')
  next_case('other-user');self.guest('Read mutes');review(False);error('mutes','identity request denied');self.check('permission-account-isolation')
  next_case('bad-badge');self.guest('Read accepted badges');error('badges','accepted badge evidence unavailable');self.check('invalid-accepted-badge-no-cache-fallback');self.capture('badge-denied')
  next_case('bad-signature');self.guest('Read accepted badges');error('badges','identity data unavailable');self.check('invalid-native-frames-no-cache-fallback');self.capture('signature-denied')
  next_case('queued-regrant');self.guest('Read mutes');review(True);self.find('Queued native delivery after revoke and reapproval');error('mutes','identity request denied');self.check('native-queued-revoke-regrant-denial');self.capture('queued-native-denial')
  self.success('Read mutes','mutes',expected['mutes']);self.check('new-read-after-reapproval')
  next_case('owner-epoch');self.guest('Read follows');error('follows','identity request denied');self.check('pending-owner-epoch-denial');self.capture('owner-denied')
  next_case('background');self.guest('Read follows');self.find('Background identity query pending');self.adb('shell','input','keyevent','KEYCODE_HOME');time.sleep(2.5);self.adb('shell','am','start','-W','-n',PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity');error('follows','identity request denied');self.check('actual-background-pending-denial');self.capture('background-denied')
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
