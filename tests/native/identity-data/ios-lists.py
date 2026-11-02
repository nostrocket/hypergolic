#!/usr/bin/env python3
"""Seal iOS installed products and independently check original SDK list/badge receipts."""
import argparse,json,plistlib,subprocess
from pathlib import Path
from evidence import ROOT,sha,sources,product
PACKAGE='org.nostrocket.hypergolic.identitylistsfixture'
EXPECTED={'unknown-category-explicit-error', 'settings-revocation-blocks-fresh-cache', 'permission-app-isolation', 'permission-publisher-isolation', 'invalid-native-frames-no-cache-fallback', 'trusted-approve-public-mutes', 'native-queued-revoke-regrant-denial', 'actual-background-pending-denial', 'permission-account-isolation', 'accepted-badge-exact-signed-join', 'pending-owner-epoch-denial', 'older-validated-list-controlled-offline', 'trusted-decline-no-list-data', 'unsupported-blocks-deferred-zaps', 'global-interests-literal', 'signed-follows', 'cold-native-permission-and-cache', 'invalid-accepted-badge-no-cache-fallback', 'global-bookmarks-public-references', 'new-read-after-reapproval', 'global-pins-exact-mapping', 'signed-relay-preferences-data-only'}
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--device',required=True)
for name in ['sample','build','app','output']:p.add_argument('--'+name,type=Path,required=True)
a=p.parse_args();a.output=a.output.resolve();a.output.mkdir(parents=True,exist_ok=False)
r={'kind':'hypergolic-ios-identity-lists-v1','status':'running','checks':[],'scope':'Actual WK/SDK/native SQLite/trusted review and Settings; disposable signed diagnostic relay frames, not external WSS or protected identity switching.','sourceBefore':sources()}
try:
 sample=json.loads(a.sample.read_text());build=json.loads(a.build.read_text());assert build['status']=='built' and build['platform']=='ios' and build['suite']=='lists' and build['sourceAfter']==r['sourceBefore']
 installed=Path(subprocess.check_output(['xcrun','simctl','get_app_container',a.device,PACKAGE,'app'],text=True).strip())
 r['productFiles']=product(installed);assert r['productFiles']==build['productFiles']==product(a.app)
 r['sampleSha256']=sha(a.sample.read_bytes());r['buildSha256']=sha(a.build.read_bytes())
 project='tests/native/ios/XCTest/HypergolicUITests.xcodeproj';derived=a.output/'runner'
 command=['xcodebuild','build-for-testing','-project',project,'-scheme','HypergolicUITests','-destination','platform=iOS Simulator,id='+a.device,'-derivedDataPath',str(derived),'CODE_SIGNING_ALLOWED=NO']
 with (a.output/'runner-build.log').open('w') as log:subprocess.run(command,cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,check=True)
 manifests=list((derived/'Build/Products').glob('*.xctestrun'));assert len(manifests)==1
 doc=plistlib.loads(manifests[0].read_bytes())
 targets=[t for config in doc['TestConfigurations'] for t in config['TestTargets']] if 'TestConfigurations' in doc else [t for key,t in doc.items() if key!='__xctestrun_metadata__' and isinstance(t,dict) and 'TestBundlePath' in t]
 assert targets
 for target in targets:target.setdefault('EnvironmentVariables',{})['HG_IDENTITY_LISTS']=json.dumps(sample['expected'],separators=(',',':'))
 configured=manifests[0].parent/'IdentityLists.xctestrun';configured.write_bytes(plistlib.dumps(doc))
 command=['xcodebuild','test-without-building','-xctestrun',str(configured),'-destination','platform=iOS Simulator,id='+a.device,'-only-testing:HypergolicUITests/IdentityListsTests/testLists','-parallel-testing-enabled','NO','-resultBundlePath',str(a.output/'journey.xcresult')]
 sdk=[]
 with (a.output/'journey.log').open('w') as log:
  process=subprocess.Popen(command,cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1)
  for line in process.stdout:
   log.write(line);log.flush()
   if 'IDENTITY_LIST_CHECK:' in line:
    name=line.split('IDENTITY_LIST_CHECK:',1)[1].strip();assert name in EXPECTED and name not in r['checks'];r['checks'].append(name);print('PASS '+name,flush=True)
   if 'IDENTITY_LIST_SDK:' in line:
    key,value=line.split('IDENTITY_LIST_SDK:',1)[1].split(':',1);actual=json.loads(value);assert actual==sample['expected'][key];sdk.append({'key':key,'value':actual})
  code=process.wait();r['testExitCode']=code
 assert code==0 and set(r['checks'])==EXPECTED and len(sdk)==11,'Native public list journey incomplete'
 r['originalSDKResults']=sdk
 subprocess.run(['xcrun','xcresulttool','export','attachments','--path',str(a.output/'journey.xcresult'),'--output-path',str(a.output/'attachments')],check=True,stdout=subprocess.DEVNULL)
 r['attachments']=[{'path':str(p.relative_to(a.output)),'sha256':sha(p.read_bytes()),**({'visuallyInspected':False} if p.suffix.lower()=='.png' else {})} for p in sorted((a.output/'attachments').rglob('*')) if p.is_file()]
 assert product(installed)==r['productFiles'];r['sourceAfter']=sources();assert r['sourceAfter']==r['sourceBefore'];r['status']='passed'
 print('PASS sealed iOS public list native journey',flush=True)
except Exception as error:r.update(status='failed',error=str(error));raise
finally:
 if 'attachments' not in r and (a.output/'journey.xcresult').exists():
  try:
   subprocess.run(['xcrun','xcresulttool','export','attachments','--path',str(a.output/'journey.xcresult'),'--output-path',str(a.output/'attachments')],check=True,stdout=subprocess.DEVNULL)
   r['attachments']=[{'path':str(p.relative_to(a.output)),'sha256':sha(p.read_bytes())} for p in sorted((a.output/'attachments').rglob('*')) if p.is_file()]
  except Exception as exportError:r['attachmentExportError']=str(exportError)
 (a.output/'result.json').write_text(json.dumps(r,indent=2)+'\n')
