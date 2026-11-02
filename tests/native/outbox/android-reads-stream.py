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
  for attempt in range(3):
   try:
    self.adb('shell','uiautomator','dump','/data/local/tmp/hg-outbox.xml');break
   except base.subprocess.CalledProcessError as error:
    if error.returncode!=137 or attempt==2:raise
    self.result.setdefault('uiAutomationRetries',[]).append({'exitCode':137,'at':time.time(),'attempt':attempt+1});time.sleep(.5)
  self.xml=self.adb('exec-out','cat','/data/local/tmp/hg-outbox.xml',binary=True)
  nodes=list(ET.fromstring(self.xml).iter('node'))
  assert any(n.get('package')==PACKAGE for n in nodes),'Fixture is not foreground'
  return nodes
 def scroll_to(self,title):
  for direction in ['down','up']:
   for _ in range(10):
    nodes=self.nodes();found=[n for n in nodes if n.get('text')==title]
    for n in found:
     b=base.re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',n.get('bounds',''))
     if b and int(b[4])>int(b[2]) and int(b[2])>=350:return n
    self.input('swipe','540','2100' if direction=='down' else '1000','540','1000' if direction=='down' else '2100','450')
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
    self.input('swipe','540','1000' if direction=='up' else '2100','540','2100' if direction=='up' else '1000','350')
  raise RuntimeError('Native field absent: '+name)
 def filter(self,value):self.field('filters',value)
 def trace(self):return self.value('plan')
 def sdk(self,kind='outbox.query.result'):
  for _ in range(6):
   for n in self.nodes():
    try:value=json.loads(n.get('text',''))
    except ValueError:continue
    if isinstance(value,dict) and value.get('type')==kind:return value
   self.input('swipe','540','2100','540','1000','350')
  raise RuntimeError('Original SDK result absent')
 def query_tracer(self):
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

 def value(self,key):
  for direction in ['down','up']:
   for _ in range(12):
    for n in self.nodes():
     for field in ['text','content-desc']:
      try:v=json.loads(n.get(field,''))
      except ValueError:continue
      if isinstance(v,dict) and key in v:return v
    self.input('swipe','540','2100' if direction=='down' else '1000','540','1000' if direction=='down' else '2100','300')
  raise RuntimeError('Observed SDK/native JSON absent: '+key)
 def wait_stream(self,minimum=1,timeout=45):
  deadline=time.monotonic()+timeout
  while time.monotonic()<deadline:
   for n in self.nodes():
    text=n.get('text','')
    match=base.re.match(r'Live Outbox · (\d+) signed events?\.',text)
    if match and int(match[1])>=minimum:return int(match[1])
   time.sleep(.2)
  raise RuntimeError('Fresh original SDK Outbox event absent')
 def run(self):
  self.query_tracer()
  self.result.update(kind='hypergolic-android-outbox-reads-stream-v1',status='running',scope='Original SDK native public WSS finite reads, complete planned stream fanout and lifecycle; controlled public owner only, no signing, protected identity or published admission claim.',readSDKResults=[],streamSnapshots=[])
  sample=json.loads(self.args.sample.read_text())
  self.adb('shell','am','force-stop',PACKAGE);self.adb('shell','am','start','-W','-n',PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity');self.find('Native Outbox host connected')
  self.filter(json.dumps(sample['filter'],separators=(',',':')))
  roles=[]
  for tag in sample['list']['tags']:
   if len(tag)>=2 and tag[0]=='r' and (len(tag)==2 or tag[2]=='read') and tag[1] not in roles:roles.append(tag[1].rstrip('/'))
  for label,relays,name in [('Resolve author write relays',sample['writeRelays'],'resolve-read-write-roles'),('Resolve author inbox relays',roles,'resolve-write-read-roles')]:
   self.tap(self.scroll_to(label));self.find('Outbox relay plan resolved.');sdk=self.value('relays');trace=self.value('plan')
   assert sdk['relays']==relays and sdk['source']=='cache' and not trace['calls'];self.result['readSDKResults'].append(sdk);self.check(name);self.capture(name)
  self.tap(self.scroll_to('Fetch signed event'));self.find('Outbox event read complete.');sdk=self.sdk('outbox.getEvent.result')
  assert sdk['result']['event']==sample['event'] and sdk['result']['sidecar']['relayHints'];self.result['readSDKResults'].append(sdk);self.check('getEvent-exact-signed-id');self.capture('getEvent-exact-signed-id')
  missing=[{**sample['filter'][0],'ids':['0'*64]}];self.filter(json.dumps(missing,separators=(',',':')))
  self.tap(self.scroll_to('Fetch signed event'));self.find('Outbox failed: not found');sdk=self.sdk('outbox.getEvent.result')
  assert sdk['error']=='not found' and 'result' not in sdk;self.result['readSDKResults'].append(sdk);self.check('getEvent-not-found');self.capture('getEvent-not-found')
  self.filter(json.dumps(sample['filter'],separators=(',',':')));self.field('draft','outbox-native-draft');self.tap(self.scroll_to('Start live outbox'));self.wait_stream()
  stream=self.value('stream')['stream'];assert [x['relay'] for x in stream['opens'][:len(sample['writeRelays'])]]==sample['writeRelays'];assert all(x['relay'] in sample['writeRelays'] for x in stream['opens'])
  self.result['streamSnapshots'].append(stream);self.check('original-live-handle-full-plan');self.capture('original-live-handle-full-plan')
  before=len(stream['opens']);healthy={x['id'] for x in stream['opens'] if x['id'] in stream['eose'] and x['id'] not in stream['stops']};assert healthy;plan_count=len(stream['plans']);self.tap(self.find('Switch loaded napplet'));time.sleep(1);self.tap(self.find('Return to Outbox'));self.wait_stream()
  stream=self.value('stream')['stream'];assert healthy.isdisjoint(stream['stops']) and len(stream['plans'])==plan_count;assert any(n.get('resource-id')=='draft' and n.get('text')=='outbox-native-draft' for n in self.nodes())
  self.check('loaded-switch-preserves-stream-and-draft');self.capture('loaded-switch-preserves-stream-and-draft');before=len(stream['opens'])
  self.input('keyevent','3');time.sleep(1);parked_at=int(time.time()*1000);time.sleep(2);self.adb('shell','am','start','-W','-n',PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity')
  deadline=time.monotonic()+30
  while time.monotonic()<deadline:
   stream=self.value('stream')['stream']
   if stream['plans'][-1]['refresh'] is True and any(x['at']>=stream['plans'][-1]['at'] for x in stream['opens']):break
   time.sleep(.3)
  else:raise RuntimeError('Native foreground metadata refresh/reconnect absent')
  assert healthy<=set(stream['stops']) and stream['plans'][-1]['refresh'] is True
  assert all(x['at']>=stream['plans'][-1]['at'] for x in stream['opens'] if x['at']>=parked_at);assert any(x['role']=='discovery' and x['relay']==sample['lookup'] for x in stream['calls'])
  self.result['streamSnapshots'].append(stream);self.check('native-background-fresh-plan-before-reconnect');self.capture('native-background-fresh-plan-before-reconnect')
  self.tap(self.scroll_to('Close live outbox'));self.find('Live Outbox closed.');stream=self.value('stream')['stream'];assert len(stream['stops'])==len(stream['opens']);self.check('original-close-stops-all-sockets');self.capture('original-close-stops-all-sockets')
  observer=self.out/'independent-public.json'
  import subprocess
  process=subprocess.Popen(['node',str(ROOT/'tests/native/feed-subscription/observe-public.mjs'),str(observer),'180000'],cwd=ROOT,stdout=subprocess.DEVNULL,stderr=(self.out/'observer.log').open('w'))
  try:
   self.filter('[{"kinds":[1],"limit":0}]');self.field('outbox-options','{"limit":0,"relays":["wss://nos.lol"],"timeoutMs":15000}');self.tap(self.scroll_to('Start live outbox'));self.wait_stream();time.sleep(28);self.wait_stream(2)
   sdk=self.value('count');assert sdk['count']>=2 and 'outbox.eose' not in sdk['wireTypes'] and 'relay.eose' not in sdk['wireTypes']
   independent=json.loads(observer.read_text());known={x['id']:x for x in independent['events'] if x['afterEOSE']}
   matching=[row for row in sdk['events'] if row['event']['id'] in known];assert matching,'No independent post-EOSE event matches actual native SDK delivery'
   for row in matching:assert base.hashlib.sha256(row['event']['content'].encode()).hexdigest()==known[row['event']['id']]['contentSha256']
   self.result.update(independentPostEOSEIds=[row['event']['id'] for row in matching],liveSDKResult=sdk);self.check('zero-backfill-public-live-after-ordinary-lease');self.capture('zero-backfill-public-live-after-ordinary-lease')
   self.tap(self.find('Change public identity'));self.find('Native Outbox host connected');self.find('Live Outbox closed.')
   self.check('changed-public-owner-revokes-old-handle');self.capture('changed-public-owner-revokes-old-handle')
   self.input('keyevent','3');time.sleep(2);self.adb('shell','am','start','-W','-n',PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity');self.find('Live Outbox closed.');assert any(n.get('text')=='{}' for n in self.nodes());self.check('revoked-intent-does-not-return');self.capture('revoked-intent-does-not-return')
  finally:process.terminate();process.wait(timeout=10)
  self.result['sourceAfter']=sources();assert self.result['sourceBefore']==self.result['sourceAfter'];self.result['status']='passed'
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--serial',required=True);p.add_argument('--adb',default=str(ROOT/'.tools/android-sdk/platform-tools/adb'))
for name in ['apk','build','sample','output']:p.add_argument('--'+name,type=Path,required=True)
j=Journey(p.parse_args())
try:j.run()
except Exception as error:j.result.update(status='failed',error=str(error));raise
finally:(j.out/'result.json').write_text(json.dumps(j.result,indent=2)+'\n')
