#!/usr/bin/env python3
"""Witness actual normal signed-upload XCTest against separately sealed provider bytes."""
import argparse,json,subprocess
from pathlib import Path
from evidence import ROOT,sha,sources,product,large_wav
PACKAGE='org.nostrocket.hypergolic.uploadfixture';HASH='5a852fbaaaecaf4cd14c01e150c7f881c5c5894b0a1e3c53be7e007c58374ee6'
p=argparse.ArgumentParser(description=__doc__)
for name in ['device','app','build','observer','output']:p.add_argument('--'+name,required=True,type=str if name=='device' else Path)
args=p.parse_args();args.output.mkdir(parents=True,exist_ok=False)
report={'kind':'hypergolic-ios-published-upload-v1','status':'running','checks':[],'sourceBefore':sources(),'scope':'Actual normal IdentityShell/Settings/consent/SQLite/cache/runtime/native owner with signed local artifact, public disposable identity and proof TLS. No public relay/provider or protected-device claim.'}
def observer():return json.loads(args.observer.read_text())
try:
    build=json.loads(args.build.read_text());assert build['status']=='built' and build['entry']=='published' and build['sourceAfter']==report['sourceBefore'] and build['productFiles']==product(args.app)
    installed=Path(subprocess.check_output(['xcrun','simctl','get_app_container',args.device,PACKAGE,'app'],text=True).strip());assert product(installed)==product(args.app);report['productFiles']=product(args.app)
    data=Path(subprocess.check_output(['xcrun','simctl','get_app_container',args.device,PACKAGE,'data'],text=True).strip());(data/'Documents').mkdir(exist_ok=True);(data/'Documents/published-proof.wav').write_bytes(large_wav())
    baseline=observer();report['observerBefore']=baseline
    control=args.observer.parent/'control.json';temporary=control.with_suffix('.tmp');temporary.write_text(json.dumps({'put':'normal','get':'normal','release':False}));temporary.replace(control)
    command=['xcodebuild','test','-project','tests/native/ios/XCTest/HypergolicUITests.xcodeproj','-scheme','HypergolicUITests','-destination','platform=iOS Simulator,id='+args.device,'-only-testing:HypergolicUITests/UploadTests/testVerifiedPublishedUpload','-derivedDataPath',str(args.output/'build'),'-resultBundlePath',str(args.output/'journey.xcresult'),'CODE_SIGNING_ALLOWED=NO'];seen=[];approved=None
    with (args.output/'journey.log').open('w') as log:
        process=subprocess.Popen(command,cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1)
        for line in process.stdout:
            log.write(line);log.flush()
            if 'PUBLISHED_UPLOAD_' not in line:continue
            marker=line.strip().split('PUBLISHED_UPLOAD_',1)[1];seen.append(marker);value=observer()
            if marker in ['CONSENT_REJECT','ADMITTED','REJECT']:assert value==baseline;report['checks'].append(marker+'-zero-TLS')
            elif marker.startswith('INFO:'):
                info=json.loads(marker.split(':',1)[1]);assert info['maxBytes']==10485760 and info['rails']==[{'rail':'blossom','enabled':True,'returns':['https','blossom']},{'rail':'nip96','enabled':False}] and value==baseline;report['checks'].append('native-SDK-advisory-info-zero-TLS')
            elif marker=='APPROVED':
                requests=value['requests'][len(baseline['requests']):];assert len(requests)==1 and value['connections']==baseline['connections']+1 and requests[0]['sha256']==HASH and requests[0]['size']==71 and requests[0]['signatureVerified'] and not value['errors'];approved=value;report['checks'].append('approved-exact-bytes-independent-signature')
            elif marker.startswith('RECEIPT:'):
                receipt=json.loads(marker.split(':',1)[1]);assert receipt['status']=='complete' and receipt['sha256']==HASH and receipt['size']==71 and receipt['mimeType']=='image/png' and receipt['url']=='https://files.example.com:19943/'+HASH+'.png';report['checks'].append('original-signed-recipient-SDK-receipt');report['receipt']=receipt
            elif marker in ['WAV_SELECTED','WAV_REJECT','WAV_READ']:assert value==approved;report['checks'].append(marker+'-exact-selected-no-TLS')
            elif marker=='WAV_APPROVED':
                rows=value['requests'][len(baseline['requests']):];assert len(rows)==2 and rows[-1]['sha256']==sha(large_wav()) and rows[-1]['size']==4194304 and rows[-1]['mimeType']=='audio/wav' and rows[-1]['signatureVerified'];approved=value;report['checks'].append('selected-WAV-exact-body-signature')
            elif marker=='COLD_RESTART':assert approved and value==approved;report['checks'].append('persisted-cached-workspace-and-grant-without-auto-upload')
            print('Witnessed '+marker,flush=True)
        code=process.wait()
    assert code==0 and 'COMPLETE' in seen and len(report['checks'])==11,'Native signed upload journey failed'
    report['markers']=seen;report['observerAfter']=observer();report['sourceAfter']=sources();assert report['sourceAfter']==report['sourceBefore'];report['status']='passed'
except Exception as error:report.update(status='failed',error=str(error));raise
finally:(args.output/'result.json').write_text(json.dumps(report,indent=2)+'\n')
