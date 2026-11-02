import importlib.util
import json
from pathlib import Path
import plistlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('file_policy_runner', Path(__file__).with_name('runner.py'))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class RunnerTests(unittest.TestCase):
    def target(self):
        host = '__TESTROOT__/Debug-iphonesimulator/FilePolicyProbe.app'
        return {'TestHostPath': host, 'TestHostBundleIdentifier': runner.BUNDLE_ID,
                'DependentProductPaths': [host, host + '/PlugIns/FilePolicyTests.xctest'],
                'TestBundlePath': '__TESTHOST__/PlugIns/FilePolicyTests.xctest'}

    def validate(self, target):
        with tempfile.TemporaryDirectory(prefix='file-policy-runner-test-') as directory:
            base = Path(directory)
            app = base / 'Debug-iphonesimulator/FilePolicyProbe.app'
            app.mkdir(parents=True)
            (app / 'Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier': runner.BUNDLE_ID}))
            manifest = base / 'Probe.xctestrun'
            manifest.write_bytes(plistlib.dumps({'FilePolicyTests': target, '__xctestrun_metadata__': {}}))
            runner.validate_xctestrun(manifest, app)

    def test_admits_exact_owned_generated_host(self):
        self.validate(self.target())

    def test_rejects_foreign_host_or_dependency_or_filtered_suite(self):
        for change in [
            {'TestHostPath': '__TESTROOT__/Hypergolic.app'},
            {'TestHostBundleIdentifier': 'org.nostrocket.hypergolic.dev'},
            {'DependentProductPaths': ['__TESTROOT__/Hypergolic.app']},
            {'TestBundlePath': '__TESTHOST__/PlugIns/Other.xctest'},
            {'OnlyTestIdentifiers': ['SystemFilePolicyTests/one']},
            {'SkipTestIdentifiers': ['SystemFilePolicyTests/one']},
            {'IsUITestBundle': True},
        ]:
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                self.validate(dict(self.target(), **change))

    def test_v2_target_extraction_preserves_all_targets(self):
        first, second = self.target(), dict(self.target(), TestHostPath='foreign')
        self.assertEqual(runner.generated_targets({'TestConfigurations': [{'TestTargets': [first, second]}]}), [first, second])

    def test_full_product_manifest_detects_resource_change_and_external_link(self):
        with tempfile.TemporaryDirectory(prefix='file-policy-products-test-') as directory:
            base = Path(directory)
            app = base / 'Probe.app'
            app.mkdir()
            artifact = app / 'Probe.debug.dylib'
            artifact.write_bytes(b'fixture v1')
            before = runner.tree_manifest(app)
            artifact.write_bytes(b'fixture v2')
            self.assertNotEqual(before, runner.tree_manifest(app))
            (app / 'allowed').symlink_to('Probe.debug.dylib')
            self.assertIn('allowed', runner.tree_manifest(app))
            (app / 'outside').symlink_to(base)
            with self.assertRaises(RuntimeError):
                runner.tree_manifest(app)

    def test_source_attestation_rejects_changed_source(self):
        with tempfile.TemporaryDirectory(prefix='file-policy-source-test-') as directory:
            base = Path(directory)
            harness, repo = base / 'harness', base / 'repo'
            for name in runner.PRODUCTION:
                path = repo / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('TEST ONLY attestation fixture')
            for name in runner.HARNESS:
                path = harness / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('TEST ONLY harness fixture')
            expected = {name: runner.digest(repo / name) for name in runner.PRODUCTION}
            (harness / 'source-manifest.json').write_text(json.dumps({'files': expected}))
            with patch.object(runner, 'HERE', harness):
                self.assertEqual(runner.inputs(repo)['production'], expected)
                (repo / runner.PRODUCTION[0]).write_text('changed TEST ONLY fixture')
                with self.assertRaises(RuntimeError):
                    runner.inputs(repo)


if __name__ == '__main__':
    unittest.main()
