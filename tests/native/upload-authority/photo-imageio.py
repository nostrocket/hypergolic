#!/usr/bin/env python3
"""Source-sealed macOS ImageIO codec proof; not iOS SDK/picker acceptance."""
import argparse,hashlib,json,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3];HOST=ROOT/'modules/napplet-host/ios'
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--fixtures',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();a.output.mkdir(parents=True,exist_ok=False)
files=[HOST/(name+'.swift') for name in ['NativeUploadAuthority','UploadPngProfile','UploadPngMetadata','UploadFileProfile','UploadExifMetadata','UploadPhotoContainer','UploadPhotoPreparation']]+[Path(__file__).with_name('UploadPhotoCodecProof.swift')]
sha=lambda data:hashlib.sha256(data).hexdigest()
def inputs():return {str(f.relative_to(ROOT)):sha(f.read_bytes()) for f in files}
r={'status':'running','scope':__doc__,'sourceBefore':inputs()}
try:
 r['platform']=subprocess.check_output(['sw_vers'],text=True);r['compiler']=subprocess.check_output(['swiftc','--version'],text=True)
 command=['swiftc','-swift-version','6','-warnings-as-errors','-module-cache-path',str(a.output/'swift-cache'),*[str(f) for f in files],'-o',str(a.output/'proof')]
 r['command']=command;subprocess.run(command,check=True);r['proofSha256']=sha((a.output/'proof').read_bytes())
 r['stdout']=subprocess.check_output([str(a.output/'proof'),str(a.fixtures),str(a.output/'prepared')],text=True)
 manifest=json.loads((a.fixtures/'photos.json').read_text());expected=2*len(manifest['files'])+len(manifest['invalid']);assert r['stdout'].strip()==f'PASS ImageIO native owning photo checks: {expected}'
 r['sourceAfter']=inputs();assert r['sourceBefore']==r['sourceAfter'];r['status']='passed';print(r['stdout'],end='')
except Exception as error:r.update(status='failed',error=str(error));raise
finally:(a.output/'result.json').write_text(json.dumps(r,indent=2)+'\n')
