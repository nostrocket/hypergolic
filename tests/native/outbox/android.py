#!/usr/bin/env python3
"""Native input, original SDK, installed bytes and independently captured routing evidence."""
import argparse,importlib.util,json,sys,time,xml.etree.ElementTree as ET
from pathlib import Path
from evidence import ROOT,sha,sources
spec=importlib.util.spec_from_file_location('query_input',ROOT/'tests/native/feed-query/android-query.py')
base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
base.PACKAGE='org.nostrocket.hypergolic.outboxfixture';base.sources=sources
PACKAGE=base.PACKAGE
class Journey(base.Journey):
 def nodes(self):
  self.adb('shell','uiautomator','dump','/data/local/tmp/hg-outbox.xml')
  self.xml=self.adb('exec-out','cat','/data/local/tmp/hg-outbox.xml',binary=True)
  nodes=list(ET.fromstring(self.xml).iter('node'))
  assert any(n.get('package')==PACKAGE for n in nodes),'Fixture is not foreground'
  return nodes
 def scroll_to(self,title):
  for _ in range(10):
   nodes=self.nodes();found=[n for n in nodes if n.get('text')==title]
   for n in found:
    b=base.re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',n.get('bounds',''))
    if b and int(b[4])>int(b[2]) and int(b[2])>=350:return n
   self.input('swipe','540','1800','540','650','450')
  raise RuntimeError('Control outside viewport: '+title)
 def field(self,name,value):
  for direction in ['up','down']:
   for _ in range(10):
    found=[n for n in self.nodes() if n.get('resource-id')==name]
    visible=[n for n in found if base.re.fullmatch(r'\[\d+,\d+\]\[\d+,\d+\]',n.get('bounds','')) and int(base.re.findall(r'\d+',n.get('bounds'))[3])-int(base.re.findall(r'\d+',n.get('bounds'))[1])>20]
    if visible:
     self.tap(visible[0]);self.nodes();self.input('keycombination','113','29');self.input('text',base.shlex.quote(value))
     assert any(n.get('resource-id')==name and n.get('text')==value for n in self.nodes()),'Exact native textarea input differs'
     self.input('keyevent','4');return
    self.input('swipe','540','650' if direction=='up' else '1800','540','1800' if direction=='up' else '650','350')
  raise RuntimeError('Native field absent: '+name)
 def filter(self,value):self.field('filters',value)
 def trace(self):
  for n in self.nodes():
   try:value=json.loads(n.get('text',''))
   except ValueError:continue
   if isinstance(value,dict) and 'calls' in value and 'plan' in value:return value
  raise RuntimeError('Native routing trace absent')
 def sdk(self,kind='outbox.query.result'):
  for _ in range(6):
   for n in self.nodes():
    try:value=json.loads(n.get('text',''))
    except ValueError:continue
    if isinstance(value,dict) and value.get('type')==kind:return value
   self.input('swipe','540','1800','540','900','350')
  raise RuntimeError('Original SDK result absent')
 def run(self):
  sample=json.loads(self.args.sample.read_text());build=json.loads(self.args.build.read_text())
  assert build['status']=='built' and build['sourceAfter']==sources()
  installed=self.adb('shell','pm','path',PACKAGE).splitlines();assert len(installed)==1
  actual=self.adb('exec-out','cat',installed[0].removeprefix('package:'),binary=True)
  assert sha(actual)==build['productSha256']==sha(self.args.apk.read_bytes())
  self.result.update(kind='hypergolic-android-outbox-query-v1',scope='Original SDK and native WSS routing using public-only isolated fixture; no signing or published admission claim.',installedApkSha256=sha(actual),buildSha256=sha(self.args.build.read_bytes()),sampleSha256=sha(self.args.sample.read_bytes()),originalSDKResults=[],nativeTraces=[])
  self.adb('shell','pm','clear',PACKAGE) # Disposable public fixture only; preserves the actual app and protected identities.
  for cold in [False,True]:
   self.adb('shell','am','force-stop',PACKAGE);self.adb('shell','am','start','-W','-n',PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity')
   self.find('Native Outbox host connected');self.find('Ready to query.')
   self.filter(json.dumps(sample['filter'],separators=(',',':')))
   self.tap(self.scroll_to('Query author outbox'))
   deadline=time.monotonic()+25
   while time.monotonic()<deadline:
    if any(n.get('text','').startswith('Outbox received 1 signed event') for n in self.nodes()):break
   else:raise RuntimeError('Matching native SDK event absent')
   trace=self.trace();sdk=self.sdk();assert len(sdk['events'])==1 and sdk['events'][0]['event']==sample['event'] and sdk['events'][0]['sidecar']['relayHints'] and set(sdk['events'][0]['sidecar']['relayHints'])<=set(sample['writeRelays']) and not sdk.get('error') and bool(sdk.get('incomplete'))==trace['incomplete']
   assert trace['plan']['relays']==sample['writeRelays'] and not trace['plan']['missingAuthors']
   data=[x['relay'] for x in trace['calls'] if x['role']=='data'];assert data==sample['writeRelays'] and sample['relay'] in data and not set(sample['network'])&set(data)
   lookups=[x['relay'] for x in trace['calls'] if x['role']=='discovery'];assert lookups==([] if cold else [sample['lookup']])
   assert trace['plan']['source']==('cache' if cold else 'nip65')
   name='cold-native-sqlite-routing' if cold else 'disjoint-native-wss-original-sdk'
   self.result['originalSDKResults'].append(sdk);self.result['nativeTraces'].append(trace);self.check(name);self.capture(name)
  for control,name in [('Without Outbox grant','native-missing-domain-no-transport'),('Mismatched owner','native-captured-owner-mismatch-no-transport')]:
   self.tap(self.find(control));self.find('Native Outbox host connected');self.find('Ready to query.')
   self.tap(self.scroll_to('Query author outbox'));self.find('Outbox failed: operation failed')
   assert any(n.get('text')=='{}' for n in self.nodes()),'Denied owner reached native data or discovery'
   self.check(name);self.capture(name)
  self.result['sourceAfter']=sources();assert self.result['sourceBefore']==self.result['sourceAfter'];self.result['status']='passed'
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--serial',required=True);p.add_argument('--adb',default=str(ROOT/'.tools/android-sdk/platform-tools/adb'))
for name in ['apk','build','sample','output']:p.add_argument('--'+name,type=Path,required=True)
j=Journey(p.parse_args())
try:j.run()
except Exception as error:j.result.update(status='failed',error=str(error));raise
finally:(j.out/'result.json').write_text(json.dumps(j.result,indent=2)+'\n')
