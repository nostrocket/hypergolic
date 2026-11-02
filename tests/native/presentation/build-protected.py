#!/usr/bin/env python3
"""Package a test-only signed source with the ordinary real protected identity owner.
Source composition is restored even on build failure. Never substitutes a fake vault.
"""
import argparse,json,subprocess,shutil
from pathlib import Path
from evidence import ROOT,sha,sources
PACKAGE='org.nostrocket.hypergolic.emptyacceptance'
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--output',type=Path,required=True);p.add_argument('--suite',choices=['configuration','notifications'],default='configuration');a=p.parse_args();out=a.output.resolve();out.mkdir(parents=True,exist_ok=False)
module='protected-source' if a.suite=='configuration' else 'protected-notify-source';factory='createProtectedConfigurationSource' if a.suite=='configuration' else 'createProtectedNotificationSource';entry='protected.tsx' if a.suite=='configuration' else 'protected-notify.tsx'
port=ROOT/'src/napplets/native-published-source-port.ts';gradle=ROOT/'android/app/build.gradle';original_port=port.read_bytes();original_gradle=gradle.read_bytes();expected_port=original_port;expected_gradle=original_gradle;owner=ROOT/'src/security/trusted-identity-owner.ts';owner_hash=sha(owner.read_bytes())
record={'kind':'hypergolic-protected-'+a.suite+'-build-v1','status':'running','platform':'android','package':PACKAGE,'sourceBefore':sources(),'scope':'Real ordinary protected owner with test-only local signed source and trusted controls; no external relay/HTTPS or complete acceptance claim.'}
try:
 text=original_port.decode();assert text.count('return createNativePublishedArtifactSource({')==1 and text.endswith('  });\n}\n')
 text=f"import {{{factory}}} from '../../tests/native/presentation/{module}';\n"+text.replace('return createNativePublishedArtifactSource({','const source = createNativePublishedArtifactSource({').removesuffix('  });\n}\n')+'  });\n  return '+factory+'(source);\n}\n';expected_port=text.encode();port.write_bytes(expected_port)
 g=original_gradle.decode();old='entryFile = file(["node", "-e", "require(\'expo/scripts/resolveAppEntry\')", projectRoot, "android", "absolute"].execute(null, rootDir).text.trim())'
 assert g.count(old)==1 and g.count("applicationId 'org.nostrocket.hypergolic.dev'")==1 and g.count('signingConfig null')==1
 g=g.replace(old,'entryFile = file("../../tests/native/presentation/'+entry+'")').replace("applicationId 'org.nostrocket.hypergolic.dev'","applicationId '"+PACKAGE+"'").replace('signingConfig null','signingConfig signingConfigs.debug');expected_gradle=g.encode();gradle.write_bytes(expected_gradle)
 record['packagedSource']=sources();record['temporaryNativeSourceSha256']=sha(port.read_bytes());record['temporaryGradleSha256']=sha(gradle.read_bytes());record['realIdentityOwnerSha256']=owner_hash
 command=['./gradlew',':app:assembleRelease','-PreactNativeArchitectures=arm64-v8a','--console=plain','--no-daemon','--max-workers=2'];record['command']=command
 with (out/'build.log').open('w') as log:subprocess.run(command,cwd=ROOT/'android',stdout=log,stderr=subprocess.STDOUT,check=True)
 assert owner_hash==sha(owner.read_bytes()),'Protected identity owner changed during packaging'
 assert record['packagedSource']==sources(),'Inputs drifted while packaging'
 target=out/('hypergolic-protected-config.apk' if a.suite=='configuration' else 'hypergolic-protected-notify.apk');shutil.copy2(ROOT/'android/app/build/outputs/apk/release/app-release.apk',target);record['productSha256']=sha(target.read_bytes());record['status']='built'
except Exception as error:record.update(status='failed',error=str(error));raise
finally:
 restoration_errors=[]
 for file,original,expected in [(port,original_port,expected_port),(gradle,original_gradle,expected_gradle)]:
  current=file.read_bytes()
  if current==expected:file.write_bytes(original)
  elif current!=original:restoration_errors.append(str(file.relative_to(ROOT)))
 record['restorationConflicts']=restoration_errors
 record['sourceAfter']=sources();record['productionCompositionRestored']=port.read_bytes()==original_port and gradle.read_bytes()==original_gradle;record['realIdentityOwnerUnchanged']=owner_hash==sha(owner.read_bytes());record['sourceRestored']=record['sourceBefore']==record['sourceAfter'];(out/'build.json').write_text(json.dumps(record,indent=2)+'\n')
 if restoration_errors:raise RuntimeError('Refusing to overwrite concurrent changes: '+', '.join(restoration_errors))
print(json.dumps({k:record[k] for k in ['status','productSha256','productionCompositionRestored','realIdentityOwnerUnchanged','sourceRestored']}),flush=True)
