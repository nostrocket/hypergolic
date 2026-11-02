#!/usr/bin/env python3
"""Observed Android SDK/profile, cold SQLite recovery, controlled offline and native revocation."""
import argparse,importlib.util,json,re,time
from pathlib import Path
from evidence import ROOT,sha,sources
spec=importlib.util.spec_from_file_location('native_ui',ROOT/'tests/native/upload/android-upload.py');ui=importlib.util.module_from_spec(spec);spec.loader.exec_module(ui)
PACKAGE='org.nostrocket.hypergolic.identityfixture';ui.PACKAGE=PACKAGE;ui.sources=sources
class Journey(ui.Journey):
 def run(self):
  self.report.update(kind='hypergolic-android-public-identity-v1',scope=__doc__)
  sample=json.loads(self.args.sample.read_text());build=json.loads(self.args.build.read_text());assert build['status']=='built' and build['sourceAfter']==sources()
  self.report['sampleSha256']=sha(self.args.sample.read_bytes());self.report['buildSha256']=sha(self.args.build.read_bytes())
  installed=self.adb('shell','pm','path',PACKAGE).splitlines();assert len(installed)==1
  actual=self.adb('exec-out','cat',installed[0].removeprefix('package:'),binary=True);assert sha(actual)==sha(self.args.apk.read_bytes())==build['productSha256'];self.report['installedApkSha256']=sha(actual)
  self.report['webView']=self.adb('shell','dumpsys','webviewupdate')
  def launch():
   self.adb('shell','am','force-stop',PACKAGE);self.adb('shell','am','start','-W','-n',PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity');self.find('Native profile host connected');self.find('Identity connected')
  def receipt(attempts,frames,reply,cancelled=0):
   self.find(f'Profile receipt: attempts {attempts}; frames {frames}; cancelled {cancelled}; reply {reply}')
  def result(expected):
   deadline=time.monotonic()+15
   while time.monotonic()<deadline:
    values=[]
    for node in self.nodes():
     text=node.get('text','')
     if text.startswith('{') or text=='null':
      try:values.append(json.loads(text))
      except ValueError:pass
    if expected in values:return
    self.guest_scroll('up')
   raise RuntimeError('Original SDK profile differs from independently verified source')
  launch();self.tap('Read profile');self.find('Profile read complete.');result(sample['profile']);receipt(1,0,'success');self.check('actual-wss-profile');self.capture('profile-live')
  launch();self.tap('Read profile');self.find('Profile read complete.');result(sample['profile']);receipt(0,0,'success');self.check('cold-sqlite-cache');self.capture('profile-cold-cache')
  self.tap('Close Profile Lab');assert not any(n.get('class')=='android.webkit.WebView' for n in self.nodes());self.tap('Open Profile Lab');self.find('Identity connected');self.tap('Read profile');self.find('Profile read complete.');result(sample['profile']);receipt(0,0,'success');self.check('close-reopen-cache')
  self.tap('Next profile case');self.find('Profile case: offline');self.find('Identity connected');self.tap('Read profile');self.find('Profile read complete.');result(sample['profile']);receipt(1,0,'success');self.check('older-cache-controlled-offline');self.capture('profile-offline')
  self.tap('Next profile case');self.find('Profile case: empty');self.find('Identity connected');self.tap('Read profile');self.find('No public profile found.');result(None);receipt(1,1,'success');self.check('controlled-empty-eose');self.capture('profile-empty')
  self.tap('Next profile case');self.find('Profile case: uncached');self.find('Identity connected');self.tap('Read profile');self.find('Profile read failed: identity data unavailable');receipt(1,0,'error');self.check('uncached-other-user-offline-error');self.capture('profile-uncached')
  self.tap('Next profile case');self.find('Profile case: revoked');self.find('Identity connected');self.tap('Read profile');receipt(1,1,'denied',1);assert not any(n.get('class')=='android.webkit.WebView' for n in self.nodes());self.check('pending-owner-native-revocation');self.capture('profile-revoked')
  self.tap('Next profile case');self.find('Profile case: owner-epoch');self.find('Identity connected');self.tap('Read profile');receipt(1,1,'denied',1);self.find('Profile read failed: identity request denied');assert not any(n.get('text')=='Profile read complete.' for n in self.nodes());self.check('pending-trusted-identity-epoch-revocation');self.capture('profile-owner-epoch')
  self.tap('Next profile case');self.find('Profile case: tampered');self.find('Identity connected');self.tap('Read profile');self.find('Profile read failed: invalid identity data');receipt(0,0,'error');self.check('native-disk-signature-reverification');self.capture('profile-tampered')
  self.report['sourceAfter']=sources();assert self.report['sourceBefore']==self.report['sourceAfter'];self.report['status']='passed'
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--serial',required=True)
for name in ['sample','build','apk','output']:p.add_argument('--'+name,type=Path,required=True)
a=p.parse_args();j=Journey(a)
try:j.run()
except Exception as error:j.report.update(status='failed',error=str(error));raise
finally:(a.output/'result.json').write_text(json.dumps(j.report,indent=2)+'\n')
