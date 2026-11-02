#!/usr/bin/env python3
"""Actual XCTest recovery inputs with an independent provider and metadata disk witness."""
import argparse,json,subprocess,time
from pathlib import Path
from evidence import ROOT,sha,sources,product,recovery_records
PACKAGE='org.nostrocket.hypergolic.uploadfixture';HASH='5a852fbaaaecaf4cd14c01e150c7f881c5c5894b0a1e3c53be7e007c58374ee6'
p=argparse.ArgumentParser(description=__doc__)
for name in ['device','app','build','observer','output']:p.add_argument('--'+name,required=True,type=str if name=='device' else Path)
args=p.parse_args();args.output.mkdir(parents=True,exist_ok=False)
report={'kind':'hypergolic-ios-recovery-v1','status':'running','checks':[],'disk':[],'sourceBefore':sources(),'scope':'Actual isolated SDK/native Simulator lost ACK, metadata disk/cold restart, fresh loopback GET, lifecycle and two loaded hosts. Public disposable identity; no protected or public provider acceptance.'}
def observer():return json.loads(args.observer.read_text())
def control(put='normal',get='normal',release=False):
    path=args.observer.parent/'control.json';temporary=path.with_suffix('.tmp');temporary.write_text(json.dumps({'put':put,'get':get,'release':release}));temporary.replace(path)
def wait(key,count):
    deadline=time.monotonic()+10
    while time.monotonic()<deadline:
        value=observer()
        if len(value[key])>=count:return value
        time.sleep(.1)
    raise AssertionError('Observer checkpoint not reached: '+key)
def disk(name):
    root=Path(subprocess.check_output(['xcrun','simctl','get_app_container',args.device,PACKAGE,'data'],text=True).strip())
    path=root/'Library/Application Support/UploadRecovery-v1/ledger.bin';value=path.read_bytes();rows=recovery_records(value)
    (args.output/(name+'.bin')).write_bytes(value);(args.output/(name+'.json')).write_text(json.dumps(rows,indent=2)+'\n')
    report['disk'].append({'name':name,'sha256':sha(value),'rows':rows,'mode':oct(path.stat().st_mode&0o777),'directoryMode':oct(path.parent.stat().st_mode&0o777)})
    assert path.stat().st_mode&0o777==0o600 and path.parent.stat().st_mode&0o777==0o700
    assert rows and all(row['identity']=='79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798' and row['publisher']=='f'*64 and row['appId']=='upload-lab' and row['destination']=='https://files.example.com:19943' for row in rows)
    return rows
try:
    build=json.loads(args.build.read_text());assert build['status']=='built' and build['platform']=='ios' and build['sourceAfter']==report['sourceBefore'] and build['productFiles']==product(args.app)
    installed=Path(subprocess.check_output(['xcrun','simctl','get_app_container',args.device,PACKAGE,'app'],text=True).strip());assert product(installed)==product(args.app)
    report['productFiles']=product(args.app);baseline=observer();report['observerBefore']=baseline;control(put='lost-ack');saved=None;seen=[]
    command=['xcodebuild','test','-project','tests/native/ios/XCTest/HypergolicUITests.xcodeproj','-scheme','HypergolicUITests','-destination','platform=iOS Simulator,id='+args.device,'-only-testing:HypergolicUITests/UploadTests/testInterruptedUploadRecovery','-derivedDataPath',str(args.output/'build'),'-resultBundlePath',str(args.output/'journey.xcresult'),'CODE_SIGNING_ALLOWED=NO']
    with (args.output/'journey.log').open('w') as log:
        process=subprocess.Popen(command,cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1)
        for line in process.stdout:
            log.write(line);log.flush()
            if 'RECOVERY_' not in line:continue
            marker=line.strip().split('RECOVERY_',1)[1];seen.append(marker);value=observer()
            if marker.startswith('MODE:'):
                mode=marker.split(':',1)[1];control(put='hold' if mode=='put-hold' else 'normal',get='normal' if mode=='put-hold' else mode)
            elif marker=='REJECT':assert value==baseline;report['checks'].append('rejection-zero-TLS')
            elif marker=='LOST_ACK':
                assert len(value['requests'])==len(baseline['requests'])+1 and value['requests'][-1]['sha256']==HASH and value['requests'][-1]['size']==71 and value['requests'][-1]['signatureVerified'];saved=disk('lost-ack');assert len(saved)==1 and saved[0]['state']=='unknown'
            elif marker in ['COLD_RESTART','DUPLICATE_BLOCKED']:
                assert disk(marker.lower())==saved and len(value['gets'])==len(baseline['gets']) and len(value['putAttempts'])==len(baseline['putAttempts'])+1;report['checks'].append(marker.lower())
            elif marker.startswith('CHECKED:'):
                mode=marker.split(':',1)[1];assert disk('check-'+mode)==saved and value['gets'][-1]['target']=='/'+HASH and value['gets'][-1]['authorization'] is False and len(value['putAttempts'])==len(baseline['putAttempts'])+1;report['checks'].append(mode+'-remains-unknown')
            elif marker=='CHECK_HELD':wait('gets',len(baseline['gets'])+5)
            elif marker=='BACKGROUND':control(get='hold',release=True)
            elif marker=='BACKGROUND_RETURN':assert disk('background-read')==saved;report['checks'].append('actual-Home-revokes-held-read')
            elif marker=='PRESENT':assert disk('present')==[{**saved[0],'state':'present'}] and len(value['requests'])==len(baseline['requests'])+1;report['checks'].append('exact-read-present-without-PUT')
            elif marker=='FRESH_APPROVAL':assert len(value['requests'])==len(baseline['requests'])+2;report['checks'].append('fresh-reviewed-approval-before-next-PUT')
            elif marker=='PUT_HELD':wait('requests',len(baseline['requests'])+3)
            elif marker=='PEER_SWITCH':assert len(value['requests'])==len(baseline['requests'])+3
            elif marker=='RELEASE':control(put='hold',release=True)
            elif marker=='COMPLETE':report['checks'].append('two-loaded-hosts-progress-and-original-SDK-receipt')
            print('Witnessed '+marker,flush=True)
        code=process.wait()
    assert code==0 and 'COMPLETE' in seen,'Native XCTest recovery journey failed'
    report['markers']=seen;report['observerAfter']=observer();assert not report['observerAfter']['errors']
    report['sourceAfter']=sources();assert report['sourceAfter']==report['sourceBefore'];report['status']='passed'
except Exception as error:report.update(status='failed',error=str(error));raise
finally:control(release=True);(args.output/'result.json').write_text(json.dumps(report,indent=2)+'\n')
