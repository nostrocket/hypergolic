#!/usr/bin/env python3
"""Seal iOS installed products and independently check the original native SDK notification receipt."""
import argparse,json,plistlib,subprocess
from pathlib import Path
from evidence import ROOT,sha,sources,product
PACKAGE='org.nostrocket.hypergolic.presentationfixture'
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--device',required=True)
for name in ['build','app','output']:p.add_argument('--'+name,type=Path,required=True)
p.add_argument('--suite',choices=['config','notify'],required=True)
a=p.parse_args();a.output=a.output.resolve();a.output.mkdir(parents=True,exist_ok=False)
EXPECTED_CONFIG={'native-original-sdk-explicit-config-save-control','native-config-cancel-does-not-write','native-invalid-save-keeps-valid-values','native-background-revokes-unsaved-editor','native-different-app-secret-isolation','native-foreground-switch-retains-config-scope','native-forged-config-authority-and-push-denied','native-supported-depth-four-array-enum-carrier','native-schema-orphan-secret-is-purged','native-declined-update-keeps-config-hash-scope','native-accepted-new-hash-starts-fresh-config','native-explicit-secret-clear','native-config-matrix-live-positive-save'}
EXPECTED_NOTIFY={'native-badge-verified-source-attribution','native-general-grant-does-not-allow-named-channel','native-exact-channel-positive-sdk-send','native-permission-app-isolation-and-foreground-card-retention','native-forged-notification-authority-denied','native-background-clears-alerts-badges-no-backlog-keeps-exact-grant','native-settings-channel-revoke-denies-sdk-send','native-revoked-channel-needs-fresh-approval-positive-control','native-identity-change-has-no-old-grant-alert-or-recipient','native-close-clears-notification-recipient','native-oversized-notification-denied','native-sdk-notification-flood-bounded'}
EXPECTED=EXPECTED_CONFIG if a.suite=='config' else EXPECTED_NOTIFY
r={'kind':'hypergolic-ios-presentation-lifecycle-v1','status':'running','suite':a.suite,'checks':[],'scope':'Actual signed local original-SDK notification/configuration lifecycle and trusted native controls. No external publication or protected/physical claim.','sourceBefore':sources()}
try:
 build=json.loads(a.build.read_text());assert build['status']=='built' and build['platform']=='ios' and build['suite']=='published' and build['sourceAfter']==r['sourceBefore']
 installed=Path(subprocess.check_output(['xcrun','simctl','get_app_container',a.device,PACKAGE,'app'],text=True).strip())
 r['productFiles']=product(installed);assert r['productFiles']==build['productFiles']==product(a.app)
 r['buildSha256']=sha(a.build.read_bytes())
 project='tests/native/ios/XCTest/HypergolicUITests.xcodeproj';derived=a.output/'runner'
 command=['xcodebuild','build-for-testing','-project',project,'-scheme','HypergolicUITests','-destination','platform=iOS Simulator,id='+a.device,'-derivedDataPath',str(derived),'CODE_SIGNING_ALLOWED=NO']
 with (a.output/'runner-build.log').open('w') as log:subprocess.run(command,cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,check=True)
 manifests=list((derived/'Build/Products').glob('*.xctestrun'));assert len(manifests)==1
 command=['xcodebuild','test-without-building','-xctestrun',str(manifests[0]),'-destination','platform=iOS Simulator,id='+a.device,'-only-testing:HypergolicUITests/PresentationLifecycleTests/'+('testConfiguration' if a.suite=='config' else 'testNotifications'),'-parallel-testing-enabled','NO','-resultBundlePath',str(a.output/'journey.xcresult')]
 sdk=[];matrix=[]
 with (a.output/'journey.log').open('w') as log:
  process=subprocess.Popen(command,cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1)
  for line in process.stdout:
   log.write(line);log.flush()
   if 'PRESENTATION_CHECK:' in line:
    name=line.split('PRESENTATION_CHECK:',1)[1].strip();assert name in EXPECTED and name not in r['checks'];r['checks'].append(name);print('PASS '+name,flush=True)
   if 'PRESENTATION_LIVE_CLOSE:' in line:r['closedLiveSessionId']=line.split('PRESENTATION_LIVE_CLOSE:',1)[1].strip()
   for prefix in ['PRESENTATION_SDK:']:
    if prefix in line:sdk.append({'kind':prefix,'value':json.loads(line.split(prefix,1)[1])})
  code=process.wait();r['testExitCode']=code
 assert code==0 and set(r['checks'])==EXPECTED,'Native lifecycle matrix incomplete'
 r['matrixSDKResults']=matrix
 r['originalSDKResults']=sdk
 subprocess.run(['xcrun','xcresulttool','export','attachments','--path',str(a.output/'journey.xcresult'),'--output-path',str(a.output/'attachments')],check=True,stdout=subprocess.DEVNULL)
 r['attachments']=[{'path':str(p.relative_to(a.output)),'sha256':sha(p.read_bytes()),**({'visuallyInspected':False} if p.suffix.lower()=='.png' else {})} for p in sorted((a.output/'attachments').rglob('*')) if p.is_file()]
 assert product(installed)==r['productFiles'];r['sourceAfter']=sources();assert r['sourceAfter']==r['sourceBefore'];r['status']='passed'
 print('PASS sealed iOS signed notification tracer',flush=True)
except Exception as error:r.update(status='failed',error=str(error));raise
finally:(a.output/'result.json').write_text(json.dumps(r,indent=2)+'\n')
