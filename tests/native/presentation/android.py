#!/usr/bin/env python3
"""Actual signed local original-SDK notification admission, permission and callback journey."""
import argparse,importlib.util,json,re,time
from pathlib import Path
from evidence import ROOT,sha,sources
spec=importlib.util.spec_from_file_location('native_ui',ROOT/'tests/native/upload/android-upload.py');ui=importlib.util.module_from_spec(spec);spec.loader.exec_module(ui)
PACKAGE='org.nostrocket.hypergolic.presentationfixture';ui.PACKAGE=PACKAGE;ui.sources=sources
spec=importlib.util.spec_from_file_location('routing_ui',ROOT/'tests/native/routing/android.py');routing=importlib.util.module_from_spec(spec);spec.loader.exec_module(routing)
routing.PACKAGE=PACKAGE;routing.ui.PACKAGE=PACKAGE;routing.ui.sources=sources
class Journey(routing.Journey):
 def guest_find(self,label):
  # Clipped AX bounds identify which side of the actual guest viewport holds the control.
  for attempt in range(80):
   nodes=self.nodes();views=[n for n in nodes if n.get('class')=='android.webkit.WebView' and n.get('text')=='Hypergolic runtime' and self.visible(n)]
   assert len(views)==1,'Guest WebView not uniquely observed'
   bounds=lambda n:tuple(map(int,re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',n.get('bounds')).groups()))
   a,b,c,d=bounds(views[0]);matches=[n for n in nodes if label in (n.get('resource-id'),n.get('text'),n.get('content-desc'))]
   for node in matches:
    x1,y1,x2,y2=bounds(node)
    if x2>x1 and y2-y1>40 and a<(x1+x2)//2<c and b+80<(y1+y2)//2<d-80:return
   direction='up' if not matches or sum(bounds(matches[0])[1::2])/2>(b+d)/2 else 'down'
   self.guest_scroll(direction);time.sleep(.3)
  raise AssertionError('Guest control not exposed after observed directional scroll: '+label)
 def settings_find(self,label):
  for direction in ['up','down']:
   for _ in range(40):
    nodes=self.nodes();matches=[n for n in nodes if label in (n.get('text'),n.get('content-desc'),n.get('resource-id')) and self.visible(n)]
    clickable=[n for n in matches if n.get('clickable')=='true']
    if len(clickable)==1:return clickable[0]
    if not clickable and len(matches)==1:return matches[0]
    views=[n for n in nodes if n.get('class')=='android.widget.ScrollView' and self.visible(n)]
    if not views:time.sleep(.2);continue
    assert len(views)==1,'Native settings scroll container is ambiguous'
    x1,y1,x2,y2=map(int,re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',views[0].get('bounds')).groups());high=y1+int((y2-y1)*.25);low=y1+int((y2-y1)*.8)
    args=['swipe',str(x2-32),str(low if direction=='up' else high),str(x2-32),str(high if direction=='up' else low),'400'];self.report['inputs'].append({'control':'observed Settings scroll','input':args});self.adb('shell','input',*args);time.sleep(.2)
  raise AssertionError('Native Settings control unavailable: '+label)
 def data(self,label,minimum_events=0,previous_id=None):
  for _ in range(30):
   matches=[n for n in self.nodes() if n.get('resource-id')==label and n.get('text')]
   if len(matches)==1:
    value=json.loads(matches[0].get('text'))
    if (not minimum_events or isinstance(value,list) and len(value)>=minimum_events) and (previous_id is None or value.get("notificationId")!=previous_id):return value
   time.sleep(.2)
  raise AssertionError('Original SDK report not observed: '+label)
 def run(self):
  self.report.update(kind='hypergolic-android-notification-tracer-v1',scope='Actual signed local original SDK/native notification permission, shell presentation and callbacks. Disposable identities; no OS push/physical/protected claim.')
  build=json.loads(self.args.build.read_text());assert build['status']=='built' and build['sourceAfter']==sources()
  actual=self.adb('exec-out','cat',self.adb('shell','pm','path',PACKAGE).removeprefix('package:'),binary=True);assert sha(actual)==sha(self.args.apk.read_bytes())==build['productSha256'];self.report['installedApkSha256']=sha(actual)
  self.adb('shell','pm','clear',PACKAGE);self.adb('shell','am','start','-W','-n',PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity')
  address=self.find('signed-caller-address').get('content-desc');assert address.startswith('naddr1');self.tap('shell-settings');self.enter_address(address);self.settings_tap('settings-open-napplet');self.settings_find('Allow this napplet?');self.settings_find('Requested access: notify');self.capture('normal-notify-domain-consent');self.settings_tap('settings-napplet-approve');self.find('SDK ready for routing.');self.check('signed-notification-domain-admission')
  self.guest('Request notification permission');self.find('Allow notifications?');self.find('signed-notify-caller-lab');self.capture('trusted-notification-permission');self.tap('notify-deny');self.find('Notification permission denied.');assert self.data('notify-permission-result')=={'granted':False};self.check('native-denied-original-sdk-permission')
  self.guest('Request notification permission');self.find('Allow notifications?');self.tap('notify-allow');self.find('Notification permission granted.');assert self.data('notify-permission-result')=={'granted':True};self.check('native-approved-original-sdk-permission')
  previous_id=None
  def send():
   nonlocal previous_id
   self.guest('Send notification');self.capture('foreground-toast');value=self.data('notify-result',previous_id=previous_id);assert value['notificationId'];previous_id=value['notificationId'];self.tap('notify-centre-open');self.find('Routing Lab alert\nExact SDK notification + ⚡');self.find('From signed-notify-caller-lab');return value['notificationId']
  first=send();self.capture('attributed-native-notification');self.check('native-attributed-exact-sdk-notification');self.tap('notify-action-reply');self.tap('notify-centre-close');events=self.data('notify-events',1);assert events==[{'kind':'action','notificationId':first,'actionId':'reply'}];self.report['originalSDKAction']=events;self.check('native-action-original-sdk-callback')
  second=send();self.tap('notify-click-'+second);self.tap('notify-centre-close');events=self.data('notify-events',2);assert events[-1]=={'kind':'clicked','notificationId':second};self.check('native-body-original-sdk-callback')
  third=send();self.tap('notify-dismiss-'+third);self.tap('notify-centre-close');events=self.data('notify-events',3);assert events[-1]=={'kind':'dismissed','notificationId':third,'reason':'user'};self.report['originalSDKEvents']=events;self.capture('original-sdk-notification-callbacks');self.check('native-dismiss-original-sdk-callback')
  self.report['sourceAfter']=sources();assert self.report['sourceAfter']==self.report['sourceBefore'];self.report['status']='passed'
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
