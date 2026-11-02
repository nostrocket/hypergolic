#!/usr/bin/env python3
"""Actual normal signed local Resource Lab admission, per-opening approval and public identity continuity."""
import argparse,importlib.util,json,re,time
from pathlib import Path
from evidence import ROOT,sha,sources
spec=importlib.util.spec_from_file_location('native_ui',ROOT/'tests/native/upload/android-upload.py');ui=importlib.util.module_from_spec(spec);spec.loader.exec_module(ui)
PACKAGE='org.nostrocket.hypergolic.routingfixture';ui.PACKAGE=PACKAGE;ui.sources=sources
class Journey(ui.Journey):
 def guest_exposed(self,node,nodes):
  if not self.visible(node):return False
  views=[n for n in nodes if n.get('class')=='android.webkit.WebView' and n.get('text')=='Hypergolic runtime' and self.visible(n)]
  if len(views)!=1:return False
  bounds=lambda n:tuple(map(int,re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',n.get('bounds')).groups()))
  x1,y1,x2,y2=bounds(node);a,b,c,d=bounds(views[0]);return a<(x1+x2)//2<c and b<(y1+y2)//2<d
 def guest_find(self,label):
  # Wait for the actual guest accessibility subtree before scrolling; readiness can precede its publication.
  deadline=time.monotonic()+15
  while time.monotonic()<deadline:
   nodes=self.nodes()
   if any(n.get('resource-id')=='archetype' or n.get('text')=='Routing Lab' for n in nodes):break
   if any(label in (n.get('text'),n.get('content-desc'),n.get('resource-id')) and self.guest_exposed(n,nodes) for n in nodes):return
   time.sleep(.2)
  for direction in ['up','down']:
   for _ in range(20):
    nodes=self.nodes()
    if any(label in (n.get('text'),n.get('content-desc'),n.get('resource-id')) and self.guest_exposed(n,nodes) for n in nodes):return
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
 def run(self):
  self.report.update(kind='hypergolic-android-routing-tracer-v1',scope='Normal signed local Routing Lab admission, native review, actual two-view SDK dispatch and original payload; disposable identities, no publication or physical/protected claim.')
  build=json.loads(self.args.build.read_text());assert build['status']=='built' and build['sourceAfter']==sources()
  actual=self.adb('exec-out','cat',self.adb('shell','pm','path',PACKAGE).removeprefix('package:'),binary=True);assert sha(actual)==sha(self.args.apk.read_bytes())==build['productSha256'];self.report['installedApkSha256']=sha(actual)
  def launch():self.adb('shell','am','force-stop',PACKAGE);self.adb('shell','am','start','-W','-n',PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity');self.find('signed-peer-address')
  def open_signed(role):
   address=self.find('signed-'+role+'-address').get('content-desc');assert address.startswith('naddr1');self.tap('shell-settings');self.enter_address(address);self.settings_tap('settings-open-napplet');self.settings_find('Allow this napplet?');self.settings_find('Requested access: inc, intent');self.capture(role+'-domain-consent');self.settings_tap('settings-napplet-approve');self.find('SDK ready for routing.');assert self.find('focused-napplet-name').get('text')=='signed-routing-'+role+'-lab'
  self.adb('shell','pm','clear',PACKAGE);launch();open_signed('peer');self.check('signed-peer-normal-admission')
  self.guest('Subscribe to topic');self.find('Allow this topic?');self.find('napplet:note/open');self.capture('topic-review');self.tap('routing-approve');self.check('exact-topic-session-approval')
  open_signed('caller');self.check('signed-caller-normal-admission');self.guest('Check availability');self.guest_find('availability');available=json.loads(self.find('availability').get('text'));assert available['available'] and [x['dTag'] for x in available['candidates']]==['signed-routing-peer-lab'];self.report['availability']=available;self.capture('signed-catalog-availability');self.check('verified-handler-availability')
  def review():
   self.guest('Invoke handler');self.find('Open with this napplet?');self.find('signed-routing-caller-lab');self.settings_find('routing-candidate-c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5-signed-routing-peer-lab');payload=json.loads(self.find('routing-payload').get('text'));assert payload=={'text':'routing tracer + ⚡','nested':[None,False,3]};self.capture('dispatch-review-'+str(len(self.report['checks'])))
  review();self.tap('routing-cancel');self.find('Dispatch declined.');self.guest_find('intent-result');denied=json.loads(self.find('intent-result').get('text'));assert denied['ok']==False and denied['handled']==False;self.report['deniedSDKResult']=denied;self.check('dispatch-cancel-original-sdk-result')
  review();self.tap('routing-approve');assert self.find('focused-napplet-name').get('text')=='signed-routing-peer-lab';self.guest_find('topic-events');events=json.loads(self.find('topic-events').get('text'));assert len(events)==1 and events[0]['sender']=='signed-routing-caller-lab' and events[0]['payload']=={'text':'routing tracer + ⚡','nested':[None,False,3]};self.report['originalSDKEvents']=events;self.capture('approved-target-sdk-payload');self.check('approved-dispatch-real-target-exact-payload')
  self.tap('handle-right');self.find('Loaded napplets');time.sleep(.6);self.tap('Open signed-routing-caller-lab');time.sleep(.6);assert self.find('focused-napplet-name').get('text')=='signed-routing-caller-lab';self.guest_find('intent-status');self.find('Dispatch accepted.');self.guest_find('intent-result');result=json.loads(self.find('intent-result').get('text'));assert result['ok']==True and result['handled']==True and result['handler']=='signed-routing-peer-lab' and result['convention']=='napplet:note/open' and result['windowId'];self.report['originalSDKResult']=result;self.capture('original-caller-sdk-receipt');self.check('original-caller-structured-sdk-result')
  def focus(role):
   self.tap('handle-right');self.find('Loaded napplets');time.sleep(.6);self.tap('Open signed-routing-'+role+'-lab');time.sleep(.6);assert self.find('focused-napplet-name').get('text')=='signed-routing-'+role+'-lab'
  def data(label):self.guest_find(label);return json.loads(self.find(label).get('text'))
  self.guest('Subscribe to topic');self.find('Allow this topic?');self.tap('routing-approve');self.guest('Emit topic payload');focus('peer');events=data('topic-events');assert len(events)==2 and events[-1]['sender']=='signed-routing-caller-lab';self.capture('foreground-topic-peer');self.check('foreground-topic-switch-exact-sender-no-echo')
  self.guest('Emit topic payload');focus('caller');events=data('topic-events');assert len(events)==1 and events[0]['sender']=='signed-routing-peer-lab';self.capture('foreground-topic-caller');self.check('symmetric-topic-payload')
  def open_channel():
   self.guest('Open channel');self.find('Open this channel?');self.find('signed-routing-caller-lab');self.find('signed-routing-peer-lab');self.capture('channel-review-'+str(len(self.report['checks'])));self.tap('routing-approve');self.guest_find('channel-status');self.find('Channel opened.');value=data('channel-info');assert value['peer']=='signed-routing-peer-lab' and value['id'];return value['id']
  channel=open_channel();self.report['channelId']=channel;self.check('new-channel-trusted-endpoint-review')
  focus('peer');info=data('channel-info');assert info=={'id':channel,'peer':'signed-routing-caller-lab'};self.capture('inbound-native-channel-handle');self.check('target-original-sdk-inbound-handle')
  self.guest('Emit channel payload');focus('caller');events=data('channel-events');assert len(events)==1 and events[0]['channelId']==channel and events[0]['sender']=='signed-routing-peer-lab' and events[0]['payload']=={'text':'routing tracer + ⚡','nested':[None,False,3]};self.report['originalSDKChannelEvents']=events;self.capture('original-channel-message');self.check('peer-channel-message-exact-payload')
  self.guest('Broadcast channel payload');focus('peer');events=data('channel-events');assert len(events)==1 and events[0]['channelId']==channel and events[0]['sender']=='signed-routing-caller-lab';self.capture('original-channel-broadcast');self.check('symmetric-channel-broadcast')
  self.guest('Close channel');closed=data('channel-closed');assert closed=={'channelId':channel};self.guest('Attach late close handler');assert data('late-close-result')==closed;self.capture('target-late-terminal-record');self.check('original-sdk-late-terminal-record')
  focus('caller');assert data('channel-closed')=={'channelId':channel,'reason':'closed'};self.guest('List channels');assert data('channel-info')==[];self.check('symmetric-close-empty-list')
  channel=open_channel();self.check('fresh-channel-needs-new-review');self.adb('shell','input','keyevent','3');time.sleep(1);self.adb('shell','am','start','-W','-n',PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity');self.find('focused-napplet-name');assert data('channel-closed')=={'channelId':channel,'reason':'background'};self.guest('List channels');assert data('channel-info')==[];self.capture('native-background-terminal');self.check('native-background-closes-without-reopening')
  self.guest('Invoke handler');self.find('Open with this napplet?');self.capture('native-expiring-review');deadline=time.monotonic()+30
  while time.monotonic()<deadline:
   if not any(n.get('resource-id')=='routing-review' for n in self.nodes()):break
   time.sleep(.2)
  else:raise AssertionError('Native review did not expire')
  self.guest_find('intent-status');deadline=time.monotonic()+10
  while time.monotonic()<deadline:
   value=self.find('intent-status').get('text')
   if value.startswith('Request failed:') or value=='Dispatch declined.':break
   time.sleep(.2)
  else:raise AssertionError('Original SDK did not terminate the expired request')
  self.capture('native-expired-original-sdk');self.check('native-deadline-revokes-unanswered-dispatch')
  focus('peer');before=data('topic-events');assert len(before)==2;self.check('expired-review-delivers-no-payload');focus('caller')
  channel=open_channel();self.guest('Request channel review flood')
  deadline=time.monotonic()+35
  while time.monotonic()<deadline:
   nodes=self.nodes()
   if any(n.get('resource-id')=='routing-review' for n in nodes):self.tap('routing-cancel')
   elif any(n.get('resource-id')=='flood-results' and n.get('text') for n in nodes):break
   else:time.sleep(.2)
  results=data('flood-results');assert len(results)==8 and all(value['ok']==False for value in results);self.report['originalSDKFloodResults']=results;self.capture('native-bounded-review-flood');self.check('native-review-flood-has-no-approved-channel')
  open_signed('second-peer');self.guest('Send malformed guest requests');self.find('Malformed guest requests sent.');focus('peer');assert data('topic-events')==before;self.capture('native-forged-sender-no-delivery');self.check('native-guest-forged-sender-and-control-denied')
  focus('second-peer');self.guest_find('foreign-channel');self.tap('foreign-channel');self.adb('shell','input','keycombination','113','29');self.adb('shell','input','text',channel);self.adb('shell','input','keyevent','4');assert self.find('foreign-channel').get('text')==channel;self.guest('Send foreign channel payload');self.find('Foreign channel request sent.');focus('peer');assert len(data('channel-events'))==1;self.check('native-third-view-cannot-use-active-channel-id')
  focus('second-peer');self.guest('Emit topic payload');focus('peer');events=data('topic-events');assert len(events)==3 and events[-1]['sender']=='signed-routing-second-peer-lab';self.capture('native-negative-controls-positive-ping');self.check('native-negative-controls-have-live-positive-ping')
  focus('caller');self.tap('handle-right');self.find('Loaded napplets');time.sleep(.6);self.tap('Close signed-routing-peer-lab');self.find('close-confirm');self.tap('close-confirm');self.tap('Open signed-routing-caller-lab');time.sleep(.6);closed=data('channel-closed');assert closed=={'channelId':channel,'reason':'peer destroyed'};self.capture('native-peer-close-terminal');self.check('native-peer-close-revokes-channel')
  self.report['sourceAfter']=sources();assert self.report['sourceBefore']==self.report['sourceAfter'];self.report['status']='passed'
if __name__=='__main__':
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
