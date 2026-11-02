#!/usr/bin/env python3
"""Real-time ordinary Android notification dismissal and expiry; no shortened clock."""
import argparse,importlib.util,json,re,sys,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'tests/native/presentation'))
from evidence import sha
spec=importlib.util.spec_from_file_location('ordinary_notify',ROOT/'tests/native/presentation/notify-physical-android.py')
base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
class Journey(base.Journey):
 def foreground(self,label):
  dump=self.adb('shell','dumpsys','activity','activities');resumed=[line.strip() for line in dump.splitlines() if 'topResumedActivity=' in line or 'mResumedActivity:' in line];assert resumed and all(base.PACKAGE in line for line in resumed),'Keeper lost observed foreground during real-time expiry'
  (self.args.output/(label+'-activity.txt')).write_text(dump+'\n');return resumed
 def send_timed(self):
  self.guest_find('Send notification');started=time.monotonic();self.tap('Send notification');self.find('Notification sent.');value=self.data('notify-result');finished=time.monotonic();assert isinstance(value.get('notificationId'),str) and value['notificationId'];self.report.setdefault('sdkSendReceipts',[]).append({'instance':self.instance(),**value});self.report['expirySendInterval']={'beforeInputMonotonic':started,'afterOriginalSDKResultMonotonic':finished,'widthSeconds':finished-started};self.persist();return value['notificationId'],started,finished
 def run(self):
  self.report.update(kind='hypergolic-ordinary-android-notification-expiry-v1',observerSha256=sha(Path(__file__).read_bytes()),scope='Real protected owner, ordinary bundled SDK programmatic dismissal, toast expiry and actual five-minute card timeout. Unchanged installed app and clocks; no real publisher, native zero-effect counters or full notification acceptance.')
  self.baseline();caller=self.open_lab();self.permission();first=self.send();self.centre(first);self.capture('native-before-sdk-dismiss');self.tap('notify-centre-close');self.guest('Dismiss last notification');self.find('Dismissal requested.');assert self.events(1)==[{'kind':'dismissed','notificationId':first,'reason':'user'}];self.absent('notify-centre-open');self.capture('sdk-programmatic-dismiss-exact-event');self.check('physical-original-sdk-dismiss-removes-card-exact-user-event')
  second,before,after=self.send_timed();assert second!=first
  while time.monotonic()-after<12:time.sleep(min(1,12-(time.monotonic()-after)))
  self.absent('notify-toast');self.centre(second);self.capture('native-toast-expired-card-retained');self.tap('notify-centre-close');assert self.events(1)==[{'kind':'dismissed','notificationId':first,'reason':'user'}];self.check('physical-real-time-toast-disappears-card-retained-no-dismiss-event')
  self.centre(second);self.report['expirySamples']=[]
  for offset in [60,120,180,240,285]:
   while time.monotonic()-after<offset:time.sleep(min(30,offset-(time.monotonic()-after)))
   resumed=self.foreground('expiry-'+str(offset));self.find('notify-card-'+second);self.capture('native-card-retained-'+str(offset));observed=time.monotonic();self.report['expirySamples'].append({'nominalAfterAckSeconds':offset,'afterInputSeconds':observed-before,'afterAckSeconds':observed-after,'resumed':resumed,'cardId':second,'cardPresent':True});self.persist();print('REAL_TIME_CARD_RETAINED',offset,flush=True)
  self.check('physical-card-remains-before-five-minute-expiry')
  deadline=after+335
  while time.monotonic()<deadline:
   nodes=self.nodes();now=time.monotonic()
   if not any(n.get('resource-id')=='notify-card-'+second for n in nodes):break
   time.sleep(1)
  else:raise AssertionError('Exact card did not expire after real five-minute foreground interval')
  assert now-before>=300,'Card disappeared before measured five minutes from input'
  self.foreground('expiry-after-timeout');self.find('No current notifications.');self.capture('native-real-five-minute-empty-centre');self.tap('notify-centre-close');assert self.events(2)==[{'kind':'dismissed','notificationId':first,'reason':'user'},{'kind':'dismissed','notificationId':second,'reason':'timeout'}];self.absent('notify-centre-open');self.report['expiryObserved']={'notificationId':second,'afterInputSeconds':now-before,'afterAckSeconds':now-after,'reason':'timeout','callerInstance':caller,'clockOverride':False};self.capture('sdk-exact-five-minute-timeout-event');self.check('physical-real-five-minute-timeout-exact-original-sdk-callback');self.report['status']='passed-scoped-physical-notifications'
if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--serial',required=True);p.add_argument('--npub',required=True);p.add_argument('--ui-jar',type=Path,required=True)
 for name in ['build','apk','output']:p.add_argument('--'+name,type=Path,required=True)
 a=p.parse_args();a.section='expiry';j=Journey(a)
 try:j.run()
 except BaseException as error:
  j.report.update(status='failed',error=str(error) or type(error).__name__);j.persist()
  try:j.capture('failure')
  except Exception:pass
 finally:
  try:j.cleanup()
  except BaseException as error:j.report.update(status='failed-cleanup',cleanupError=str(error) or type(error).__name__)
  finally:(a.output/'result.json').write_text(json.dumps(j.report,indent=2)+'\n')
 if j.report['status']!='passed-scoped-physical-notifications':raise SystemExit(1)
