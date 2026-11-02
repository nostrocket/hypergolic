#!/usr/bin/env python3
"""Native original SDK absent/ambiguous routing conformance with signed publishers."""
import argparse,json,time
from pathlib import Path
from settings import SettingsJourney
from android import PACKAGE
from evidence import sha,sources
class ProtocolJourney(SettingsJourney):
 def field(self,label,value):
  self.guest_find(label);self.tap(label);self.adb('shell','input','keycombination','113','29');self.adb('shell','input','text',value);self.adb('shell','input','keyevent','4');self.guest_find(label);assert self.find(label).get('text')==value
 def run(self):
  self.report.update(kind='hypergolic-android-routing-protocol-v1',scope='Original SDK native absent handler/peer and signed cross-publisher dTag ambiguity; public disposable identities; no remote/physical/protected claim.')
  build=json.loads(self.args.build.read_text());assert build['status']=='built' and build['sourceAfter']==sources()
  actual=self.adb('exec-out','cat',self.adb('shell','pm','path',PACKAGE).removeprefix('package:'),binary=True);assert sha(actual)==sha(self.args.apk.read_bytes())==build['productSha256'];self.report['installedApkSha256']=sha(actual)
  self.adb('shell','pm','clear',PACKAGE);self.launch();self.open_signed('caller','inc, intent');self.guest('Invoke handler');self.find('Dispatch declined.');value=self.data('intent-result');assert value['ok']==False and value['handled']==False and value['error']=='no handler';assert not any(n.get('resource-id')=='routing-review' for n in self.nodes());self.report['absentSDKResult']=value;self.capture('native-absent-handler');self.check('native-absent-handler-original-sdk-result')
  self.guest('Open channel');self.find('Request failed: peer unavailable');self.guest('List channels');assert self.data('channel-info')==[];self.check('native-absent-peer-original-sdk-denial')
  self.open_signed('peer','inc, intent');self.guest('Subscribe to topic');self.find('Allow this topic?');self.tap('routing-approve');self.focus('caller');self.guest('Emit topic payload');self.focus('peer');events=self.data('topic-events');assert events==[{'topic':'napplet:note/open','sender':'signed-routing-caller-lab','payload':{'text':'routing tracer + ⚡','nested':[None,False,3]}}];self.report['positiveSDKEvents']=events;self.capture('native-protocol-positive-delivery');self.check('native-protocol-negative-controls-positive-delivery')
  address=self.find('signed-collision-peer-address').get('content-desc');self.tap('shell-settings');self.enter_address(address);self.settings_tap('settings-open-napplet');self.settings_find('Allow this napplet?');self.settings_find('Requested access: inc, intent');self.settings_tap('settings-napplet-approve');self.find('SDK ready for routing.');self.focus('caller');self.field('handler','signed-routing-peer-lab');self.guest('Invoke handler');self.find('Dispatch declined.');value=self.data('intent-result');assert value['ok']==False and value['handled']==False and value['error']=='ambiguous handler';assert not any(n.get('resource-id')=='routing-review' for n in self.nodes());self.report['ambiguousSDKResult']=value;self.capture('native-cross-publisher-ambiguity');self.check('native-ambiguous-publisher-original-sdk-result')
  self.guest('Open channel');self.find('Request failed: peer unavailable');self.guest('List channels');assert self.data('channel-info')==[];self.check('native-ambiguous-live-peer-original-sdk-denial')
  self.report['sourceAfter']=sources();assert self.report['sourceAfter']==self.report['sourceBefore'];self.report['status']='passed'
if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--serial',required=True)
 for name in ['build','apk','output']:p.add_argument('--'+name,type=Path,required=True)
 a=p.parse_args();j=ProtocolJourney(a)
 try:j.run()
 except Exception as error:
  j.report.update(status='failed',error=str(error))
  try:j.capture('failure')
  except Exception:pass
  raise
 finally:(a.output/'result.json').write_text(json.dumps(j.report,indent=2)+'\n')
