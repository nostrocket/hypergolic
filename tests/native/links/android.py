#!/usr/bin/env python3
"""Actual SDK/native review and Android OS handler handoff, with preserved input and UI evidence."""
import argparse,importlib.util,json,os,re,subprocess,time
from pathlib import Path
from evidence import ROOT,sha,sources
spec=importlib.util.spec_from_file_location('upload_input',ROOT/'tests/native/upload/android-upload.py')
base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
PACKAGE='org.nostrocket.hypergolic.linkfixture';base.PACKAGE=PACKAGE
class Journey(base.Journey):
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
 def receipt(self,expected):
  self.guest_find('link-result');value=json.loads(self.find('link-result').get('text'));assert value==expected
  self.report.setdefault('originalSDKResults',[]).append(value)
 def fresh(self):
  # Independent lifecycle cases start from a fresh process; close/reopen itself is exercised inside its case.
  # API36 WebView virtual accessibility nodes disappear after several remounts in this automation session.
  self.adb('shell','am','force-stop',PACKAGE)
  self.adb('shell','am','start','-W','-n',PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity')
  self.find('Native link host connected')
 def opening(self):
  self.guest_find('Open external link');self.tap('Open external link');self.find('Open external link?')
 def absent(self):assert not any(n.get('text') == 'Open external link?' for n in self.nodes())
 def denied(self):self.find('Link opening denied.');self.receipt({'status':'denied'});self.absent()
 def matrix(self):
  self.fresh();self.guest_find('Open external link');self.tap('Hide in six seconds');self.opening();self.capture('matrix-before-blur');self.find('Link fixture hidden');self.absent();self.tap('Show Resource Lab');self.denied();self.capture('matrix-blur-denied');self.check('pending-blur-revoked')
  self.fresh();self.opening();self.capture('matrix-before-background');self.adb('shell','input','keyevent','KEYCODE_HOME')
  (self.args.output/'matrix-background.png').write_bytes(self.adb('exec-out','screencap','-p',binary=True))
  self.adb('shell','am','start','-W','-n',PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity');self.denied();self.capture('matrix-background-denied');self.check('pending-background-revoked')
  self.fresh();self.guest_find('Open external link');self.tap('Close in six seconds');self.opening();self.find('Link fixture closed');self.absent();assert not any(n.get('class') == 'android.webkit.WebView' for n in self.nodes());self.tap('Open Resource Lab');self.find('Native link host connected');self.capture('matrix-close-new-recipient');assert not any(n.get('text') in ['Link handed to your device.','Link opening denied.'] for n in self.nodes());self.check('pending-close-revoked')
  for control,status,name in [('Change identity in six seconds','Link identity changed','pending-identity-revoked'),('Pause owner in six seconds','Link owner paused','pending-owner-pause-revoked')]:
   self.fresh();self.guest_find('Open external link');self.tap(control);self.opening();self.find(status);self.absent();self.capture('matrix-'+name);assert not any(n.get('text') in ['Link handed to your device.','Link opening denied.'] for n in self.nodes());self.check(name)
   self.fresh();self.opening();self.tap('CANCEL');self.denied()
  self.fresh();start=time.monotonic();self.opening();self.capture('matrix-timeout-review');self.find('Link opening denied.',timeout=35);assert time.monotonic()-start >= 23;self.denied();self.capture('matrix-timeout-denied');self.check('pending-timeout-revoked')
  self.fresh();self.guest_find('Request four links');self.tap('Request four links');self.find('Open external link?');assert sum(n.get('text')=='Open external link?' for n in self.nodes())==1;self.tap('CANCEL');self.find('Four link requests settled.');self.receipt([{'status':'denied'}]*4);self.absent();self.capture('matrix-single-review-flood');self.check('global-single-review-flood')
  self.fresh()
  for _ in range(3):self.opening();self.tap('CANCEL');self.denied()
  self.guest_find('Open external link');self.tap('Open external link');self.denied();self.capture('matrix-generation-rate-limit');self.check('generation-review-rate-limit')
  for raw in ['https://user@example.com/','nostr:npub1fixture','https://example.com:0']:
   self.fresh();self.guest_find('link-url');self.tap('link-url');self.adb('shell','input','keyevent','KEYCODE_MOVE_END');self.adb('shell','input','keycombination','113','29');self.adb('shell','input','text',raw);self.adb('shell','input','keyevent','KEYCODE_BACK');assert self.find('link-url').get('text')==raw;self.guest_find('Open external link');self.tap('Open external link');self.denied()
  self.capture('matrix-invalid-url-denied');self.check('native-invalid-url-profile')
  self.fresh();handlers=self.adb('shell','cmd','package','query-activities','--brief','-a','android.intent.action.VIEW','-c','android.intent.category.BROWSABLE','-d','https://example.com/');components=[line.strip() for line in handlers.splitlines() if '/' in line];assert components and all(line.startswith('com.android.chrome/') for line in components),handlers
  try:
   self.adb('shell','pm','disable-user','--user','0','com.android.chrome');empty=self.adb('shell','cmd','package','query-activities','--brief','-a','android.intent.action.VIEW','-c','android.intent.category.BROWSABLE','-d','https://example.com/');assert not any('/' in line for line in empty.splitlines()),empty
   self.opening();self.tap('OPEN ONCE');self.denied();self.capture('matrix-actual-no-handler');self.check('actual-os-no-handler-denied')
  finally:self.adb('shell','pm','enable','com.android.chrome')
 def run(self):
  self.report.update(kind='hypergolic-android-external-link-tracer-v1',scope='Actual public-only SDK/native review and Android normal HTTPS handler/return. No physical/protected or normal signed admission claim.')
  build=json.loads(self.args.build.read_text());assert build['status']=='built' and build['platform']=='android' and build['sourceAfter']==self.report['sourceBefore']
  assert sha(self.args.apk.read_bytes())==build['productSha256']
  package=self.adb('shell','pm','path',PACKAGE).removeprefix('package:');assert sha(self.adb('exec-out','cat',package,binary=True))==build['productSha256'];self.report['productSha256']=build['productSha256']
  self.adb('shell','am','force-stop',PACKAGE);self.adb('shell','am','start','-W','-n',PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity');self.find('Native link host connected')
  self.guest_find('Open external link');self.tap('Open external link');self.find('Open external link?')
  text='\n'.join(n.get('text','') for n in self.nodes());assert 'Napplet: resource-lab' in text and 'Unsigned embedded test napplet' in text and 'https://example.com/?hypergolic=link-tracer' in text and 'Read external page' not in text
  self.capture('link-trusted-review');self.tap('OPEN ONCE')
  deadline=time.monotonic()+15
  while time.monotonic()<deadline:
   top=self.adb('shell','dumpsys','activity','activities')
   if any('ResumedActivity' in line and PACKAGE not in line for line in top.splitlines()):break
   time.sleep(.2)
  else:raise AssertionError('No actual OS handler foreground')
  self.report['handlerActivity']=top;(self.args.output/'link-os-handler-activity.txt').write_text(top)
  (self.args.output/'link-os-handler.png').write_bytes(self.adb('exec-out','screencap','-p',binary=True))
  self.adb('shell','am','start','-n',PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity');self.find('Link handed to your device.');self.receipt({'status':'opened'});self.capture('link-return-original-sdk');self.check('actual-os-handoff-return')
  self.guest_find('Open external link');self.tap('Open external link');self.find('Open external link?');self.tap('CANCEL');self.find('Link opening denied.');self.receipt({'status':'denied'});self.capture('link-cancel-original-sdk');self.check('native-cancel')
  self.tap('Close Resource Lab');self.tap('Open Resource Lab');self.find('Native link host connected');self.guest_find('link-url');self.tap('link-url')
  self.adb('shell','input','keyevent','KEYCODE_MOVE_END');self.adb('shell','input','keycombination','113','29');self.adb('shell','input','text','http://example.com');self.adb('shell','input','keyevent','KEYCODE_BACK')
  self.guest_find('Open external link');self.tap('Open external link');self.find('Link opening denied.');self.receipt({'status':'denied'});assert not any(n.get('text')=='Open external link?' for n in self.nodes());self.capture('link-http-denied');self.check('unsupported-http')
  if self.args.matrix:self.matrix()
  assert sources()==self.report['sourceBefore'];self.report['sourceAfter']=sources();self.report['status']='passed'
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--serial',required=True);p.add_argument('--matrix',action='store_true')
for name in ['build','apk','output']:p.add_argument('--'+name,type=Path,required=True)
a=p.parse_args();j=Journey(a)
try:j.run()
except Exception as error:j.report.update(status='failed',error=str(error));raise
finally:(a.output/'result.json').write_text(json.dumps(j.report,indent=2)+'\n')
