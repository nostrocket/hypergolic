#!/usr/bin/env python3
"""Seal normal signed iOS admission and independently check original SDK identity receipts."""
import argparse,json,plistlib,subprocess
from pathlib import Path
from evidence import ROOT,sha,sources,product
PACKAGE='org.nostrocket.hypergolic.identitypublishedfixture'
EXPECTED={'signed-feed-explicit-follows-no-routing-change', 'normal-confirmed-identity-isolates-permission', 'signed-state-selected-follows', 'signed-feed-normal-admission', 'return-to-identity-restores-own-permission', 'signed-state-normal-admission', 'normal-settings-revoke-blocks-cache', 'cold-signed-grant-and-older-offline-cache', 'normal-confirmed-identity-isolates-source', 'domain-consent-decline-no-identity-query', 'stale-cache-bounded-refresh', 'separate-list-decline', 'separate-list-approval-exact-source', 'remembered-same-app-list-access'}
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--device',required=True)
for name in ['sample','build','app','output']:p.add_argument('--'+name,type=Path,required=True)
a=p.parse_args();a.output=a.output.resolve();a.output.mkdir(parents=True,exist_ok=False)
r={'kind':'hypergolic-ios-identity-published-v1','status':'running','checks':[],'scope':'Actual normal IdentityShell/Settings/signed admission/SDK/native SQLite and confirmed public-only identity transition. Local signed artifacts and diagnostic relay frames; no external transport/protected-device claim.','sourceBefore':sources()}
try:
 sample=json.loads(a.sample.read_text());build=json.loads(a.build.read_text());assert build['status']=='built' and build['platform']=='ios' and build['suite']=='published' and build['sourceAfter']==r['sourceBefore']
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
 for target in targets:target.setdefault('EnvironmentVariables',{})['HG_IDENTITY_FIXTURE']=json.dumps(sample,separators=(',',':'))
 configured=manifests[0].parent/'IdentityPublished.xctestrun';configured.write_bytes(plistlib.dumps(doc))
 command=['xcodebuild','test-without-building','-xctestrun',str(configured),'-destination','platform=iOS Simulator,id='+a.device,'-only-testing:HypergolicUITests/IdentityPublishedTests/testAdmission','-parallel-testing-enabled','NO','-resultBundlePath',str(a.output/'journey.xcresult')]
 sdk=[]
 with (a.output/'journey.log').open('w') as log:
  process=subprocess.Popen(command,cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1)
  for line in process.stdout:
   log.write(line);log.flush()
   if 'IDENTITY_PUBLISHED_CHECK:' in line:
    name=line.split('IDENTITY_PUBLISHED_CHECK:',1)[1].strip();assert name in EXPECTED and name not in r['checks'];r['checks'].append(name);print('PASS '+name,flush=True)
   if 'IDENTITY_PUBLISHED_SDK:' in line:
    key,value=line.split('IDENTITY_PUBLISHED_SDK:',1)[1].split(':',1);actual=json.loads(value);assert actual==([] if key=='other-follows' else sample['expected'][key]);sdk.append({'key':key,'value':actual})
  code=process.wait();r['testExitCode']=code
 assert code==0 and set(r['checks'])==EXPECTED and len(sdk)==9,'Native signed admission journey incomplete'
 r['originalSDKResults']=sdk
 subprocess.run(['xcrun','xcresulttool','export','attachments','--path',str(a.output/'journey.xcresult'),'--output-path',str(a.output/'attachments')],check=True,stdout=subprocess.DEVNULL)
 r['attachments']=[{'path':str(p.relative_to(a.output)),'sha256':sha(p.read_bytes()),**({'visuallyInspected':False} if p.suffix.lower()=='.png' else {})} for p in sorted((a.output/'attachments').rglob('*')) if p.is_file()]
 assert product(installed)==r['productFiles'];r['sourceAfter']=sources();assert r['sourceAfter']==r['sourceBefore'];r['status']='passed'
 print('PASS sealed iOS signed admission native journey',flush=True)
except Exception as error:r.update(status='failed',error=str(error));raise
finally:
 if 'attachments' not in r and (a.output/'journey.xcresult').exists():
  try:
   subprocess.run(['xcrun','xcresulttool','export','attachments','--path',str(a.output/'journey.xcresult'),'--output-path',str(a.output/'attachments')],check=True,stdout=subprocess.DEVNULL)
   r['attachments']=[{'path':str(p.relative_to(a.output)),'sha256':sha(p.read_bytes())} for p in sorted((a.output/'attachments').rglob('*')) if p.is_file()]
  except Exception as exportError:r['attachmentExportError']=str(exportError)
 (a.output/'result.json').write_text(json.dumps(r,indent=2)+'\n')
