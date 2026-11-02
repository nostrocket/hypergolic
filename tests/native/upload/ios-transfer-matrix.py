#!/usr/bin/env python3
"""Independent real XCTest/provider/disk witnesses for the isolated iOS transfer fault matrix."""
import argparse,json,subprocess,time,hashlib
from pathlib import Path
from evidence import large_wav,ROOT,sha,sources,product,recovery_records
PACKAGE='org.nostrocket.hypergolic.uploadfixture';HASH='5a852fbaaaecaf4cd14c01e150c7f881c5c5894b0a1e3c53be7e007c58374ee6'
p=argparse.ArgumentParser(description=__doc__)
for n in ['device','app','build','observer','output']:p.add_argument('--'+n,required=True,type=str if n=='device' else Path)
a=p.parse_args();a.output.mkdir(parents=True,exist_ok=False)
r={'kind':'hypergolic-ios-transfer-matrix-v1','status':'running','checks':[],'cases':[],'sourceBefore':sources(),'scope':'Actual isolated SDK/native Simulator/TLS provider and lifecycle faults. Native metadata disk modes/exclusion, checksum and symlink denial; Simulator proof excludes absent hardware data-protection attribute. Disposable identity; no protected/public-provider or ordinary workspace identity acceptance.'}
def observer():return json.loads(a.observer.read_text())
def control(put='normal',release=False):
    path=a.observer.parent/'control.json';tmp=path.with_suffix('.tmp');tmp.write_text(json.dumps({'put':put,'get':'normal','release':release}));tmp.replace(path)
def wait(key,count):
    deadline=time.monotonic()+35
    while time.monotonic()<deadline:
        v=observer()
        if (v[key] if key=='connections' else len(v[key]))>=count:return v
        time.sleep(.1)
    raise AssertionError('Missing observer checkpoint '+key)
def disk():
    root=Path(subprocess.check_output(['xcrun','simctl','get_app_container',a.device,PACKAGE,'data'],text=True).strip());return root/'Library/Application Support/UploadRecovery-v1/ledger.bin'
try:
    build=json.loads(a.build.read_text());assert build['status']=='built' and build['platform']=='ios' and build['sourceAfter']==r['sourceBefore'] and build['productFiles']==product(a.app)
    r['productFiles']=product(a.app);case=None;saved=None;mode=None;baseline=None;denial=None;complete=False;r['observerBefore']=observer()
    command=['xcodebuild','test','-project','tests/native/ios/XCTest/HypergolicUITests.xcodeproj','-scheme','HypergolicUITests','-destination','platform=iOS Simulator,id='+a.device,'-only-testing:HypergolicUITests/UploadTests/testUploadTransferFaultMatrix','-derivedDataPath',str(a.output/'build'),'-resultBundlePath',str(a.output/'journey.xcresult'),'CODE_SIGNING_ALLOWED=NO']
    with (a.output/'journey.log').open('w') as log:
        process=subprocess.Popen(command,cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1)
        for line in process.stdout:
            log.write(line);log.flush()
            if 'TRANSFER_' not in line:continue
            marker=line.strip().split('TRANSFER_',1)[1]
            if marker.startswith('RESET:'):
                _,case,mode=marker.split(':');control(put=mode)
                subprocess.run(['xcrun','simctl','uninstall',a.device,PACKAGE],check=True,stdout=subprocess.DEVNULL)
                subprocess.run(['xcrun','simctl','install',a.device,str(a.app)],check=True,stdout=subprocess.DEVNULL)
                installed=Path(subprocess.check_output(['xcrun','simctl','get_app_container',a.device,PACKAGE,'app'],text=True).strip());assert product(installed)==build['productFiles'];baseline=observer();saved=None;denial=None
            elif marker.startswith('HELD:'):
                wait('connections',baseline['connections']+1) if case=='before-body' else wait('putAttempts' if case=='stream' else 'requests',len(baseline['putAttempts' if case=='stream' else 'requests'])+1)
            elif marker=='RELEASE':control(put=mode,release=True)
            elif marker.startswith('CORRUPT:'):
                path=disk();saved=path.read_bytes();assert recovery_records(saved)[0]['state']=='unknown';denial=observer()
                if case=='mode':path.chmod(0o644)
                elif case=='symlink':path.rename(path.with_name('ledger.bin.saved'));path.symlink_to('ledger.bin.saved')
                else:
                    value=bytearray(saved);value[-1]^=1;path.write_bytes(value);saved=bytes(value)
            elif marker.startswith('RESULT:'):
                assert marker.split(':')[1]==case;v=observer();path=disk();value=path.read_bytes();(a.output/(case+'.bin')).write_bytes(value)
                if denial is not None:assert v==denial and value==saved;entry={'name':case,'deniedBeforeReviewOrNetwork':True,'bytesSha256':sha(value)}
                else:
                    rows=recovery_records(value);expected='not_sent' if case=='before-body' else 'rejected' if case in ['reject','large','quota'] else 'unknown'
                    assert len(rows)==1 and rows[0]['state']==expected and rows[0]['sha256']==(sha(large_wav()) if case=='stream' else HASH)
                    assert path.stat().st_mode&0o777==0o600 and path.parent.stat().st_mode&0o777==0o700
                    assert len(v['putAttempts'])==len(baseline['putAttempts'])+(0 if case=='before-body' else 1)
                    stored=0 if case in ['reject','large','quota','drop-before-store','before-body','stream'] else 1
                    assert len(v['requests'])==len(baseline['requests'])+stored and len(v['gets'])==len(baseline['gets']) and not v['errors']
                    if case=='stream':
                        v=wait('partialPuts',len(baseline['partialPuts'])+1);q=v['partialPuts'][-1];assert 0<q['bytesReceived']<q['declaredSize']==4*1024*1024
                    elif case!='before-body':assert v['putAttempts'][-1]['signatureVerified']
                    entry={'name':case,'rows':rows,'bytesSha256':sha(value),'mode':oct(path.stat().st_mode&0o777),'before':baseline,'after':v}
                r['cases'].append(entry);r['checks'].append(case);print('PASS '+case,flush=True)
            elif marker=='COMPLETE':complete=True
        code=process.wait()
    assert code==0 and complete and len(r['checks'])==21,'Native XCTest transfer matrix failed'
    r['sourceAfter']=sources();assert r['sourceAfter']==r['sourceBefore'];r['observerAfter']=observer();r['status']='passed'
except Exception as error:r.update(status='failed',error=str(error));raise
finally:control(release=True);(a.output/'result.json').write_text(json.dumps(r,indent=2)+'\n')
