#!/usr/bin/env python3
"""Seal iOS installed products and independently check the original native SDK link receipt."""
import argparse,json,plistlib,subprocess
from pathlib import Path
from evidence import ROOT,sha,sources,product
PACKAGE='org.nostrocket.hypergolic.linkfixture'
EXPECTED={'actual-os-handoff-return','native-cancel','unsupported-http'}
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--device',required=True);p.add_argument('--matrix',action='store_true')
for name in ['build','app','output']:p.add_argument('--'+name,type=Path,required=True)
a=p.parse_args();a.output=a.output.resolve();a.output.mkdir(parents=True,exist_ok=False)
if a.matrix:EXPECTED.update({'pending-blur-revoked','pending-background-revoked','pending-close-revoked','pending-identity-revoked','pending-owner-pause-revoked','pending-timeout-revoked','global-single-review-flood','generation-review-rate-limit','native-invalid-url-profile'})
r={'kind':'hypergolic-ios-external-link-tracer-v1','status':'running','checks':[],'scope':'Actual public-only WK/SDK/native review and Safari handoff/return. No physical/protected/signed admission claim.','sourceBefore':sources()}
try:
 build=json.loads(a.build.read_text());assert build['status']=='built' and build['platform']=='ios' and build['sourceAfter']==r['sourceBefore']
 installed=Path(subprocess.check_output(['xcrun','simctl','get_app_container',a.device,PACKAGE,'app'],text=True).strip())
 r['productFiles']=product(installed);assert r['productFiles']==build['productFiles']==product(a.app)
 r['buildSha256']=sha(a.build.read_bytes())
 project='tests/native/ios/XCTest/HypergolicUITests.xcodeproj';derived=a.output/'runner'
 command=['xcodebuild','build-for-testing','-project',project,'-scheme','HypergolicUITests','-destination','platform=iOS Simulator,id='+a.device,'-derivedDataPath',str(derived),'CODE_SIGNING_ALLOWED=NO']
 with (a.output/'runner-build.log').open('w') as log:subprocess.run(command,cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,check=True)
 manifests=list((derived/'Build/Products').glob('*.xctestrun'));assert len(manifests)==1
 command=['xcodebuild','test-without-building','-xctestrun',str(manifests[0]),'-destination','platform=iOS Simulator,id='+a.device,'-only-testing:HypergolicUITests/LinkTests/'+('testFull' if a.matrix else 'testTracer'),'-parallel-testing-enabled','NO','-resultBundlePath',str(a.output/'journey.xcresult')]
 sdk=[];matrix=[]
 with (a.output/'journey.log').open('w') as log:
  process=subprocess.Popen(command,cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1)
  for line in process.stdout:
   log.write(line);log.flush()
   if 'LINK_CHECK:' in line:
    name=line.split('LINK_CHECK:',1)[1].strip();assert name in EXPECTED and name not in r['checks'];r['checks'].append(name);print('PASS '+name,flush=True)
   if 'LINK_MATRIX_SDK_RESULT:' in line:matrix.append(json.loads(line.split('LINK_MATRIX_SDK_RESULT:',1)[1]))
   if 'LINK_SDK_RESULT:' in line:
    actual=json.loads(line.split('LINK_SDK_RESULT:',1)[1]);sdk.append(actual)
  code=process.wait();r['testExitCode']=code
 assert code==0 and set(r['checks'])==EXPECTED and sdk==[{'status':'opened'},{'status':'denied'},{'status':'denied'}],'Native link tracer incomplete'
 if a.matrix:assert matrix==[{'status':'denied'}]*5+[[{'status':'denied'}]*4]+[{'status':'denied'}]*7,'Independent matrix SDK receipts differ'
 r['matrixSDKResults']=matrix
 r['originalSDKResults']=sdk
 subprocess.run(['xcrun','xcresulttool','export','attachments','--path',str(a.output/'journey.xcresult'),'--output-path',str(a.output/'attachments')],check=True,stdout=subprocess.DEVNULL)
 r['attachments']=[{'path':str(p.relative_to(a.output)),'sha256':sha(p.read_bytes()),**({'visuallyInspected':False} if p.suffix.lower()=='.png' else {})} for p in sorted((a.output/'attachments').rglob('*')) if p.is_file()]
 assert product(installed)==r['productFiles'];r['sourceAfter']=sources();assert r['sourceAfter']==r['sourceBefore'];r['status']='passed'
 print('PASS sealed iOS external-link native tracer',flush=True)
except Exception as error:r.update(status='failed',error=str(error));raise
finally:(a.output/'result.json').write_text(json.dumps(r,indent=2)+'\n')
