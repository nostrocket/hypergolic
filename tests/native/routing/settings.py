#!/usr/bin/env python3
"""Normal signed SDK/native handler settings, cold launch and saved-data evidence."""
import argparse,json,time
from pathlib import Path
from android import Journey,PACKAGE
from evidence import sha,sources
PUBLISHER='c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'
OTHER='c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'
class SettingsJourney(Journey):
 def launch(self):
  self.adb('shell','am','force-stop',PACKAGE);self.adb('shell','am','start','-W','-n',PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity');self.find('signed-caller-address')
 def focus(self,role):
  self.tap('handle-right');self.find('Loaded napplets');time.sleep(.6);self.tap('Open signed-routing-'+role+'-lab');time.sleep(.6);assert self.find('focused-napplet-name').get('text')=='signed-routing-'+role+'-lab'
 def data(self,label):self.guest_find(label);return json.loads(self.find(label).get('text'))
 def open_signed(self,role,domains):
  address=self.find('signed-'+role+'-address').get('content-desc');self.tap('shell-settings');self.enter_address(address);self.settings_tap('settings-open-napplet');self.settings_find('Allow this napplet?');self.settings_find('Requested access: '+domains);self.settings_tap('settings-napplet-approve');
  if role!='auto-peer':self.find('SDK ready for routing.')
  assert self.find('focused-napplet-name').get('text')=='signed-routing-'+role+'-lab'
 def approve_topic(self):self.find('Allow this topic?');self.find('napplet:note/open');self.capture('cold-handler-topic-review');self.tap('routing-approve');self.find('SDK ready for routing.')
 def close_peer(self):
  self.tap('handle-right');self.find('Loaded napplets');time.sleep(.6);self.tap('Close signed-routing-auto-peer-lab');self.tap('close-confirm');time.sleep(.6);self.tap('Open signed-routing-caller-lab');time.sleep(.6)
 def run(self):
  self.report.update(kind='hypergolic-android-routing-settings-v1',scope='Actual signed SDK Settings/default/removal/cold-launch/domain/identity journey; disposable local public identities; no physical/protected or remote claim.')
  build=json.loads(self.args.build.read_text());assert build['status']=='built' and build['sourceAfter']==sources()
  actual=self.adb('exec-out','cat',self.adb('shell','pm','path',PACKAGE).removeprefix('package:'),binary=True);assert sha(actual)==sha(self.args.apk.read_bytes())==build['productSha256'];self.report['installedApkSha256']=sha(actual)
  self.adb('shell','pm','clear',PACKAGE);self.launch();self.open_signed('auto-peer','inc, intent, storage');self.approve_topic();self.check('signed-cold-handler-domain-topic-consent')
  self.open_signed('caller','inc, intent');self.tap('shell-settings');key=PUBLISHER+'-signed-routing-auto-peer-lab';self.settings_tap('routing-default-note-'+key);self.settings_find('Default handler saved.');self.capture('trusted-default-settings');self.tap('settings-done');self.check('trusted-settings-explicit-default')
  changed=self.data('changed');assert changed['archetype']=='note' and changed['hasDefault'];self.report['defaultChanged']=changed;self.check('original-sdk-default-changed')
  self.close_peer();self.guest('Check availability');value=self.data('availability');assert value['available'] and value['hasDefault'] and value['candidates'][0]['dTag']=='signed-routing-auto-peer-lab';self.check('closed-handler-remains-discoverable')
  self.launch();self.find('SDK ready for routing.');self.guest('Check availability');value=self.data('availability');assert value['available'] and value['hasDefault'];self.report['coldAvailability']=value;self.capture('cold-default-availability');self.check('cold-process-default-persistence')
  self.guest('Invoke handler');self.find('Open with this napplet?');self.find('signed-routing-auto-peer-lab');self.tap('routing-approve');self.approve_topic();events=self.data('topic-events');assert len(events)==1 and events[0]['sender']=='signed-routing-caller-lab' and events[0]['payload']=={'text':'routing tracer + ⚡','nested':[None,False,3]};self.report['coldPayload']=events;self.capture('cold-target-exact-sdk-payload');self.check('cold-handler-fresh-topic-before-exact-delivery')
  self.focus('caller');self.find('Dispatch accepted.');assert self.data('intent-result')['ok'];self.check('cold-original-caller-sdk-result')
  self.focus('auto-peer');self.guest('Save routing data');self.find('Routing data saved.');self.check('original-sdk-data-written')
  self.focus('caller');self.tap('shell-settings');self.settings_tap('routing-remove-'+key);self.settings_find('Registration removed. Saved data remains.');self.capture('trusted-remove-registration');self.tap('settings-done');self.check('trusted-registration-removal')
  self.guest('Check availability');value=self.data('availability');assert value=={'archetype':'note','available':False,'candidates':[],'hasDefault':False};changed=self.data('changed');assert changed==value;self.report['removedChanged']=changed;self.check('removal-clears-default-and-original-sdk-availability')
  self.focus('auto-peer');self.guest('Read routing data');self.find('saved before registration removal');self.capture('original-sdk-data-after-removal');self.check('removal-preserves-original-sdk-data')
  self.close_peer();address=self.find('signed-auto-peer-address').get('content-desc');self.tap('shell-settings');self.enter_address(address);self.settings_tap('settings-open-napplet');self.approve_topic();self.guest('Read routing data');self.find('saved before registration removal');self.focus('caller');self.guest('Check availability');assert self.data('availability')['available'];self.check('ordinary-reopen-restores-registration-and-data')
  self.open_signed('no-routing','theme');self.guest('Invoke handler');self.guest_find('intent-status');assert self.find('intent-status').get('text').startswith('Request failed:');self.guest('Open channel');self.guest_find('channel-status');assert self.find('channel-status').get('text').startswith('Request failed:');self.capture('genuine-sdk-missing-domains');self.check('missing-domain-original-sdk-denial')
  self.tap('shell-settings');self.settings_tap('identity-select-'+OTHER);self.settings_find('Switch identity?');self.settings_tap('identity-change-confirm');self.find('shell-settings');self.tap('shell-settings');self.find('settings-full-npub');self.settings_find('routing-empty');self.capture('other-identity-empty-handler-catalog');self.check('native-identity-catalog-isolation')
  self.report['sourceAfter']=sources();assert self.report['sourceAfter']==self.report['sourceBefore'];self.report['status']='passed'
if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--serial',required=True)
 for name in ['build','apk','output']:p.add_argument('--'+name,type=Path,required=True)
 a=p.parse_args();j=SettingsJourney(a)
 try:j.run()
 except Exception as error:
  j.report.update(status='failed',error=str(error))
  try:j.capture('failure')
  except Exception:pass
  raise
 finally:(a.output/'result.json').write_text(json.dumps(j.report,indent=2)+'\n')
