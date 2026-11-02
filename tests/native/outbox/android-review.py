#!/usr/bin/env python3
"""Sealed native presentation/input proof; no signing or publication."""
import argparse,importlib.util,json,sys,xml.etree.ElementTree as ET
from pathlib import Path
from evidence import ROOT,sha,sources
spec=importlib.util.spec_from_file_location('query_input',ROOT/'tests/native/feed-query/android-query.py');base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
PACKAGE='org.nostrocket.hypergolic.outboxreviewfixture';base.PACKAGE=PACKAGE;base.sources=sources
class Journey(base.Journey):
 def up(self):
  scrolls=[n for n in self.nodes() if n.get('scrollable')=='true'];assert scrolls,'Native modal has no scroll container'
  bounds=list(map(int,base.re.findall(r'\d+',scrolls[-1].get('bounds',''))));x1,y1,x2,y2=bounds;x=(x1+x2)//2
  self.input('swipe',str(x),str(y1+(y2-y1)*4//5),str(x),str(y1+(y2-y1)//5),'400')
 def reveal(self,label):
  for _ in range(14):
   nodes=self.nodes();matches=[n for n in nodes if n.get('text')==label or n.get('content-desc')==label]
   visible=[n for n in matches if self.visible(n)]
   if visible:return visible[0]
   self.up()
  raise RuntimeError('Native review content absent: '+label)
 def visible(self,node):
  bounds=list(map(int,base.re.findall(r'\d+',node.get('bounds',''))))
  return len(bounds)==4 and bounds[2]>bounds[0] and bounds[3]>bounds[1]
 def record(self,name):
  base.time.sleep(.3)
  self.capture(name);self.check(name)
 def run(self):
  build=json.loads(self.args.build.read_text());assert build['status']=='built' and build['suite']=='review' and build['sourceAfter']==sources()
  installed=self.adb('shell','pm','path',PACKAGE).splitlines();assert len(installed)==1
  actual=self.adb('exec-out','cat',installed[0].removeprefix('package:'),binary=True);assert sha(actual)==build['productSha256']==sha(self.args.apk.read_bytes())
  self.result.update(kind='hypergolic-android-outbox-review-v1',scope=__doc__,installedApkSha256=sha(actual),buildSha256=sha(self.args.build.read_bytes()))
  self.adb('shell','am','force-stop',PACKAGE);self.adb('shell','am','start','-W','-n',PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity')
  self.find('Presentation only · no signing or publication');self.record('presentation-only-launch')
  self.tap(self.find('Review destinations'));self.find('Approve signing request');self.record('exact-event-identity')
  self.reveal('Publication destinations');self.record('exact-destinations-origins')
  self.reveal('Also send your existing relay list');self.record('existing-list-review')
  self.tap(self.reveal('Show exact event'));self.up();self.record('exact-primary-template')
  self.tap(self.find('Reject'));self.tap(self.find('Show successful primary'));self.find('Primary event accepted.');self.record('primary-success-independent-list')
  self.reveal('Existing relay list');self.record('separate-list-rejected-cancelled')
  self.tap(self.find('Close results'));self.tap(self.find('Show required inbox unknown'));self.find('publication result unknown');self.record('required-inbox-unknown-failure')
  self.tap(self.find('Close results'));self.adb('shell','am','force-stop',PACKAGE)
  self.result['sourceAfter']=sources();assert self.result['sourceAfter']==self.result['sourceBefore'];self.result['status']='passed'
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--serial',required=True);p.add_argument('--adb',default=str(ROOT/'.tools/android-sdk/platform-tools/adb'))
for name in ['apk','build','output']:p.add_argument('--'+name,type=Path,required=True)
j=Journey(p.parse_args())
try:j.run()
except Exception as error:j.result.update(status='failed',error=str(error));raise
finally:(j.out/'result.json').write_text(json.dumps(j.result,indent=2)+'\n')
