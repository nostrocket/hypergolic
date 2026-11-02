#!/usr/bin/env python3
"""Seal iOS installed products and independently check the original native SDK link receipt."""
import argparse,json,plistlib,subprocess
from pathlib import Path
from evidence import ROOT,sha,sources,product
PACKAGE='org.nostrocket.hypergolic.linkpublishedfixture'
EXPECTED={'domain-consent-decline-no-host','signed-resource-normal-admission','signed-native-cancel','signed-actual-os-handoff-return','each-opening-needs-new-review','cold-grant-retained-new-review-required','normal-confirmed-identity-fresh-review','missing-link-domain-cannot-open'}
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--device',required=True)
for name in ['build','app','output']:p.add_argument('--'+name,type=Path,required=True)
a=p.parse_args();a.output=a.output.resolve();a.output.mkdir(parents=True,exist_ok=False)
r={'kind':'hypergolic-ios-link-published-v1','status':'running','checks':[],'scope':'Actual normal signed local Resource Lab, WK/SDK/native review, Safari handoff/return and public identity transition. No external publication or protected/physical claim.','sourceBefore':sources()}
try:
 build=json.loads(a.build.read_text());assert build['status']=='built' and build['platform']=='ios' and build['suite']=='published' and build['sourceAfter']==r['sourceBefore']
 installed=Path(subprocess.check_output(['xcrun','simctl','get_app_container',a.device,PACKAGE,'app'],text=True).strip())
 r['productFiles']=product(installed);assert r['productFiles']==build['productFiles']==product(a.app)
 r['buildSha256']=sha(a.build.read_bytes())
 project='tests/native/ios/XCTest/HypergolicUITests.xcodeproj';derived=a.output/'runner'
 command=['xcodebuild','build-for-testing','-project',project,'-scheme','HypergolicUITests','-destination','platform=iOS Simulator,id='+a.device,'-derivedDataPath',str(derived),'CODE_SIGNING_ALLOWED=NO']
 with (a.output/'runner-build.log').open('w') as log:subprocess.run(command,cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,check=True)
 manifests=list((derived/'Build/Products').glob('*.xctestrun'));assert len(manifests)==1
 command=['xcodebuild','test-without-building','-xctestrun',str(manifests[0]),'-destination','platform=iOS Simulator,id='+a.device,'-only-testing:HypergolicUITests/LinkPublishedTests/'+('testAdmission'),'-parallel-testing-enabled','NO','-resultBundlePath',str(a.output/'journey.xcresult')]
 sdk=[];matrix=[]
 with (a.output/'journey.log').open('w') as log:
  process=subprocess.Popen(command,cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1)
  for line in process.stdout:
   log.write(line);log.flush()
   if 'LINK_PUBLISHED_CHECK:' in line:
    name=line.split('LINK_PUBLISHED_CHECK:',1)[1].strip();assert name in EXPECTED and name not in r['checks'];r['checks'].append(name);print('PASS '+name,flush=True)
   if 'LINK_MATRIX_SDK_RESULT:' in line:matrix.append(json.loads(line.split('LINK_MATRIX_SDK_RESULT:',1)[1]))
   if 'LINK_PUBLISHED_SDK:' in line:
    actual=json.loads(line.split('LINK_PUBLISHED_SDK:',1)[1]);sdk.append(actual)
  code=process.wait();r['testExitCode']=code
 assert code==0 and set(r['checks'])==EXPECTED and sdk==[{'status':'denied'},{'status':'opened'},{'status':'denied'},{'status':'denied'},{'status':'denied'}],'Native link tracer incomplete'
 r['matrixSDKResults']=matrix
 r['originalSDKResults']=sdk
 subprocess.run(['xcrun','xcresulttool','export','attachments','--path',str(a.output/'journey.xcresult'),'--output-path',str(a.output/'attachments')],check=True,stdout=subprocess.DEVNULL)
 r['attachments']=[{'path':str(p.relative_to(a.output)),'sha256':sha(p.read_bytes()),**({'visuallyInspected':False} if p.suffix.lower()=='.png' else {})} for p in sorted((a.output/'attachments').rglob('*')) if p.is_file()]
 assert product(installed)==r['productFiles'];r['sourceAfter']=sources();assert r['sourceAfter']==r['sourceBefore'];r['status']='passed'
 print('PASS sealed iOS signed link admission',flush=True)
except Exception as error:r.update(status='failed',error=str(error));raise
finally:(a.output/'result.json').write_text(json.dumps(r,indent=2)+'\n')
