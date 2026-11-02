#!/usr/bin/env python3
"""Execute the actual packaging driver with a fake Gradle process to verify source restoration."""
import hashlib,json,runpy,subprocess,sys,tempfile,types,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[3]
class BuilderRestoration(unittest.TestCase):
 def execute(self,suite,mode):
  with tempfile.TemporaryDirectory(prefix='hypergolic-protected-builder-') as name:
   base=Path(name);root=base/'source';port=root/'src/napplets/native-published-source-port.ts';gradle=root/'android/app/build.gradle';owner=root/'src/security/trusted-identity-owner.ts'
   for target,source in [(port,ROOT/'src/napplets/native-published-source-port.ts'),(gradle,ROOT/'android/app/build.gradle'),(owner,ROOT/'src/security/trusted-identity-owner.ts')]:target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(source.read_bytes())
   originals={p:p.read_bytes() for p in [port,gradle,owner]};out=base/'receipt';evidence=types.ModuleType('evidence');evidence.ROOT=root;evidence.sha=lambda data:hashlib.sha256(data).hexdigest();evidence.sources=lambda:{str(p.relative_to(root)):evidence.sha(p.read_bytes()) for p in [port,owner]}
   selected_factory='createProtectedConfigurationSource' if suite=='configuration' else 'createProtectedNotificationSource';selected_entry='protected.tsx' if suite=='configuration' else 'protected-notify.tsx'
   def build(*args,**kwargs):
    self.assertIn('return '+selected_factory+'(source)',port.read_text());self.assertIn(selected_entry,gradle.read_text());self.assertEqual(owner.read_bytes(),originals[owner]);self.assertIn("applicationId 'org.nostrocket.hypergolic.emptyacceptance'",gradle.read_text())
    if mode=='concurrent':port.write_bytes(b'unknown concurrent edit\n')
    if mode in ['failure','concurrent']:raise subprocess.CalledProcessError(1,args[0])
    apk=root/'android/app/build/outputs/apk/release/app-release.apk';apk.parent.mkdir(parents=True,exist_ok=True);apk.write_bytes(b'host-only fake Gradle artifact; never native acceptance')
   argv=[str(ROOT/'tests/native/presentation/build-protected.py'),'--suite',suite,'--output',str(out)]
   with patch.dict(sys.modules,{'evidence':evidence}),patch.object(sys,'argv',argv),patch('subprocess.run',side_effect=build):
    if mode=='success':runpy.run_path(str(ROOT/'tests/native/presentation/build-protected.py'),run_name='__main__')
    else:
     with self.assertRaises((subprocess.CalledProcessError,RuntimeError)):runpy.run_path(str(ROOT/'tests/native/presentation/build-protected.py'),run_name='__main__')
   report=json.loads((out/'build.json').read_text());self.assertEqual(gradle.read_bytes(),originals[gradle]);self.assertEqual(owner.read_bytes(),originals[owner]);self.assertTrue(report['realIdentityOwnerUnchanged'])
   if mode=='concurrent':self.assertEqual(port.read_bytes(),b'unknown concurrent edit\n');self.assertFalse(report['productionCompositionRestored']);self.assertEqual(report['restorationConflicts'],['src/napplets/native-published-source-port.ts'])
   else:self.assertEqual(port.read_bytes(),originals[port]);self.assertTrue(report['productionCompositionRestored']);self.assertTrue(report['sourceRestored']);self.assertEqual(report['restorationConflicts'],[])
 def test_selected_notification_and_configuration_modes_restore_after_success(self):
  for suite in ['configuration','notifications']:
   with self.subTest(suite=suite):self.execute(suite,'success')
 def test_both_selected_modes_restore_after_packaging_failure(self):
  for suite in ['configuration','notifications']:
   with self.subTest(suite=suite):self.execute(suite,'failure')
 def test_unknown_concurrent_source_change_is_preserved_and_fails_closed(self):
  for suite in ['configuration','notifications']:
   with self.subTest(suite=suite):self.execute(suite,'concurrent')
if __name__=='__main__':unittest.main()
