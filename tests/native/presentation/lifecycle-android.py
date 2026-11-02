#!/usr/bin/env python3
"""Actual signed local SDK/native notification and configuration lifecycle controls."""
import argparse,importlib.util,json,re,time,xml.etree.ElementTree as ET
from pathlib import Path
from evidence import ROOT,sha,sources
spec=importlib.util.spec_from_file_location('config_ui',ROOT/'tests/native/presentation/config-android.py');config=importlib.util.module_from_spec(spec);spec.loader.exec_module(config)
PACKAGE=config.PACKAGE
USERS=['79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798','c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5']
class Journey(config.Journey):
 def open_role(self,role,domain,first=True):
  address=self.find('signed-'+role+'-address').get('content-desc');self.tap('shell-settings');self.enter_address(address);self.settings_tap('settings-open-napplet')
  if first:self.settings_find('Allow this napplet?');self.settings_find('Requested access: '+domain);self.settings_tap('settings-napplet-approve')
  self.find('SDK ready for routing.')
 def focus(self,name):
  self.tap('handle-right');self.find('Loaded napplets');time.sleep(.6);self.tap('Open '+name);time.sleep(.6);assert self.find('focused-napplet-name').get('text')==name
 def background(self):
  self.adb('shell','input','keyevent','3');time.sleep(1);self.adb('shell','am','start','-W','-n',PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity');self.find('focused-napplet-name')
 def edit(self,label,value):
  self.settings_tap(label);self.adb('shell','input','keycombination','113','29');self.adb('shell','input','keyevent','67');self.adb('shell','input','text',value);self.adb('shell','input','keyevent','4')
 def absent(self,label):assert not any(label in (n.get('resource-id'),n.get('text'),n.get('content-desc')) for n in self.nodes()),label
 def update_check(self):
  title=self.settings_find('signed-config-caller-lab');nodes=list(ET.fromstring(self.xml).iter('node'))
  bounds=lambda n:tuple(map(int,re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',n.get('bounds')).groups()))
  x1,y1,x2,y2=bounds(title);candidates=[]
  for node in nodes:
   if not node.get('resource-id','').startswith('published-update-check-'):continue
   a,b,c,d=bounds(node)
   if y2<=b<y2+500 and a>=x1-2 and c<=x2+2:candidates.append(node.get('resource-id'))
  assert len(candidates)==1,'No unique source-attributed update control';self.settings_tap(candidates[0])
 def config_matrix(self):
  self.tap('qa-reset-config');self.find('Disposable configuration erased.');self.open_role('config-caller','config');self.register();assert self.get()==config.DEFAULTS
  self.guest('Open configuration settings');self.settings_tap('config-choice-theme-1');self.edit('config-secret-token',config.TOKEN);self.settings_tap('config-save');expected={**config.DEFAULTS,'theme':'light','token':config.TOKEN};assert self.get()==expected;self.check('native-original-sdk-explicit-config-save-control')
  self.guest('Open configuration settings');self.settings_tap('config-choice-theme-0');self.settings_tap('config-cancel');assert self.get()==expected;self.check('native-config-cancel-does-not-write')
  self.guest('Open configuration settings');self.edit('config-field-count','0');self.settings_tap('config-save');self.settings_find('config-save-error');self.settings_find('Napplet configuration');self.settings_tap('config-cancel');assert self.get()==expected;self.check('native-invalid-save-keeps-valid-values')
  self.guest('Subscribe configuration');self.guest('Open configuration settings');self.settings_tap('config-choice-theme-0');self.background();self.absent('Napplet configuration');assert self.get()==expected;self.check('native-background-revokes-unsaved-editor')
  self.open_role('config-peer','config');self.register();assert self.get()==config.DEFAULTS;self.check('native-different-app-secret-isolation');self.focus('signed-config-caller-lab');assert self.get()==expected;self.check('native-foreground-switch-retains-config-scope')
  self.guest('Send invalid configuration requests');self.find('Invalid guest configuration requests sent.');assert self.get()==expected;self.check('native-forged-config-authority-and-push-denied')
  self.guest('Register depth-four schema');self.find('Depth-four schema accepted.');deep={**expected,'deep':{'child':{'leaf':{'values':['native-depth-four']}}}};assert self.get()==deep;self.check('native-supported-depth-four-array-enum-carrier')
  self.guest('Remove secret from schema');self.find('Secret field removed.');ordinary={**config.DEFAULTS,'theme':'light'};assert self.get()==ordinary;self.guest('Restore secret in schema');self.find('Secret field restored without saved value.');assert self.get()==ordinary;self.check('native-schema-orphan-secret-is-purged')
  self.guest('Open configuration settings');self.edit('config-secret-token',config.TOKEN);self.settings_tap('config-save');assert self.get()==expected
  self.tap('qa-offer-config-update');self.find('Distinct signed version available.');self.tap('shell-settings');self.update_check();self.settings_find('Use this verified update?');self.capture('native-distinct-config-update-review');self.settings_tap('Keep current version');self.tap('settings-done');assert self.get()==expected;self.check('native-declined-update-keeps-config-hash-scope')
  self.tap('shell-settings');self.update_check();self.settings_find('Use this verified update?');self.settings_tap('Close and use update');self.find('SDK ready for routing.');self.register();assert self.get()==config.DEFAULTS;self.check('native-accepted-new-hash-starts-fresh-config')
  self.guest('Open configuration settings');self.edit('config-secret-token',config.TOKEN);self.settings_tap('config-save');assert self.get()=={**config.DEFAULTS,'token':config.TOKEN};self.guest('Open configuration settings');self.settings_tap('config-secret-clear-token');self.settings_tap('config-save');assert self.get()==config.DEFAULTS;self.check('native-explicit-secret-clear')
  self.guest('Open configuration settings');self.settings_tap('config-choice-theme-1');self.settings_tap('config-save');assert self.get()==ordinary;self.check('native-config-matrix-live-positive-save')
 def notify_matrix(self):
  self.open_role('caller','notify');self.guest('Request notification permission');self.find('Allow notifications?');self.tap('notify-allow');self.find('Notification permission granted.')
  self.guest('Set notification badge');self.find('Badge requested.');self.tap('notify-centre-open');self.find('notify-badge-signed-notify-caller-lab');self.find('Badge count: 3');self.capture('native-attributed-badge');self.tap('notify-centre-close');self.check('native-badge-verified-source-attribution')
  self.guest('Register messages channel');self.find('Channel registration sent.');self.guest_find('notify-channel');self.tap('notify-channel');self.adb('shell','input','text','messages');self.adb('shell','input','keyevent','4');self.guest('Send notification');self.find('Request failed: permission denied');self.check('native-general-grant-does-not-allow-named-channel')
  self.guest('Request notification permission');self.find('Allow notifications?');self.find('notify-review-channel');self.capture('native-exact-channel-review');self.tap('notify-allow');self.find('Notification permission granted.');self.guest('Send notification');self.find('Notification sent.');self.check('native-exact-channel-positive-sdk-send')
  self.open_role('peer','notify');self.guest('Send notification');self.find('Request failed: permission denied');self.focus('signed-notify-caller-lab');self.tap('notify-centre-open');self.find('From signed-notify-caller-lab');self.tap('notify-centre-close');self.check('native-permission-app-isolation-and-foreground-card-retention')
  self.guest('Send invalid notification controls');self.find('Invalid guest notification controls sent.');self.tap('notify-centre-open');self.find('From signed-notify-caller-lab');self.tap('notify-centre-close');self.check('native-forged-notification-authority-denied')
  self.background();self.absent('notify-centre-open');self.guest('Request notification permission');self.find('Notification permission granted.');self.absent('Allow notifications?');self.check('native-background-clears-alerts-badges-no-backlog-keeps-exact-grant')
  self.tap('shell-settings');self.settings_tap('notify-permissions-open');self.settings_tap('notify-revoke-signed-notify-caller-lab-messages');self.find('Notification permission revoked.');self.capture('native-settings-exact-channel-revoke');self.tap('notify-permissions-close');self.tap('settings-done');self.guest('Send notification');self.find('Request failed: permission denied');self.check('native-settings-channel-revoke-denies-sdk-send')
  self.guest('Request notification permission');self.find('Allow notifications?');self.tap('notify-allow');self.find('Notification permission granted.');self.guest('Send notification');self.find('Notification sent.');self.check('native-revoked-channel-needs-fresh-approval-positive-control')
  self.tap('shell-settings');self.settings_tap('identity-select-'+USERS[1]);self.settings_find('Switch identity?');self.settings_tap('identity-change-confirm');self.find('shell-settings');self.tap('shell-settings');self.settings_tap('notify-permissions-open');self.find('No saved notification permissions for this identity.');self.capture('native-notification-other-identity-empty');self.tap('notify-permissions-close');self.tap('settings-done');self.open_role('caller','notify');self.guest('Send notification');self.find('Request failed: permission denied');self.check('native-identity-change-has-no-old-grant-alert-or-recipient')
  self.guest('Request notification permission');self.find('Allow notifications?');self.tap('notify-allow');self.find('Notification permission granted.');self.guest('Send notification');self.find('Notification sent.')
  self.guest('Send oversized notification')
  for _ in range(40):
   nodes=self.nodes();raw=next((n.get('text') for n in nodes if n.get('resource-id')=='notify-oversized-result'),'')
   if raw.startswith('{'):break
   time.sleep(1)
  denied=json.loads(raw);assert denied['accepted'] is False;self.check('native-oversized-notification-denied')
  self.guest('Run notification flood')
  for _ in range(40):
   nodes=self.nodes();raw=next((n.get('text') for n in nodes if n.get('resource-id')=='notify-flood-result'),'')
   if raw.startswith('{'):break
   time.sleep(.5)
  rows=json.loads(raw)['results'];accepted=[x['notificationId'] for x in rows if x['ok']];assert len(rows)==20 and 0<len(accepted)<=7 and len(set(accepted))==len(accepted) and all(x['error']=='rate limited' for x in rows if not x['ok']);self.report['originalSDKFlood']=rows;self.check('native-sdk-notification-flood-bounded')
  live=[n.get('resource-id') for n in self.nodes() if n.get('resource-id','').startswith('runtime-status-') and self.visible(n)];assert len(live)==1
  selected=live[0].removeprefix('runtime-status-');self.report['closedLiveSessionId']=selected
  self.tap('handle-right');self.find('Loaded napplets');time.sleep(.6);self.tap('overview-close-'+selected);self.tap('close-confirm')
  for _ in range(40):
   if not any(n.get('resource-id')=='notify-centre-open' for n in self.nodes()):break
   time.sleep(.2)
  self.absent('notify-centre-open');self.absent('overview-close-'+selected);self.capture('native-close-exact-live-source');self.check('native-close-clears-notification-recipient')
 def run(self):
  self.report.update(kind='hypergolic-android-presentation-lifecycle-v1',suite=self.args.suite,scope='Actual signed-local original SDK/native lifecycle, exact Settings controls and negative/positive cases. Disposable public identities; no external publication or protected/physical acceptance.')
  build=json.loads(self.args.build.read_text());assert build['status']=='built' and build['sourceAfter']==sources();actual=self.adb('exec-out','cat',self.adb('shell','pm','path',PACKAGE).removeprefix('package:'),binary=True);assert sha(actual)==sha(self.args.apk.read_bytes())==build['productSha256'];self.report['installedApkSha256']=sha(actual)
  self.adb('shell','pm','clear',PACKAGE);self.launch();self.config_matrix() if self.args.suite=='config' else self.notify_matrix();self.report['sourceAfter']=sources();assert self.report['sourceAfter']==self.report['sourceBefore'];self.report['status']='passed'
if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--serial',required=True);p.add_argument('--suite',choices=['config','notify'],required=True)
 for name in ['build','apk','output']:p.add_argument('--'+name,type=Path,required=True)
 a=p.parse_args();j=Journey(a)
 try:j.run()
 except Exception as error:
  j.report.update(status='failed',error=str(error))
  try:j.capture('failure')
  except Exception:pass
  raise
 finally:(a.output/'result.json').write_text(json.dumps(j.report,indent=2)+'\n')
