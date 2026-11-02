#!/usr/bin/env python3
"""Actual normal signed local Resource Lab admission, per-opening approval and public identity continuity."""
import argparse,importlib.util,json,re,time
from pathlib import Path
from evidence import ROOT,sha,sources
spec=importlib.util.spec_from_file_location('native_ui',ROOT/'tests/native/upload/android-upload.py');ui=importlib.util.module_from_spec(spec);spec.loader.exec_module(ui)
PACKAGE='org.nostrocket.hypergolic.linkpublishedfixture';ui.PACKAGE=PACKAGE;ui.sources=sources
class Journey(ui.Journey):
 def guest_find(self,label):
  # Wait for the actual guest accessibility subtree before scrolling; readiness can precede its publication.
  deadline=time.monotonic()+15
  while time.monotonic()<deadline:
   nodes=self.nodes()
   if any(n.get('resource-id')=='link-url' or n.get('text')=='Resource Lab' for n in nodes):break
   if any(label in (n.get('text'),n.get('content-desc'),n.get('resource-id')) and self.visible(n) for n in nodes):return
   time.sleep(.2)
  for direction in ['up','down']:
   for _ in range(20):
    if any(label in (n.get('text'),n.get('content-desc'),n.get('resource-id')) and self.visible(n) for n in self.nodes()):return
    self.guest_scroll(direction)
  raise AssertionError('Guest control not exposed: '+label)
 def settings_find(self,label):
  for direction in ['up','down']:
   for _ in range(20):
    nodes=self.nodes();matches=[n for n in nodes if label in (n.get('text'),n.get('content-desc'),n.get('resource-id')) and self.visible(n)]
    if len(matches)==1:return matches[0]
    views=[n for n in nodes if n.get('class')=='android.widget.ScrollView' and self.visible(n)];assert len(views)==1
    x1,y1,x2,y2=map(int,re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',views[0].get('bounds')).groups());high=y1+int((y2-y1)*.25);low=y1+int((y2-y1)*.8)
    args=['swipe',str((x1+x2)//2),str(low if direction=='up' else high),str((x1+x2)//2),str(high if direction=='up' else low),'400'];self.report['inputs'].append({'control':'observed Settings scroll','input':args});self.adb('shell','input',*args)
  raise AssertionError('Settings control unavailable: '+label)
 def settings_tap(self,label):self.settings_find(label);self.tap(label)
 def enter_address(self,address):
  self.settings_tap('settings-napplet-address');time.sleep(.5)
  self.adb('shell','input','keycombination','113','29');self.adb('shell','input','keyevent','67')
  for offset in range(0,len(address),12):
   chunk=address[offset:offset+12];self.adb('shell','input','text',chunk);time.sleep(.2)
   actual=self.settings_find('settings-napplet-address').get('text');assert actual==address[:offset+12],'Native address input lost characters'
  self.adb('shell','input','keyevent','4');actual=self.settings_find('settings-napplet-address').get('text');assert actual==address
  self.report.setdefault('enteredAddresses',[]).append(actual);self.capture('complete-native-address-'+str(len(self.report['enteredAddresses'])))
 def guest(self,label):self.guest_find(label);self.tap(label)
 def absent(self):assert not any(n.get('text')=='Open external link?' for n in self.nodes())
 def receipt(self,status):
  self.guest_find('link-result');value=json.loads(self.find('link-result').get('text'));assert value=={'status':status};self.report.setdefault('originalSDKResults',[]).append(value)
 def run(self):
  self.report.update(kind='hypergolic-android-link-published-v1',scope=__doc__)
  build=json.loads(self.args.build.read_text());assert build['status']=='built' and build['suite']=='published' and build['sourceAfter']==sources()
  actual=self.adb('exec-out','cat',self.adb('shell','pm','path',PACKAGE).removeprefix('package:'),binary=True);assert sha(actual)==sha(self.args.apk.read_bytes())==build['productSha256'];self.report['installedApkSha256']=sha(actual)
  publisher='c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'
  def launch():self.adb('shell','am','force-stop',PACKAGE);self.adb('shell','am','start','-W','-n',PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity');self.find('signed-link-address')
  def admitted():self.guest_find('Open external link');self.find('Ready to request a link.');self.absent()
  def review():
   self.guest('Open external link');self.find('Open external link?');text='\n'.join(n.get('text','') for n in self.nodes());assert 'Napplet: signed-resource-link-lab' in text and 'Publisher: '+publisher in text and 'https://example.com/?hypergolic=link-tracer' in text and 'Unsigned embedded' not in text and 'Read external page' not in text;self.capture('signed-review-'+str(len(self.report['checks'])))
  def cancel():self.tap('CANCEL');self.find('Link opening denied.');self.receipt('denied');self.absent()
  def open_signed(role,reject=False):
   address=self.find('signed-'+role+'-address').get('content-desc');assert address.startswith('naddr1');self.tap('shell-settings');self.enter_address(address);self.settings_tap('settings-open-napplet');self.settings_find('Allow this napplet?');self.settings_find('Requested access: '+('link, resource' if role=='link' else 'resource'));self.capture(role+'-domain-consent')
   if reject:
    self.settings_tap('settings-napplet-reject');assert not any(n.get('class')=='android.webkit.WebView' for n in self.nodes());self.absent();self.check('domain-consent-decline-no-host');self.settings_tap('settings-open-napplet');self.settings_find('Allow this napplet?')
   self.settings_tap('settings-napplet-approve');admitted()
  self.adb('shell','pm','clear',PACKAGE);launch();open_signed('link',True);self.capture('signed-normal-admission');self.check('signed-resource-normal-admission')
  review();cancel();self.check('signed-native-cancel')
  review();self.tap('OPEN ONCE');deadline=time.monotonic()+15
  while time.monotonic()<deadline:
   top=self.adb('shell','dumpsys','activity','activities')
   if any('ResumedActivity' in line and PACKAGE not in line for line in top.splitlines()):break
   time.sleep(.2)
  else:raise AssertionError('Normal OS handler never foregrounded')
  (self.args.output/'signed-os-handler-activity.txt').write_text(top);(self.args.output/'signed-os-handler.png').write_bytes(self.adb('exec-out','screencap','-p',binary=True));self.adb('shell','am','start','-n',PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity');self.find('Link handed to your device.');self.receipt('opened');self.capture('signed-os-return');self.check('signed-actual-os-handoff-return')
  review();cancel();self.check('each-opening-needs-new-review')
  launch();admitted();self.capture('cold-signed-admission');review();cancel();self.check('cold-grant-retained-new-review-required')
  self.tap('shell-settings');self.settings_tap('identity-select-'+publisher);self.settings_find('Switch identity?');self.settings_tap('identity-change-confirm');self.find('Open this napplet?');self.find('Access: link, resource');self.capture('new-identity-domain-consent');self.tap('Allow and open');admitted();review();cancel();self.check('normal-confirmed-identity-fresh-review')
  open_signed('no-link');self.guest('Open external link');self.find('Link request unavailable.');self.absent();self.capture('signed-no-link-domain');self.check('missing-link-domain-cannot-open')
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
