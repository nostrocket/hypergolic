#!/usr/bin/env python3
"""Real protected Android owner: declined/accepted signed notification versions and cold pin."""
import argparse,importlib.util,json,sys,time,traceback
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3];sys.path.insert(0,str(ROOT/'tests/native/presentation'))
spec=importlib.util.spec_from_file_location('publisher_observer',ROOT/'tests/native/presentation/notify-publisher-physical-android.py');base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)

def review_field(nodes,instance,text):
 reviews=[n for n in nodes if n.get('resource-id')=='published-update-review-'+instance and base.visible(n)]
 assert len(reviews)==1,'Exact native update review is not unique'
 a,b,c,d=base.frame(reviews[0]);matches=[n for n in nodes if n.get('text')==text and base.visible(n) and a<=base.frame(n)[0]<base.frame(n)[2]<=c and b<=base.frame(n)[1]<base.frame(n)[3]<=d]
 assert len(matches)==1,'Exact visible field is not bound to the native update review: '+text
 return matches[0]

class Journey(base.Journey):
 def __init__(self,args):
  super().__init__(args);self.report.update(kind='hypergolic-protected-android-notification-version-v1',section='versions',observerSha256=base.sha(Path(__file__).read_bytes()),scope='Real protected owner, original SDK and normal signed loader with local test transport. Decline, accepted replacement, remembered same-source permission, new callbacks and actual cold pinned restart. No external publication, iOS or complete CAP-10 claim.',versions={role:{'eventId':base.fixtures[role]['event']['id'],'aggregate':next(t[1] for t in base.fixtures[role]['event']['tags'] if t[0]=='x')} for role in ['caller','notify-update']})
 def capture(self,label):
  stem=label;index=2
  while any((self.args.output/(stem+suffix)).exists() for suffix in ['.xml','.png']):stem=label+'-'+str(index);index+=1
  super().capture(stem);self.report.setdefault('captures',[]).append({'label':label,'stem':stem,'xmlSha256':base.sha((self.args.output/(stem+'.xml')).read_bytes()),'pngSha256':base.sha((self.args.output/(stem+'.png')).read_bytes())});self.persist()
 def settings_find(self,label):
  if self.navigation_top is None:return super().settings_find(label)
  deadline=time.monotonic()+55;previous=None;stalled=0;direction='up';reversed_once=False
  for attempt in range(20):
   nodes=self.nodes();matches=[n for n in nodes if label in (n.get('text'),n.get('content-desc'),n.get('resource-id'))];views=[n for n in nodes if n.get('class')=='android.widget.ScrollView' and base.visible(n)]
   assert len(views)<=1,'Native Settings viewport is ambiguous'
   viewport=base.frame(views[0]) if views else None
   valid=[n for n in matches if base.visible(n) and base.frame(n)[3]<=self.navigation_top and (viewport is None or base.frame(n)[1]>=viewport[1] and base.frame(n)[3]<=viewport[3]) and (n.get('clickable')!='true' or n.get('enabled')=='true' and base.frame(n)[3]-base.frame(n)[1]>=100)]
   buttons=[n for n in valid if n.get('clickable')=='true']
   if len(buttons)==1:return buttons[0]
   if not buttons and len(valid)==1:return valid[0]
   assert len(matches)<=1,'Native Settings target is ambiguous: '+label
   if viewport is None:time.sleep(.2);continue
   a,b,c,d=viewport;d=min(d,self.navigation_top);target=matches[0] if matches else None
   if target is not None:
    x1,y1,x2,y2=base.frame(target);centre=(y1+y2)//2;direction='down' if centre<b+80 else 'up'
    needed=b+100-centre if direction=='down' else centre-(d-100)
   else:needed=(d-b)//4
   fingerprint=base.sha(self.xml);stalled=stalled+1 if fingerprint==previous else 0;previous=fingerprint
   if stalled>=3:
    if target is not None or reversed_once:break
    direction='down' if direction=='up' else 'up';reversed_once=True;stalled=0
   if time.monotonic()>=deadline:break
   distance=max(96,min((d-b)//4,needed));middle=(b+d)//2;start=middle-distance//2 if direction=='down' else middle+distance//2;end=start+distance if direction=='down' else start-distance;args=['swipe',str((a+c)//2),str(start),str((a+c)//2),str(end),'600']
   self.report['inputs'].append({'control':'observed measured Native Settings drag','target':label,'direction':direction,'bounds':[a,b,c,d],'targetBounds':target.get('bounds') if target is not None else None,'input':args});self.persist();self.adb('shell','input',*args);time.sleep(.2)
  self.capture('bounded-native-settings-navigation-failure');raise AssertionError('Native Settings target not exposed within measured bounded drags: '+label)
 def pinned(self,event,label):
  self.settings();self.settings_find('Pinned event '+event);self.capture(label);self.tap('settings-done')
 def update_review(self,instance,label):
  self.settings();self.settings_tap('published-update-check-'+instance)
  fields=['Use this verified update?',base.fixtures['caller']['event']['pubkey'],base.fixtures['caller']['appId'],base.fixtures['caller']['event']['id'],base.fixtures['notify-update']['event']['id'],'Requested access: notify']
  for index,value in enumerate(fields):
   self.settings_find(value);review_field(self.nodes(),instance,value);self.capture(label+'-field-'+str(index))
  self.report.setdefault('exactNativeUpdateReviews',[]).append({'instance':instance,'publisher':fields[1],'appId':fields[2],'previousEventId':fields[3],'nextEventId':fields[4],'domains':['notify']});self.persist()
 def fresh(self,instance,label):
  assert self.instance()==instance;assert self.events()==[]
  for name in ['notify-result','notify-permission-result']:assert self.find(name).get('text','')==''
  nodes=self.nodes();assert not any(n.get('resource-id') in ['notify-centre-open','notify-toast','notify-toast-open'] or n.get('resource-id','').startswith(('notify-card-','notify-badge-')) for n in nodes),'Old native notification presentation remains';self.capture(label)
 def run(self):
  self.baseline();original=self.open_signed('caller');self.report['originalInstance']=original;self.pinned(base.fixtures['caller']['event']['id'],'native-original-pin');self.permission_signed('caller');first=self.send();self.guest('Set notification badge');self.find('Badge requested.');self.card(first,'caller');self.find('Badge count: 3');self.capture('native-original-card-badge');self.tap('notify-click-'+first);self.tap('notify-centre-close');assert self.events(1)==[{'kind':'clicked','notificationId':first}];self.check('physical-original-signed-pin-approved-card-badge-exact-click');live=self.send(first);self.card(live,'caller');self.find('Badge count: 3');self.capture('native-separate-live-original-card-before-update');self.tap('notify-centre-close')
  self.tap('qa-offer-notify-update');self.find('Distinct signed notification version available.');self.update_review(original,'native-declined-update');self.settings_tap('published-update-cancel-'+original);self.tap('settings-done');self.find('SDK ready for routing.');assert self.instance()==original;self.pinned(base.fixtures['caller']['event']['id'],'native-decline-retains-original-pin');self.permission_signed('caller',remembered=True);self.card(live,'caller');self.find('Badge count: 3');self.capture('native-decline-retains-card-badge');self.tap('notify-centre-close');assert self.events(1)==[{'kind':'clicked','notificationId':first}];self.check('physical-declined-verified-version-retains-pin-grant-card-badge-callback')
  self.update_review(original,'native-accepted-update');self.settings_tap('published-update-accept-'+original);self.find('SDK ready for routing.');updated=self.instance();assert updated!=original;self.owned.append(updated);self.role_ids['caller']=updated;self.report['updatedInstance']=updated;self.persist();self.fresh(updated,'native-new-version-fresh-no-old-alerts');self.pinned(base.fixtures['notify-update']['event']['id'],'native-accepted-new-pin');self.tap('handle-right');self.find('napplet-overview');self.absent('overview-card-'+original);self.tap('overview-card-'+updated);self.find('SDK ready for routing.');self.permission_signed('caller',remembered=True);second=self.send();self.card(second,'caller');self.capture('native-new-version-own-card');self.tap('notify-click-'+second);self.tap('notify-centre-close');assert self.events(1)==[{'kind':'clicked','notificationId':second}];self.capture('sdk-new-version-exact-own-callback');self.check('physical-accepted-new-hash-replaces-owner-clears-old-alerts-retains-same-source-grant')
  before=self.adb('shell','pidof',base.base.PACKAGE);self.launch(cold=True);self.find('SDK ready for routing.');after=self.adb('shell','pidof',base.base.PACKAGE);assert before and after and before!=after;self.fresh(updated,'native-cold-new-version-no-old-callback');self.pinned(base.fixtures['notify-update']['event']['id'],'native-cold-retains-new-pin');self.permission_signed('caller',remembered=True);third=self.send();self.card(third,'caller');self.capture('native-cold-new-version-own-card');self.tap('notify-centre-close');assert self.events()==[];self.report['coldRestartPids']={'before':before,'after':after};self.check('physical-cold-new-version-pin-grant-and-own-sdk-send-without-callback-replay');self.report['status']='passed-scoped-physical-notifications'
 def cleanup(self):
  if self.started_empty:
   self.launch()
   for _ in range(6):
    ns=self.nodes();decisions=[n.get('resource-id') for n in ns if n.get('resource-id','').startswith(('published-update-cancel-','published-update-access-cancel-')) and base.visible(n)]
    if decisions:assert len(decisions)==1;self.settings_tap(decisions[0]);continue
    if any(n.get('resource-id') in ['notify-allow','notify-centre-close','notify-permissions-close'] for n in ns):self.adb('shell','input','keyevent','4');continue
    if any(n.get('resource-id')=='settings-done' and base.visible(n) for n in ns):self.tap('settings-done');continue
    break
  super().cleanup()

if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__)
 for name in ['serial','npub']:p.add_argument('--'+name,required=True)
 for name in ['ui-jar','build','apk','output']:p.add_argument('--'+name,type=Path,required=True)
 args=p.parse_args();args.section='versions';journey=Journey(args)
 try:journey.run()
 except BaseException as error:
  journey.report.update(status='failed',error=str(error) or type(error).__name__,errorTraceback=traceback.format_exc());journey.persist()
  try:journey.capture('failure')
  except Exception as capture_error:journey.report['failureCaptureError']=str(capture_error)
 finally:
  try:journey.cleanup()
  except BaseException as error:journey.report.update(status='failed-cleanup',cleanupError=str(error) or type(error).__name__)
  (args.output/'result.json').write_text(json.dumps(journey.report,indent=2)+'\n')
 if journey.report['status']!='passed-scoped-physical-notifications':raise SystemExit(1)
