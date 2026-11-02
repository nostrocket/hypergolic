#!/usr/bin/env python3
"""Sealed iOS native presentation/input proof; no signing or publication."""
import argparse,json,subprocess
from pathlib import Path
from evidence import ROOT,sha,sources,product
PACKAGE='org.nostrocket.hypergolic.outboxreviewfixture'
EXPECTED={'presentation-only-launch','exact-event-identity','exact-destinations-origins','existing-list-review','exact-primary-template','primary-success-independent-list','separate-list-rejected-cancelled','required-inbox-unknown-failure'}
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--device',required=True)
for name in ['build','app','output']:p.add_argument('--'+name,type=Path,required=True)
a=p.parse_args();a.output=a.output.resolve();a.output.mkdir(parents=True,exist_ok=False)
r={'kind':'hypergolic-ios-outbox-review-v1','status':'running','checks':[],'scope':__doc__,'sourceBefore':sources()}
try:
 build=json.loads(a.build.read_text());assert build['status']=='built' and build['platform']=='ios' and build['suite']=='review' and build['sourceAfter']==r['sourceBefore']
 subprocess.run(['xcrun','simctl','install',a.device,str(a.app)],check=True)
 installed=Path(subprocess.check_output(['xcrun','simctl','get_app_container',a.device,PACKAGE,'app'],text=True).strip())
 r['productFiles']=product(installed);assert r['productFiles']==build['productFiles']==product(a.app);r['buildSha256']=sha(a.build.read_bytes())
 derived=a.output/'runner';command=['xcodebuild','build-for-testing','-project','tests/native/ios/XCTest/HypergolicUITests.xcodeproj','-scheme','HypergolicUITests','-destination','platform=iOS Simulator,id='+a.device,'-derivedDataPath',str(derived),'CODE_SIGNING_ALLOWED=NO']
 with (a.output/'runner-build.log').open('w') as log:subprocess.run(command,cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,check=True)
 manifests=list((derived/'Build/Products').glob('*.xctestrun'));assert len(manifests)==1
 command=['xcodebuild','test-without-building','-xctestrun',str(manifests[0]),'-destination','platform=iOS Simulator,id='+a.device,'-only-testing:HypergolicUITests/OutboxReviewPresentationTests/testReviewAndReceipts','-parallel-testing-enabled','NO','-resultBundlePath',str(a.output/'journey.xcresult')]
 with (a.output/'journey.log').open('w') as log:
  process=subprocess.Popen(command,cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1)
  for line in process.stdout:
   log.write(line);log.flush()
   if 'OUTBOX_REVIEW_CHECK:' in line:
    name=line.split('OUTBOX_REVIEW_CHECK:',1)[1].strip();assert name in EXPECTED and name not in r['checks'];r['checks'].append(name);print('PASS '+name,flush=True)
  code=process.wait();r['testExitCode']=code
 assert code==0 and set(r['checks'])==EXPECTED,'Native review journey incomplete'
 subprocess.run(['xcrun','xcresulttool','export','attachments','--path',str(a.output/'journey.xcresult'),'--output-path',str(a.output/'attachments')],check=True,stdout=subprocess.DEVNULL)
 r['attachments']=[{'path':str(p.relative_to(a.output)),'sha256':sha(p.read_bytes()),**({'visuallyInspected':False} if p.suffix.lower()=='.png' else {})} for p in sorted((a.output/'attachments').rglob('*')) if p.is_file()]
 assert product(installed)==r['productFiles'];r['sourceAfter']=sources();assert r['sourceAfter']==r['sourceBefore'];r['status']='passed'
except Exception as error:r.update(status='failed',error=str(error));raise
finally:(a.output/'result.json').write_text(json.dumps(r,indent=2)+'\n')
