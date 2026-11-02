#!/usr/bin/env python3
"""Run XCTest native inputs while independently witnessing rejection and exact TLS receipt."""
import argparse,json,subprocess
from pathlib import Path
from evidence import ROOT,sha,sources,product
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--picker',action='store_true');p.add_argument('--originals',action='store_true');p.add_argument('--attachments',type=Path);p.add_argument('--photos',type=Path);p.add_argument('--cases',type=Path);p.add_argument('--library-photo');p.add_argument('--device',required=True);p.add_argument('--app',type=Path,required=True);p.add_argument('--build',type=Path,required=True);p.add_argument('--observer',type=Path,required=True);p.add_argument('--output',type=Path,required=True);args=p.parse_args()
args.output.mkdir(parents=True,exist_ok=False)
report={'kind':'hypergolic-ios-upload-observer-v1','status':'running','sourceBefore':sources(),'scope':'Native XCTest plus independent loopback TLS observer. Disposable signing key; no picker, protected identity or public provider acceptance.'}
try:
    report['scope'] = 'Native XCTest selected-PNG sanitation, guest read after rejected upload and independent loopback TLS observer; disposable identity. Broader formats, file selection, revocation and production identity remain open.' if args.picker else report['scope']
    build=json.loads(args.build.read_text());assert build['status']=='built' and build['platform']=='ios'
    assert build['sourceAfter']==report['sourceBefore'],'Build inputs differ from current source'
    assert build['productFiles']==product(args.app),'Supplied app differs from sealed build'
    report['buildManifestSha256']=sha(args.build.read_bytes())
    baseline=json.loads(args.observer.read_text());report['observerBefore']=baseline
    is_photo=bool(args.photos)
    items=json.loads((args.attachments/'attachments.json').read_text())['files'] if args.attachments else []
    if is_photo:
        assert (args.cases or args.library_photo) and not args.attachments and not args.picker
        manifest=json.loads((args.photos/'photos.json').read_text());names=[args.library_photo] if args.library_photo else json.loads(args.cases.read_text());assert len(names)==(1 if args.library_photo else 14)
        items=[next(item for item in manifest['files'] if item['file']==name) for name in names]
    original_items=json.loads((ROOT/'napplets/upload-lab/src/public-synthetic-photos.json').read_text())['files'] if args.originals else []
    original_reject=set();original_input=set();original_receipts={}
    if args.originals:
        assert not items and not args.picker
        for item in original_items:assert sha((ROOT/'napplets/upload-lab/src'/item['file']).read_bytes())==item['inputSha256']
        report['fixtures']=original_items;report['scope']='Actual genuine SDK guest-owned original JPEG/HEIC bypassing picker; native sanitized PNG review/reject/approved exact signed body with independent pixels/metadata. Disposable identity, controlled TLS.'
    prepared_selections={}
    if args.library_photo:
        subprocess.run(['xcrun','simctl','addmedia',args.device,str(args.photos/args.library_photo)],check=True)
        report['fixtures']=items
    if items and not args.library_photo:
        data=Path(subprocess.check_output(['xcrun','simctl','get_app_container',args.device,'org.nostrocket.hypergolic.uploadfixture','data']).decode().strip())
        directory=data/('Documents/UploadPhotos' if is_photo else 'Documents/UploadLab');directory.mkdir(parents=True,exist_ok=True)
        for index,item in enumerate(items):
            body=((args.photos if is_photo else args.attachments)/item['file']).read_bytes()
            assert sha(body)==(item['inputSha256'] if is_photo else item['sha256'])
            if not is_photo:assert len(body)==item['size']
            extension=item['file'].rsplit('.',1)[1]
            filename=f'photo-{index+1:02d}.'+extension if is_photo else 'proof-'+extension+'.'+extension
            (directory/filename).write_bytes(body)
        report['fixtures']=items;report['scope']='Actual iOS document selection of unchanged WAV/MP4/PDF/ZIP/text with exact guest bytes, native reject/read/review/approve and independent signed TLS uploads; no protected or published acceptance.'
    if is_photo:report['scope']='Actual selected photo preparation/decoded review/reject/read/exact signed TLS with independent orientation/color/metadata; disposable signer, no protected or published acceptance.'
    selected_checks=set();read_checks=set();reject_checks=set()
    installed=Path(subprocess.check_output(['xcrun','simctl','get_app_container',args.device,'org.nostrocket.hypergolic.uploadfixture','app']).decode().strip())
    report['productFiles']=product(args.app);assert report['productFiles']==product(installed),'Installed app differs from supplied product'
    command=['xcodebuild','test','-project','tests/native/ios/XCTest/HypergolicUITests.xcodeproj','-scheme','HypergolicUITests','-destination','platform=iOS Simulator,id='+args.device,'-only-testing:HypergolicUITests/UploadTests/'+('testOriginalPhotosRejectApprove' if args.originals else 'testSelectedHEICPhotoRejectApprove' if args.library_photo else 'testSelectedPhotosRejectApprove' if is_photo else 'testSelectedAttachmentsRejectApprove' if items else 'testSelectedPhotoRejectApprove' if args.picker else 'testReviewRejectApprove'),'-derivedDataPath',str(args.output/'build'),'-resultBundlePath',str(args.output/'journey.xcresult'),'CODE_SIGNING_ALLOWED=NO']
    rejected=False
    with (args.output/'journey.log').open('w') as log:
        process=subprocess.Popen(command,cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1)
        for line in process.stdout:
            log.write(line);log.flush()
            if args.originals:
                for index,(item,kind) in enumerate(zip(original_items,['JPEG','HEIC'])):
                    if 'UPLOAD_ORIGINAL_INPUT:'+kind+':' in line:
                        assert str(item['size']) in line and item['inputSha256'] in line,'Original guest input mismatch';original_input.add(kind)
                    if 'UPLOAD_ORIGINAL_REJECT:'+kind in line:
                        observed=json.loads(args.observer.read_text());assert observed['connections']==baseline['connections']+index and len(observed['requests'])==len(baseline['requests'])+index
                        original_reject.add(kind);print('Observed zero-network original rejection: '+kind,flush=True)
                    if 'UPLOAD_ORIGINAL_RECEIPT:'+kind+':' in line:
                        original_receipts[kind]=json.loads(line.split('UPLOAD_ORIGINAL_RECEIPT:'+kind+':',1)[1])
            elif is_photo:
                import re
                for index,item in enumerate(items):
                    name=f'photo-{index+1:02d}'
                    if 'UPLOAD_PHOTO_SELECTED:'+name+':' in line or 'UPLOAD_PHOTO_READ:'+name+':' in line:
                        match=re.search(r'Selected bytes: (\d+); SHA-256: ([0-9a-f]{64}); type: image/png;',line);assert match,line
                        selected={'size':int(match.group(1)),'sha256':match.group(2)}
                        if 'UPLOAD_PHOTO_SELECTED:'+name+':' in line:prepared_selections[name]=selected;selected_checks.add(name)
                        else:assert selected==prepared_selections[name];read_checks.add(name)
                    if 'UPLOAD_PHOTO_REJECT:'+name in line:
                        observed=json.loads(args.observer.read_text());assert observed['connections']==baseline['connections']+index and len(observed['requests'])==len(baseline['requests'])+index
                        reject_checks.add(name);print('Observed zero-network photo rejection: '+name,flush=True)
            elif items:
                for item in items:
                    ext=item['file'].rsplit('.',1)[1];expected='Selected bytes: '+str(item['size'])+'; SHA-256: '+item['sha256']
                    if 'UPLOAD_ATTACHMENT_SELECTED:'+ext+':' in line:
                        assert expected in line,'Guest bytes differ from independently generated fixture';selected_checks.add(ext)
                    if 'UPLOAD_ATTACHMENT_READ:'+ext+':' in line:
                        assert expected in line,'Post-rejection bytes differ';read_checks.add(ext)
                    if 'UPLOAD_ATTACHMENT_REJECT:'+ext in line:
                        observed=json.loads(args.observer.read_text());index=items.index(item)
                        assert observed['connections']==baseline['connections']+index and len(observed['requests'])==len(baseline['requests'])+index,'Rejection dispatched network traffic'
                        reject_checks.add(ext);print('Observed zero-network rejection: '+ext,flush=True)
            if not items and ('UPLOAD_PICKER_REJECT_CHECKPOINT' if args.picker else 'UPLOAD_REJECT_CHECKPOINT') in line:
                observed=json.loads(args.observer.read_text());report['observerAfterReject']=observed
                rejected=observed['connections']==baseline['connections'] and observed['requests']==baseline['requests']
                print('Observed rejection: zero new TLS connections = '+str(rejected),flush=True)
        code=process.wait()
    assert code==0,'Native XCTest journey failed'
    assert len(original_reject)==len(original_input)==len(original_receipts)==2 if args.originals else (len(selected_checks)==len(read_checks)==len(reject_checks)==len(items)) if items else rejected,'Native owning checkpoints missing'
    observed=json.loads(args.observer.read_text());report['observerAfterApprove']=observed
    requests=observed['requests'][len(baseline['requests']):]
    count=2 if args.originals else len(items) if items else 1
    assert len(requests)==count and observed['connections']==baseline['connections']+count and not observed['errors']
    if args.originals:
        for request,item,kind in zip(requests,original_items,['JPEG','HEIC']):
            receipt=original_receipts[kind]
            assert request['mimeType']=='image/png' and request['sha256']!=item['inputSha256'] and request['signatureVerified'] is True and item['recipe'] in request['photoMatches']
            assert receipt['status']=='complete' and receipt['sha256']==request['sha256'] and receipt['size']==request['size'] and receipt['mimeType']=='image/png'
        report['originalReceipts']=original_receipts
    elif items:
        for index,(request,item) in enumerate(zip(requests,items)):
            selected=prepared_selections[f'photo-{index+1:02d}'] if is_photo else item
            assert request['sha256']==selected['sha256'] and request['size']==selected['size'] and request['mimeType']==('image/png' if is_photo else item['mimeType']) and request['signatureVerified'] is True
            if is_photo:assert item['file'] in request['photoMatches']
        if is_photo:report['preparedSelections']=prepared_selections;report['scope']='Actual selected photo preparation/decoded review/reject/read/exact signed TLS with independent orientation/color/metadata. Disposable signer, no protected or published acceptance.'
    else:assert requests[0]['sha256']=='5a852fbaaaecaf4cd14c01e150c7f881c5c5894b0a1e3c53be7e007c58374ee6' and requests[0]['size']==71 and requests[0]['signatureVerified'] is True
    assert product(installed)==report['productFiles'],'Installed product changed during journey'
    report['sourceAfter']=sources();assert report['sourceBefore']==report['sourceAfter'],'Source changed during native journey'
    report['status']='passed';print('PASS native iOS review/reject/exact approved bytes and signature',flush=True)
except Exception as error:
    report.update(status='failed',error=str(error));raise
finally:(args.output/'result.json').write_text(json.dumps(report,indent=2)+'\n')
