"""Compile the source-linked standalone WK tests and seal exact inputs/products. Never runs a device."""
from pathlib import Path
import datetime,hashlib,json,os,subprocess,sys
HERE=Path(__file__).resolve().parent
REPO=HERE.parents[2]
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def inputs():
 files=[p for directory in ['App','Tests','BoundaryProbe.xcodeproj','Resources'] for p in (HERE/directory).rglob('*') if p.is_file()]
 files += [HERE/n for n in ['expected-runtime.json','prepare-assets.py','build.py']]
 files += [REPO/'modules/napplet-host/ios'/n for n in ['RestrictedNappletHost.swift','NativeApprovalAuthority.swift','CapabilityLeaseRegistry.swift','CapabilityTransport.swift','ApprovalTransport.swift','NappletHostView.swift','NappletHostModule.swift','HypergolicNappletHost.podspec']]
 return {str(p.relative_to(REPO)):digest(p) for p in sorted(files)}
def main():
 subprocess.run([sys.executable,str(HERE/'prepare-assets.py')],check=True)
 before=inputs();output=HERE/'build';output.mkdir(exist_ok=True)
 receipt=output/'boundary-build.json'
 if receipt.exists():raise RuntimeError('Existing sealed build; preserve or move build/ before a new build')
 command=['xcodebuild','build-for-testing','-project','BoundaryProbe.xcodeproj','-scheme','BoundaryProbe','-destination','generic/platform=iOS Simulator','-derivedDataPath','build','CODE_SIGNING_ALLOWED=NO']
 environment=dict(os.environ,DEVELOPER_DIR=os.environ.get('DEVELOPER_DIR','/Applications/Xcode.app/Contents/Developer'))
 with (output/'boundary-build.log').open('w') as log:
  process=subprocess.run(command,cwd=HERE,env=environment,stdout=log,stderr=subprocess.STDOUT,timeout=300)
 after=inputs();assert before==after,'Source changed during compile'
 process.check_returncode()
 app=output/'Build/Products/Debug-iphonesimulator/BoundaryProbe.app'
 assert (app/'BoundaryProbe').is_file() and (app/'PlugIns/BoundaryTests.xctest/BoundaryTests').is_file()
 products={str(p.relative_to(HERE)):digest(p) for p in sorted(app.rglob('*')) if p.is_file()}
 products.update({str(p.relative_to(HERE)):digest(p) for p in sorted((output/'Build/Products').glob('*.xctestrun'))})
 value={'schema':1,'status':'compiled-not-executed','dateUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'command':command,'inputs':before,'products':products,'sourceRoot':str(REPO)}
 receipt.write_text(json.dumps(value,indent=2)+'\n');print(str(receipt))
if __name__=='__main__':main()
