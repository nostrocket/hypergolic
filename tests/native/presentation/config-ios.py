#!/usr/bin/env python3
"""Seal iOS installed products and independently check the original native SDK configuration receipt."""
import argparse,json,subprocess
from pathlib import Path
from evidence import ROOT,sha,sources,product
PACKAGE='org.nostrocket.hypergolic.presentationfixture'
EXPECTED={'signed-configuration-domain-admission','positive-sdk-schema-ack-exact-defaults','original-sdk-initial-configuration-subscription','trusted-editor-masks-explicit-secret','trusted-save-original-sdk-live-values','native-cold-restart-original-sdk-persistence','negative-sdk-schema-ack-keeps-prior-configuration'}
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--device',required=True)
for name in ['build','app','output']:p.add_argument('--'+name,type=Path,required=True)
a=p.parse_args();a.output=a.output.resolve();a.output.mkdir(parents=True,exist_ok=False)
r={'kind':'hypergolic-ios-configuration-tracer-v1','status':'running','checks':[],'scope':'Signed local original SDK, trusted native editor, disposable explicitly supplied secret and same-version iOS Keychain cold restart. Simulator only; no protected identity or physical-device acceptance.','sourceBefore':sources()}
try:
 build=json.loads(a.build.read_text());assert build['status']=='built' and build['platform']=='ios' and build['suite']=='published' and build['sourceAfter']==r['sourceBefore']
 installed=Path(subprocess.check_output(['xcrun','simctl','get_app_container',a.device,PACKAGE,'app'],text=True).strip())
 r['productFiles']=product(installed);assert r['productFiles']==build['productFiles']==product(a.app)
 r['buildSha256']=sha(a.build.read_bytes())
 project='tests/native/ios/XCTest/HypergolicUITests.xcodeproj';derived=a.output/'runner'
 command=['xcodebuild','build-for-testing','-project',project,'-scheme','HypergolicUITests','-destination','platform=iOS Simulator,id='+a.device,'-derivedDataPath',str(derived),'CODE_SIGNING_ALLOWED=NO']
 with (a.output/'runner-build.log').open('w') as log:subprocess.run(command,cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,check=True)
 manifests=list((derived/'Build/Products').glob('*.xctestrun'));assert len(manifests)==1
 command=['xcodebuild','test-without-building','-xctestrun',str(manifests[0]),'-destination','platform=iOS Simulator,id='+a.device,'-only-testing:HypergolicUITests/ConfigurationTests/testTracer','-parallel-testing-enabled','NO','-resultBundlePath',str(a.output/'journey.xcresult')]
 sdk=[];platformPrompts=[]
 with (a.output/'journey.log').open('w') as log:
  process=subprocess.Popen(command,cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1)
  for line in process.stdout:
   log.write(line);log.flush()
   if 'CONFIG_CHECK:' in line:
    name=line.split('CONFIG_CHECK:',1)[1].strip();assert name in EXPECTED and name not in r['checks'];r['checks'].append(name);print('PASS '+name,flush=True)
   if 'CONFIG_PLATFORM_PROMPT_DECLINED:' in line:platformPrompts.append(line.split('CONFIG_PLATFORM_PROMPT_DECLINED:',1)[1].strip())
   for prefix in ['CONFIG_VALUES:']:
    if prefix in line:sdk.append({'kind':prefix,'value':json.loads(line.split(prefix,1)[1])})
  code=process.wait();r['testExitCode']=code
 assert code==0 and set(r['checks'])==EXPECTED and len(sdk)==6,'Native configuration tracer incomplete'
 data=Path(subprocess.check_output(['xcrun','simctl','get_app_container',a.device,PACKAGE,'data'],text=True).strip())
 token=b'public-config-test-token-20261004';scanned=[]
 for folder in ['Documents','Library']:
  for file in sorted((data/folder).rglob('*')):
   if file.is_file():
    assert token not in file.read_bytes(),'Plaintext config marker in application persistence: '+str(file.relative_to(data))
    scanned.append({'path':str(file.relative_to(data)),'sha256':sha(file.read_bytes())})
 r['appPersistencePlaintextScan']=scanned
 r['nativeStorageScope']='Actual iOS Keychain API same-version restart; dedicated device-only service verified in source. Simulator app persistence scan is not physical Keychain encryption proof.'
 r['declinedPlatformPrompts']=platformPrompts
 r['originalSDKResults']=sdk
 subprocess.run(['xcrun','xcresulttool','export','attachments','--path',str(a.output/'journey.xcresult'),'--output-path',str(a.output/'attachments')],check=True,stdout=subprocess.DEVNULL)
 r['attachments']=[{'path':str(p.relative_to(a.output)),'sha256':sha(p.read_bytes()),**({'visuallyInspected':False} if p.suffix.lower()=='.png' else {})} for p in sorted((a.output/'attachments').rglob('*')) if p.is_file()]
 assert product(installed)==r['productFiles'];r['sourceAfter']=sources();assert r['sourceAfter']==r['sourceBefore'];r['status']='passed'
 print('PASS sealed iOS signed configuration tracer',flush=True)
except Exception as error:r.update(status='failed',error=str(error));raise
finally:(a.output/'result.json').write_text(json.dumps(r,indent=2)+'\n')
