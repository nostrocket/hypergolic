#!/usr/bin/env python3
"""Build isolated upload products with before/after source seals; activate the local toolchains first."""
import argparse,json,os,shutil,subprocess,plistlib
from pathlib import Path
from evidence import ROOT,sha,sources,product
PACKAGE='org.nostrocket.hypergolic.uploadfixture'
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--platform',choices=['android','ios'],required=True);p.add_argument('--reuse-derived',type=Path);p.add_argument('--entry',choices=['unsigned','published'],default='unsigned');p.add_argument('--anchor',type=Path,required=True);p.add_argument('--output',type=Path,required=True);args=p.parse_args()
args.output=args.output.resolve();args.output.mkdir(parents=True,exist_ok=False)
anchor=args.anchor.read_text().strip();env=os.environ.copy();env['EXPO_PUBLIC_UPLOAD_PROOF_ANCHOR']=anchor
entry=ROOT/'tests/native/upload'/('published-index.tsx' if args.entry=='published' else 'index.tsx')
report={'entry':args.entry,'kind':'hypergolic-isolated-upload-build-v1','status':'running','platform':args.platform,'package':PACKAGE,'anchorSha256':sha(anchor.encode()),'sourceBefore':sources(),'scope':'Compile-gated local TLS fixture and public disposable identity. This build does not establish native journey or production acceptance.'}
try:
    if args.platform=='android':
        gradle=ROOT/'android/app/build.gradle';original=gradle.read_bytes()
        try:
            text=original.decode();old='entryFile = file(["node", "-e", "require(\'expo/scripts/resolveAppEntry\')", projectRoot, "android", "absolute"].execute(null, rootDir).text.trim())'
            assert old in text and "applicationId 'org.nostrocket.hypergolic.dev'" in text,'Unexpected generated app configuration'
            text=text.replace(old,'entryFile = file("../../'+str(entry.relative_to(ROOT))+'")').replace("applicationId 'org.nostrocket.hypergolic.dev'", "applicationId '"+PACKAGE+"'").replace('signingConfig null','signingConfig signingConfigs.debug')
            gradle.write_text(text)
            command=['./gradlew',':app:assembleRelease','-PhypergolicUploadProof=true','-PreactNativeArchitectures=arm64-v8a,x86_64','--console=plain'];report['command']=command
            with (args.output/'build.log').open('w') as log:subprocess.run(command,cwd=ROOT/'android',env=env,stdout=log,stderr=subprocess.STDOUT,check=True)
            target=args.output/'uploadfixture.apk';shutil.copy2(ROOT/'android/app/build/outputs/apk/release/app-release.apk',target)
            report['productSha256']=sha(target.read_bytes())
        finally:gradle.write_bytes(original)
    else:
        derived=args.reuse_derived.resolve() if args.reuse_derived else args.output/'derived'
        env['ENTRY_FILE']=str(entry)
        command=['xcodebuild','-workspace','ios/Hypergolic.xcworkspace','-scheme','Hypergolic','-configuration','Release','-sdk','iphonesimulator','-destination','generic/platform=iOS Simulator','-derivedDataPath',str(derived),'PRODUCT_BUNDLE_IDENTIFIER='+PACKAGE,'SWIFT_ACTIVE_COMPILATION_CONDITIONS=$(inherited) HYPERGOLIC_NETWORK_PROOF','CODE_SIGNING_ALLOWED=NO'];report['command']=command
        info=ROOT/'ios/Hypergolic/Info.plist';original_info=info.read_bytes()
        try:
            # Only the isolated public-file fixture exposes Documents to the system Files UI.
            values=plistlib.loads(original_info);values['UIFileSharingEnabled']=True;values['LSSupportsOpeningDocumentsInPlace']=True
            info.write_bytes(plistlib.dumps(values))
            with (args.output/'build.log').open('w') as log:subprocess.run(command,cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT,check=True)
        finally:info.write_bytes(original_info)
        report['productFiles']=product(derived/'Build/Products/Release-iphonesimulator/Hypergolic.app')
    report['sourceAfter']=sources();assert report['sourceBefore']==report['sourceAfter'],'Source drifted during packaging'
    report['status']='built';print('PASS isolated '+args.platform+' product and source seal',flush=True)
except Exception as error:report.update(status='failed',error=str(error));raise
finally:(args.output/'build.json').write_text(json.dumps(report,indent=2)+'\n')
