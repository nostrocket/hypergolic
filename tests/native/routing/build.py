#!/usr/bin/env python3
"""Seal an isolated routing product using ordinary native network/security settings."""
import argparse,json,os,shutil,subprocess
from pathlib import Path
from evidence import ROOT,sha,sources,product
PACKAGE='org.nostrocket.hypergolic.routingfixture'
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--suite',choices=['published'],default='published')
p.add_argument('--platform',choices=['android','ios'],required=True)

p.add_argument('--reuse-derived',type=Path);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
a.output=a.output.resolve();a.output.mkdir(parents=True,exist_ok=False)
env=os.environ.copy()
PACKAGE='org.nostrocket.hypergolic.routingfixture' if a.suite=='published' else PACKAGE
entry=ROOT/('tests/native/routing/published.tsx' if a.suite=='published' else 'tests/native/routing/index.tsx')
r={'kind':'hypergolic-native-routing-build-v1','status':'running','platform':a.platform,'package':PACKAGE,'suite':a.suite,'sourceBefore':sources(),'scope':'Normal signed local Routing Lab with disposable public identities; no external publication/protected/physical claim.' if a.suite=='published' else 'Isolated public-only fixture; production native review and OS handoff. No physical/protected or normal signed admission claim.'}
try:
 if a.platform=='android':
  gradle=ROOT/'android/app/build.gradle';original=gradle.read_bytes()
  try:
   text=original.decode();old='entryFile = file(["node", "-e", "require(\'expo/scripts/resolveAppEntry\')", projectRoot, "android", "absolute"].execute(null, rootDir).text.trim())'
   assert old in text and "applicationId 'org.nostrocket.hypergolic.dev'" in text
   text=text.replace(old,'entryFile = file("../../'+str(entry.relative_to(ROOT))+'")').replace("applicationId 'org.nostrocket.hypergolic.dev'", "applicationId '"+PACKAGE+"'").replace('signingConfig null','signingConfig signingConfigs.debug')
   gradle.write_text(text);command=['./gradlew',':app:assembleRelease','-PreactNativeArchitectures=arm64-v8a,x86_64','--console=plain'];r['command']=command
   with (a.output/'build.log').open('w') as log:subprocess.run(command,cwd=ROOT/'android',env=env,stdout=log,stderr=subprocess.STDOUT,check=True)
   target=a.output/'routingfixture.apk';shutil.copy2(ROOT/'android/app/build/outputs/apk/release/app-release.apk',target);r['productSha256']=sha(target.read_bytes())
  finally:gradle.write_bytes(original)
 else:
  derived=a.reuse_derived.resolve() if a.reuse_derived else a.output/'derived';env['ENTRY_FILE']=str(entry)
  command=['xcodebuild','-workspace','ios/Hypergolic.xcworkspace','-scheme','Hypergolic','-configuration','Release','-sdk','iphonesimulator','-destination','generic/platform=iOS Simulator','-derivedDataPath',str(derived),'PRODUCT_BUNDLE_IDENTIFIER='+PACKAGE,'CODE_SIGNING_ALLOWED=NO'];r['command']=command
  with (a.output/'build.log').open('w') as log:subprocess.run(command,cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT,check=True)
  r['productFiles']=product(derived/'Build/Products/Release-iphonesimulator/Hypergolic.app')
 r['sourceAfter']=sources();assert r['sourceBefore']==r['sourceAfter'],'Source drifted during packaging'
 r['status']='built';print('PASS sealed ordinary '+a.platform+' '+'routing product',flush=True)
except Exception as error:r.update(status='failed',error=str(error));raise
finally:(a.output/'build.json').write_text(json.dumps(r,indent=2)+'\n')
