#!/usr/bin/env python3
"""Seal iOS installed products and independently check the original native SDK routing receipt."""
import argparse,json,plistlib,subprocess
from pathlib import Path
from evidence import ROOT,sha,sources,product
PACKAGE='org.nostrocket.hypergolic.routingfixture'
EXPECTED={'signed-peer-normal-admission','exact-topic-session-approval','signed-caller-normal-admission','verified-handler-availability','dispatch-cancel-original-sdk-result','approved-dispatch-real-target-exact-payload','original-caller-structured-sdk-result','foreground-topic-switch-exact-sender-no-echo','symmetric-topic-payload','new-channel-trusted-endpoint-review','target-original-sdk-inbound-handle','peer-channel-message-exact-payload','symmetric-channel-broadcast','original-sdk-late-terminal-record','symmetric-close-empty-list','fresh-channel-needs-new-review','native-background-closes-without-reopening','native-deadline-revokes-unanswered-dispatch','expired-review-delivers-no-payload','native-review-flood-has-no-approved-channel','native-guest-forged-sender-and-control-denied','native-third-view-cannot-use-active-channel-id','native-negative-controls-have-live-positive-ping','native-peer-close-revokes-channel'}
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--device',required=True);p.add_argument('--suite',choices=['tracer','settings','protocol'],default='tracer')
for name in ['build','app','output']:p.add_argument('--'+name,type=Path,required=True)
a=p.parse_args();a.output=a.output.resolve();a.output.mkdir(parents=True,exist_ok=False)
if a.suite=='settings':EXPECTED={'signed-cold-handler-domain-topic-consent','trusted-settings-explicit-default','original-sdk-default-changed','closed-handler-remains-discoverable','cold-process-default-persistence','cold-handler-fresh-topic-before-exact-delivery','cold-original-caller-sdk-result','original-sdk-data-written','trusted-registration-removal','removal-clears-default-and-original-sdk-availability','removal-preserves-original-sdk-data','ordinary-reopen-restores-registration-and-data','missing-domain-original-sdk-denial','native-identity-catalog-isolation'}
if a.suite=='protocol':EXPECTED={'native-absent-handler-original-sdk-result','native-absent-peer-original-sdk-denial','native-protocol-negative-controls-positive-delivery','native-ambiguous-publisher-original-sdk-result','native-ambiguous-live-peer-original-sdk-denial'}
r={'kind':'hypergolic-ios-routing-v1','status':'running','checks':[],'scope':'Actual signed local Routing Lab admission, WK/SDK/native dispatch review, exact payload delivery and original caller result. No external publication or protected/physical claim.','sourceBefore':sources()}
try:
 build=json.loads(a.build.read_text());assert build['status']=='built' and build['platform']=='ios' and build['suite']=='published' and build['sourceAfter']==r['sourceBefore']
 installed=Path(subprocess.check_output(['xcrun','simctl','get_app_container',a.device,PACKAGE,'app'],text=True).strip())
 r['productFiles']=product(installed);assert r['productFiles']==build['productFiles']==product(a.app)
 r['buildSha256']=sha(a.build.read_bytes())
 project='tests/native/ios/XCTest/HypergolicUITests.xcodeproj';derived=a.output/'runner'
 command=['xcodebuild','build-for-testing','-project',project,'-scheme','HypergolicUITests','-destination','platform=iOS Simulator,id='+a.device,'-derivedDataPath',str(derived),'CODE_SIGNING_ALLOWED=NO']
 with (a.output/'runner-build.log').open('w') as log:subprocess.run(command,cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,check=True)
 manifests=list((derived/'Build/Products').glob('*.xctestrun'));assert len(manifests)==1
 command=['xcodebuild','test-without-building','-xctestrun',str(manifests[0]),'-destination','platform=iOS Simulator,id='+a.device,'-only-testing:HypergolicUITests/RoutingTests/'+{'settings':'testSettings','tracer':'testTracer','protocol':'testProtocol'}[a.suite],'-parallel-testing-enabled','NO','-resultBundlePath',str(a.output/'journey.xcresult')]
 sdk=[];matrix=[]
 with (a.output/'journey.log').open('w') as log:
  process=subprocess.Popen(command,cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1)
  for line in process.stdout:
   log.write(line);log.flush()
   if 'ROUTING_CHECK:' in line:
    name=line.split('ROUTING_CHECK:',1)[1].strip();assert name in EXPECTED and name not in r['checks'];r['checks'].append(name);print('PASS '+name,flush=True)
   for prefix in ['ROUTING_PROTOCOL:','ROUTING_SETTINGS:','ROUTING_AVAILABILITY:','ROUTING_DENIED:','ROUTING_EVENTS:','ROUTING_RESULT:','ROUTING_TOPIC_PEER:','ROUTING_TOPIC_CALLER:','ROUTING_CHANNEL:','ROUTING_INBOUND:','ROUTING_CHANNEL_EVENTS:','ROUTING_BROADCAST:','ROUTING_CLOSED:','ROUTING_SYMMETRIC_CLOSED:','ROUTING_BACKGROUND:','ROUTING_AFTER_EXPIRY:','ROUTING_FLOOD:','ROUTING_AFTER_FORGED:','ROUTING_AFTER_FOREIGN:','ROUTING_POSITIVE_PING:','ROUTING_PEER_CLOSED:']:
    if prefix in line:sdk.append({'kind':prefix,'value':json.loads(line.split(prefix,1)[1])})
  code=process.wait();r['testExitCode']=code
 assert code==0 and set(r['checks'])==EXPECTED and len(sdk)=={'settings':7,'tracer':21,'protocol':3}[a.suite],'Native routing tracer incomplete'
 r['matrixSDKResults']=matrix
 r['originalSDKResults']=sdk
 subprocess.run(['xcrun','xcresulttool','export','attachments','--path',str(a.output/'journey.xcresult'),'--output-path',str(a.output/'attachments')],check=True,stdout=subprocess.DEVNULL)
 r['attachments']=[{'path':str(p.relative_to(a.output)),'sha256':sha(p.read_bytes()),**({'visuallyInspected':False} if p.suffix.lower()=='.png' else {})} for p in sorted((a.output/'attachments').rglob('*')) if p.is_file()]
 assert product(installed)==r['productFiles'];r['sourceAfter']=sources();assert r['sourceAfter']==r['sourceBefore'];r['status']='passed'
 print('PASS sealed iOS signed routing tracer',flush=True)
except Exception as error:r.update(status='failed',error=str(error));raise
finally:(a.output/'result.json').write_text(json.dumps(r,indent=2)+'\n')
