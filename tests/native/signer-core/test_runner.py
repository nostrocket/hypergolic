"""Central routing/evidence regressions with real disposable subprocesses, no native/device proof."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('signer_runner', Path(__file__).with_name('run.py'))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

FAKE = '''import argparse,json,sys
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);p.add_argument('--serial');p.add_argument('--udid');p.add_argument('--provider');p.add_argument('--validator-only',action='store_true');a=p.parse_args()
source=Path(__file__);modefile=source.with_suffix('.mode.json');mode=json.loads(modefile.read_text()) if modefile.exists() else {}
a.output.mkdir();(a.output/'called.json').write_text(json.dumps(vars(a),default=str))
v={'status':'passed','passed':True,'assertions':2,'independentAssertions':1,'nativeAssertions':2,'cases': [1] if 'run-controller' in source.name else 1};v.update(mode.get('receipt',{}))
if not mode.get('noReceipt'):
 for name in ['receipt.json','result.json']:(a.output/name).write_text(json.dumps(v))
if mode.get('drift'):source.write_text(source.read_text()+'\\n# changed during child\\n')
sys.exit(mode.get('exit',0))
'''


class DriverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.original = runner.BASE
        runner.BASE = self.root / 'drivers'
        for relative in ['android/run.py', 'android/migration.py', 'ios/run.py', 'ios/run-persistence.py',
                         'ios/run-nip46.py', 'nip46/android/run.py', 'nip55/android/run-controller.py']:
            path = runner.BASE / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(FAKE)
        self.provider = self.root / 'provider'
        self.provider.mkdir()
        for name in ['build.json', 'provider.apk']:
            (self.provider / name).write_text('disposable host-test input, not a provider product')

    def tearDown(self):
        runner.BASE = self.original
        self.temp.cleanup()

    def run_suite(self, platform='android', suite='all', extra=(), selector=True):
        out = self.root / ('output-' + str(len(list(self.root.glob('output-*')))))
        args = ['--platform', platform, '--suite', suite, '--output', str(out)]
        if selector:
            args += ['--serial', 'emulator-5554'] if platform == 'android' else ['--udid', 'test-simulator']
        if platform == 'android' and suite in ('nip55', 'all'):
            args += ['--provider', str(self.provider)]
        with contextlib.redirect_stdout(io.StringIO()):
            code = runner.main(['--', *args, *extra])
        return code, out, json.loads((out / 'receipt.json').read_text())

    def mode(self, path, value):
        (runner.BASE / path).with_suffix('.mode.json').write_text(json.dumps(value))

    def test_android_all_routes_every_defined_suite_and_validator_flag(self):
        code, out, report = self.run_suite()
        self.assertEqual(code, 0)
        self.assertEqual(report['counts']['passed'], 5)
        self.assertEqual(report['requiredCases'], 5)
        called = json.loads((out / 'nip55-validators/called.json').read_text())
        self.assertTrue(called['validator_only'])
        self.assertEqual(called['serial'], 'emulator-5554')
        called = json.loads((out / 'nip55-controller/called.json').read_text())
        self.assertEqual(called['provider'], str(self.provider.resolve()))
        self.assertEqual(len({tuple(row['command']) for row in report['cases']}), 5)

    def test_ios_all_excludes_android_only_case_without_counting_it_passed(self):
        code, out, report = self.run_suite(platform='ios')
        self.assertEqual(code, 0)
        self.assertEqual(report['requiredCases'], 3)
        self.assertEqual(report['counts']['passed'], 3)
        self.assertEqual(report['counts']['not-applicable'], 1)
        self.assertFalse((out / 'nip55').exists())
        self.assertEqual(json.loads((out / 'core/called.json').read_text())['udid'], 'test-simulator')

    def test_explicit_core_selector_is_forwarded(self):
        code, out, report = self.run_suite(suite='core')
        self.assertEqual(code, 0)
        self.assertEqual(report['requiredCases'], 1)
        self.assertEqual(json.loads((out / 'core/called.json').read_text())['serial'], 'emulator-5554')

    def test_ios_nip55_alone_is_unsupported_and_nonpassing(self):
        code, out, report = self.run_suite(platform='ios', suite='nip55')
        self.assertEqual(code, 1)
        self.assertFalse(report['passed'])
        self.assertEqual(report['counts']['unsupported'], 1)
        self.assertFalse(list(out.glob('*/called.json')))

    def test_missing_provider_blocks_whole_selection_without_dispatch(self):
        (self.provider / 'provider.apk').unlink()
        code, out, report = self.run_suite()
        self.assertEqual(code, 1)
        self.assertEqual(report['counts']['blocked'], 1)
        self.assertEqual(report['counts']['not-run'], 4)
        self.assertFalse(list(out.glob('*/called.json')))

    def test_missing_device_input_is_not_auto_selected_or_counted_passed(self):
        code, out, report = self.run_suite(selector=False)
        self.assertEqual(code, 1)
        self.assertEqual(report['counts']['blocked'], 5)
        self.assertFalse(list(out.glob('*/called.json')))

    def test_failed_child_stops_before_any_later_device_peer_dispatch(self):
        self.mode('android/migration.py', {'exit': 7})
        code, out, report = self.run_suite()
        self.assertEqual(code, 1)
        self.assertEqual(report['counts']['passed'], 1)
        self.assertEqual(report['counts']['failed'], 1)
        self.assertEqual(report['counts']['not-run'], 3)
        self.assertFalse((out / 'nip46').exists())

    def test_zero_bool_missing_and_nonpassing_receipts_cannot_pass(self):
        for mode in [{'receipt': {'assertions': 0}}, {'receipt': {'assertions': True}},
                     {'receipt': {'passed': False}}, {'receipt': {'status': 'failed'}}, {'noReceipt': True}]:
            with self.subTest(mode=mode):
                self.mode('android/run.py', mode)
                code, _, report = self.run_suite(suite='core')
                self.assertEqual(code, 1)
                self.assertFalse(report['passed'])
                self.assertEqual(report['counts']['failed'], 1)

    def test_zero_ios_cases_and_empty_controller_cases_fail(self):
        self.mode('ios/run.py', {'receipt': {'cases': 0}})
        self.assertEqual(self.run_suite(platform='ios', suite='core')[0], 1)
        self.mode('nip55/android/run-controller.py', {'receipt': {'cases': []}})
        code, _, report = self.run_suite(suite='nip55')
        self.assertEqual(code, 1)
        self.assertEqual(report['counts']['passed'], 1)
        self.assertEqual(report['counts']['failed'], 1)

    def test_driver_drift_fails_and_preserves_unrun_cases(self):
        self.mode('android/run.py', {'drift': True})
        code, _, report = self.run_suite()
        self.assertEqual(code, 1)
        self.assertEqual(report['counts']['not-run'], 4)

    def test_existing_output_is_never_overwritten(self):
        out = self.root / 'existing'
        out.mkdir()
        sentinel = out / 'receipt.json'
        sentinel.write_text('historical failure')
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            runner.main(['--platform', 'android', '--suite', 'all', '--output', str(out)])
        self.assertEqual(sentinel.read_text(), 'historical failure')

    def test_wrong_platform_and_physical_serial_are_rejected(self):
        for extra in [['--udid', 'foreign'], ['--serial', 'physical-phone']]:
            with self.subTest(extra=extra), self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                runner.main(['--platform', 'android', '--suite', 'core', *extra])


if __name__ == '__main__':
    unittest.main()
