#!/usr/bin/env python3
"""Seal iOS installed products and independently check the original native SDK Outbox query receipt."""
import argparse,json,plistlib,subprocess
from pathlib import Path
from evidence import ROOT,sha,sources,product
PACKAGE='org.nostrocket.hypergolic.outboxfixture'
EXPECTED={'disjoint-native-wss-original-sdk','cold-native-sqlite-routing','native-missing-domain-no-transport','native-captured-owner-mismatch-no-transport','resolve-read-write-roles','resolve-write-read-roles','getEvent-exact-signed-id','getEvent-not-found','original-live-handle-full-plan','loaded-switch-preserves-stream-and-draft','native-background-fresh-plan-before-reconnect','original-close-stops-all-sockets','zero-backfill-public-live-after-ordinary-lease','changed-public-owner-revokes-old-handle','revoked-intent-does-not-return'}
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--device',required=True)
for name in ['sample','build','app','output']:p.add_argument('--'+name,type=Path,required=True)
a=p.parse_args();a.output=a.output.resolve();a.output.mkdir(parents=True,exist_ok=False)
r={'kind':'hypergolic-ios-outbox-reads-stream-v1','status':'running','checks':[],'scope':'Original SDK and native WSS discovery/data routes and cold SQLite cache; public-only fixture, no signing or published admission claim.','sourceBefore':sources()}
try:
 sample=json.loads(a.sample.read_text());build=json.loads(a.build.read_text());assert build['status']=='built' and build['platform']=='ios' and build['sourceAfter']==r['sourceBefore']
 subprocess.run(['xcrun','simctl','uninstall',a.device,PACKAGE],check=True) # Disposable public fixture only.
 subprocess.run(['xcrun','simctl','install',a.device,str(a.app)],check=True)
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
 for target in targets:target.setdefault('EnvironmentVariables',{})['HG_OUTBOX_SAMPLE']=json.dumps(sample,separators=(',',':'))
 configured=manifests[0].parent/'OutboxQuery.xctestrun';configured.write_bytes(plistlib.dumps(doc))
 command=['xcodebuild','test-without-building','-xctestrun',str(configured),'-destination','platform=iOS Simulator,id='+a.device,'-only-testing:HypergolicUITests/OutboxReadStreamTests/testReadLifecycle','-parallel-testing-enabled','NO','-resultBundlePath',str(a.output/'journey.xcresult')]
 sdk=[];reads=[];snapshots=[];live=None;observer=None;observerPath=a.output/'independent-public.json'
 with (a.output/'journey.log').open('w') as log:
  process=subprocess.Popen(command,cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1)
  for line in process.stdout:
   log.write(line);log.flush()
   if 'OUTBOX_START_OBSERVER' in line:
    assert observer is None
    observer=subprocess.Popen(['node',str(ROOT/'tests/native/feed-subscription/observe-public.mjs'),str(observerPath),'180000'],cwd=ROOT,stdout=subprocess.DEVNULL,stderr=(a.output/'observer.log').open('w'))
   if 'OUTBOX_READ:' in line:reads.append(json.loads(line.split('OUTBOX_READ:',1)[1]))
   if 'OUTBOX_NATIVE:' in line:snapshots.append(json.loads(line.split('OUTBOX_NATIVE:',1)[1]))
   if 'OUTBOX_LIVE:' in line:live=json.loads(line.split('OUTBOX_LIVE:',1)[1])
   if 'OUTBOX_CHECK:' in line:
    name=line.split('OUTBOX_CHECK:',1)[1].strip();assert name in EXPECTED and name not in r['checks'];r['checks'].append(name);print('PASS '+name,flush=True)
   if 'OUTBOX_SDK:' in line:
    actual=json.loads(line.split('OUTBOX_SDK:',1)[1]);assert len(actual['events'])==1 and actual['events'][0]['event']==sample['event'] and actual['events'][0]['sidecar']['relayHints'] and not actual.get('error');sdk.append(actual)
  code=process.wait();r['testExitCode']=code
 assert code==0 and set(r['checks'])==EXPECTED and len(sdk)==2,'Native Outbox query journey incomplete'
 r['originalSDKResults']=sdk;r['readSDKResults']=reads;r['streamSnapshots']=snapshots;r['liveSDKResult']=live
 assert observer is not None and live is not None
 import hashlib
 independent=json.loads(observerPath.read_text());known={row['id']:row for row in independent['events'] if row['afterEOSE']}
 matching=[row for row in live['events'] if row['event']['id'] in known];assert matching,'Actual native SDK post-EOSE events have no independent public observation'
 for row in matching:assert hashlib.sha256(row['event']['content'].encode()).hexdigest()==known[row['event']['id']]['contentSha256']
 r['independentPostEOSEIds']=[row['event']['id'] for row in matching]
 observer.terminate();observer.wait(timeout=10)
 subprocess.run(['xcrun','xcresulttool','export','attachments','--path',str(a.output/'journey.xcresult'),'--output-path',str(a.output/'attachments')],check=True,stdout=subprocess.DEVNULL)
 r['attachments']=[{'path':str(p.relative_to(a.output)),'sha256':sha(p.read_bytes()),**({'visuallyInspected':False} if p.suffix.lower()=='.png' else {})} for p in sorted((a.output/'attachments').rglob('*')) if p.is_file()]
 assert product(installed)==r['productFiles'];r['sourceAfter']=sources();assert r['sourceAfter']==r['sourceBefore'];r['status']='passed'
 print('PASS sealed iOS original SDK Outbox query journey',flush=True)
except Exception as error:r.update(status='failed',error=str(error));raise
finally:
 if 'observer' in locals() and observer and observer.poll() is None:observer.terminate();observer.wait(timeout=10)
 (a.output/'result.json').write_text(json.dumps(r,indent=2)+'\n')
