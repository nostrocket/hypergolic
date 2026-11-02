#!/usr/bin/env python3
"""Original SDK, trusted configuration editor and native encrypted restart journey."""
import argparse,importlib.util,json,time,xml.etree.ElementTree as ET
from pathlib import Path
from evidence import ROOT,sha,sources
spec=importlib.util.spec_from_file_location('presentation_ui',ROOT/'tests/native/presentation/android.py');base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
PACKAGE=base.PACKAGE
TOKEN='public-config-test-token-20261004'
DEFAULTS={'theme':'dark','count':3,'enabled':True,'tags':['alpha'],'advanced':{'density':'comfortable'}}
class Journey(base.Journey):
 def read(self,label):
  self.guest_find(label);return self.data(label)
 def launch(self):
  self.adb('shell','am','force-stop',PACKAGE);self.adb('shell','am','start','-W','-n',PACKAGE+'/org.nostrocket.hypergolic.dev.MainActivity');self.find('signed-config-caller-address')
 def open_caller(self,first):
  address=self.find('signed-config-caller-address').get('content-desc');assert address.startswith('naddr1');self.tap('shell-settings');self.enter_address(address);self.settings_tap('settings-open-napplet')
  if first:
   self.settings_find('Allow this napplet?');self.settings_find('Requested access: config');self.capture('normal-config-domain-consent');self.settings_tap('settings-napplet-approve')
  self.find('SDK ready for routing.');assert self.find('focused-napplet-name').get('text')=='signed-config-caller-lab'
 def register(self):
  self.guest('Register configuration');self.find('Configuration schema accepted.')
 def get(self):
  # These are actual AX SDK reports; no input needs the report itself to be hittable.
  previous=self.data('config-read-count')['reads'];self.guest('Read configuration')
  for _ in range(40):
   read_count=self.data('config-read-count')['reads']
   if read_count>previous:
    value=self.data('config-result');self.report.setdefault('originalSDKConfigurationSnapshots',[]).append({'appId':self.find('focused-napplet-name').get('text'),'readCount':read_count,'values':value});return value
   time.sleep(.2)
  raise AssertionError('Original SDK read did not complete freshly')
 def run(self):
  self.report.update(kind='hypergolic-android-configuration-tracer-v1',scope='Signed local original SDK, trusted native editor, disposable explicitly supplied secret and same-version native SecureStore cold restart. Emulator only; no protected identity or physical-device acceptance.')
  build=json.loads(self.args.build.read_text());assert build['status']=='built' and build['sourceAfter']==sources()
  actual=self.adb('exec-out','cat',self.adb('shell','pm','path',PACKAGE).removeprefix('package:'),binary=True);assert sha(actual)==sha(self.args.apk.read_bytes())==build['productSha256'];self.report['installedApkSha256']=sha(actual)
  self.adb('shell','pm','clear',PACKAGE);self.launch();self.tap('qa-reset-config');self.find('Disposable configuration erased.');self.open_caller(True);self.check('signed-configuration-domain-admission')
  self.register();assert self.get()==DEFAULTS;self.capture('original-sdk-schema-defaults');self.check('positive-sdk-schema-ack-exact-defaults')
  self.guest('Subscribe configuration');assert self.read('config-events')==[DEFAULTS];self.check('original-sdk-initial-configuration-subscription')
  self.guest('Open configuration settings');self.find('Napplet configuration');self.find('signed-config-caller-lab');self.capture('trusted-native-configuration');self.settings_tap('config-choice-theme-1');self.settings_tap('config-secret-token');assert self.find('config-secret-token').get('password')=='true';self.adb('shell','input','text',TOKEN);self.adb('shell','input','keyevent','4');self.capture('masked-native-secret-input');assert TOKEN.encode() not in self.xml;self.check('trusted-editor-masks-explicit-secret')
  self.settings_tap('config-save');self.guest_find('config-events');expected={**DEFAULTS,'theme':'light','token':TOKEN};events=self.data('config-events',2);assert events==[DEFAULTS,expected];assert self.get()==expected;self.report['originalSDKValues']=expected;self.capture('original-sdk-explicit-configuration');self.check('trusted-save-original-sdk-live-values')
  raw=self.adb('exec-out','cat','/data/user/0/'+PACKAGE+'/shared_prefs/SecureStore.xml',binary=True);tree=ET.fromstring(raw);records=[json.loads(row.text) for row in tree if row.get('name','').startswith('org.nostrocket.hypergolic.napplet-config.v1-scope.')];assert len(records)==1 and TOKEN.encode() not in raw;record=records[0];assert record['scheme']=='aes' and record['ct'] and record['iv'] and record['tlen']>=96;self.report['encryptedRecord']={'fileSha256':sha(raw),'scheme':record['scheme'],'recordCount':len(records),'hasCiphertext':True,'plaintextMarkerAbsent':True};self.capture('encrypted-native-record-sdk-receipt');self.check('native-android-keystore-encrypted-config-record')
  self.launch();self.open_caller(False);self.register();assert self.get()==expected;self.capture('native-cold-restart-persisted-configuration');self.check('native-cold-restart-original-sdk-persistence')
  self.guest('Reject secret default schema');self.find('Request failed: Configuration schema was not applied.');self.guest('Reject pattern schema');self.find('Request failed: Configuration schema was not applied.');assert self.get()==expected;self.capture('rejected-schema-keeps-saved-values');self.check('negative-sdk-schema-ack-keeps-prior-configuration')
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
