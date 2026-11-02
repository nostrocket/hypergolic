#!/usr/bin/env python3
"""Independent native XCTest/TLS/disk witness for the actual loaded-napplet queue bounds."""
import argparse,json,subprocess,time
from pathlib import Path
from evidence import ROOT,sha,sources,product,large_wav,recovery_records
PACKAGE='org.nostrocket.hypergolic.uploadfixture';HASH='5a852fbaaaecaf4cd14c01e150c7f881c5c5894b0a1e3c53be7e007c58374ee6'
p=argparse.ArgumentParser(description=__doc__)
for n in ['device','app','build','observer','output']:p.add_argument('--'+n,required=True,type=str if n=='device' else Path)
a=p.parse_args();a.output.mkdir(parents=True,exist_ok=False)
r={'kind':'hypergolic-ios-upload-queue-v1','status':'running','checks':[],'sourceBefore':sources(),'scope':'Actual disposable SDK/native Simulator two held transfers, eight queued realms and ninth/per-realm denial. Private TLS and metadata disk witness; no protected/public-provider acceptance.'}
def observer():return json.loads(a.observer.read_text())
def control(release=False):
    path=a.observer.parent/'control.json';tmp=path.with_suffix('.tmp');tmp.write_text(json.dumps({'put':'hold','get':'normal','release':release}));tmp.replace(path)
def count(n):
    deadline=time.monotonic()+15
    while time.monotonic()<deadline:
        v=observer()
        if len(v['requests'])==len(baseline['requests'])+n:return v
        time.sleep(.1)
    raise AssertionError('Missing independently stored approved body')
try:
    b=json.loads(a.build.read_text());assert b['status']=='built' and b['sourceAfter']==r['sourceBefore'] and b['productFiles']==product(a.app)
    installed=Path(subprocess.check_output(['xcrun','simctl','get_app_container',a.device,PACKAGE,'app'],text=True).strip());assert product(installed)==b['productFiles'];r['productFiles']=b['productFiles'];baseline=observer();r['observerBefore']=baseline;control();complete=False;held=None
    command=['xcodebuild','test','-project','tests/native/ios/XCTest/HypergolicUITests.xcodeproj','-scheme','HypergolicUITests','-destination','platform=iOS Simulator,id='+a.device,'-only-testing:HypergolicUITests/UploadTests/testUploadQueueBounds','-derivedDataPath',str(a.output/'build'),'-resultBundlePath',str(a.output/'journey.xcresult'),'CODE_SIGNING_ALLOWED=NO']
    with (a.output/'journey.log').open('w') as log:
        process=subprocess.Popen(command,cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1)
        for line in process.stdout:
            log.write(line);log.flush()
            if 'QUEUE_' not in line:continue
            marker=line.strip().split('QUEUE_',1)[1]
            if marker=='FIRST_APPROVED':count(1)
            elif marker=='SECOND_APPROVED':count(2)
            elif marker=='HELD':
                held=count(2);assert len(held['putAttempts'])==len(baseline['putAttempts'])+2 and {v['sha256'] for v in held['requests'][-2:]}=={HASH,sha(large_wav())} and all(v['signatureVerified'] for v in held['requests'][-2:]);r['checks'].append('two approved exact PUTs and eight real queued realms')
            elif marker in ['REALM_BOUND','OVERFLOW']:assert observer()==held;r['checks'].append(marker+' before any extra network')
            elif marker=='RELEASE':control(True)
            elif marker=='CANCELLED':
                root=Path(subprocess.check_output(['xcrun','simctl','get_app_container',a.device,PACKAGE,'data'],text=True).strip());path=root/'Library/Application Support/UploadRecovery-v1/ledger.bin';data=path.read_bytes();rows=recovery_records(data);assert len(rows)==2 and all(v['state']=='unknown' for v in rows);(a.output/'cancelled-ledger.bin').write_bytes(data);r['disk']=rows;r['checks'].append('both trusted cancels preserve eight queued reviews and uncertainty')
            elif marker=='COMPLETE':complete=True;r['checks'].append('actual Home permanently revokes all eight queued reviews')
            print('Witnessed '+marker,flush=True)
        code=process.wait()
    assert code==0 and complete and len(r['checks'])==5
    v=observer();assert len(v['requests'])==len(held['requests']) and len(v['putAttempts'])==len(held['putAttempts']) and len(v['gets'])==len(baseline['gets']) and not v['errors'];r['observerAfter']=v;r['sourceAfter']=sources();assert r['sourceBefore']==r['sourceAfter'];r['status']='passed'
except Exception as e:r.update(status='failed',error=str(e));raise
finally:control(True);(a.output/'result.json').write_text(json.dumps(r,indent=2)+'\n')
