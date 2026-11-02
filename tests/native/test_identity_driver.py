import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('identity_driver', Path(__file__).with_name('identity_driver.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
PACKAGE = 'org.example.app'
PUBLIC = 'npub1' + 'q' * 58  # Shape-only test input; actual checksum tests use the owning Nostr decoder separately.


def control(identifier, text='', description='', kind='android.widget.Button', **extras):
    return {'resource-id': identifier, 'package': PACKAGE, '_webview-depth': 0, 'enabled': 'true',
            'bounds': '[20,20][100,100]', 'text': text, 'content-desc': description, 'class': kind, **extras}


def header():
    return control('shell-settings', description='Settings for ' + PUBLIC)


class IdentityHelperTests(unittest.TestCase):
    def test_native_header_and_exact_settings_value_are_required(self):
        self.assertEqual(module.header_identity([header()], PACKAGE)[1], PUBLIC)
        node = control('settings-full-npub', PUBLIC, kind='android.widget.TextView')
        self.assertIs(module.settings_identity([node], PACKAGE, PUBLIC), node)
        for wrong in ('different', PUBLIC[:-1], ''):
            with self.assertRaises(RuntimeError):
                module.settings_identity([dict(node, text=wrong)], PACKAGE, PUBLIC)

    def test_ambiguous_foreign_webview_hidden_disabled_and_fake_ids_fail(self):
        valid = header()
        bad_sets = [[valid, valid], [dict(valid, package='another.app')], [dict(valid, **{'_webview-depth': 1})],
                    [dict(valid, bounds='[0,0][0,0]')], [dict(valid, enabled='false')],
                    [dict(valid, **{'resource-id': 'fake-shell-settings'})],
                    [dict(valid, **{'content-desc': 'Settings'})]]
        for rows in bad_sets:
            with self.subTest(rows=rows), self.assertRaises(RuntimeError):
                module.header_identity(rows, PACKAGE)

    def test_process_retirement_and_distinct_single_pid(self):
        module.require_retired(SimpleNamespace(returncode=1, stdout='', stderr=''))
        module.require_new_pid('100', '101')
        for value in ('0', '-1', '100 101', '100\n', '', 'worker'):
            with self.assertRaises(RuntimeError): module.single_pid(value)
        for code, output, error in ((0, '', ''), (0, '100', ''), (1, ' ', ''),
                                    (1, '', 'error: device offline'), (127, '', ''), (1, '', '\n')):
            with self.assertRaises(RuntimeError):
                module.require_retired(SimpleNamespace(returncode=code, stdout=output, stderr=error))
        with self.assertRaises(RuntimeError): module.require_new_pid('100', '100')

    def test_source_snapshot_includes_both_native_modules_and_ignores_generated_builds(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            names = ('src/security/store.ts', 'src/App.tsx', 'modules/identity-store/ios/Store.swift',
                     'modules/identity-owner/android/Owner.kt', 'runtime/dist/host.js', 'pnpm-lock.yaml', 'plugins/config.cjs')
            for name in (*names, 'modules/identity-store/android/build/output'):
                path = source / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text(name)
            before = module.source_snapshot(source)
            self.assertEqual(set(before), set(names))
            (source / names[0]).write_text('changed')
            with self.assertRaises(RuntimeError): module.require_equal(before, module.source_snapshot(source), 'Source')

    def test_invalid_cli_and_existing_output_fail_before_base_driver_or_device(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(module, 'load_base') as load:
            base = ['--source', temporary, '--serial', 'emulator-0000', '--node', 'node', '--expected-apk-sha256', 'a' * 64]
            for suffix in (['--output', temporary, 'identity-restart'], ['--output', temporary + '/new', 'unknown']):
                with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit): module.main(base + suffix)
            load.assert_not_called()

    def test_missing_decoder_count_or_wrong_npub_cannot_pass(self):
        encoded = {'headerBefore': PUBLIC}
        for value in ({'passed': True, 'npub': PUBLIC}, {'passed': True, 'npub': PUBLIC, 'validatedCount': True},
                      {'passed': True, 'npub': 'changed', 'validatedCount': 4}):
            with patch.object(module.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=json.dumps(value))), self.assertRaises(RuntimeError):
                module.validate_encoding(encoded, Path('.'), 'node')


class ScenarioTests(unittest.TestCase):
    def driver(self):
        return SimpleNamespace(adb='adb', args=SimpleNamespace(serial='emulator-0000', package=PACKAGE, source=Path('.'), node='node'), result={},
                               check=lambda name, details: None)

    def test_two_observed_rounds_reach_decoder_only_after_a_new_process(self):
        d = self.driver(); flow = module.IdentityRestart(d)
        a = {'header': PUBLIC, 'settings': PUBLIC}
        with patch.object(flow, 'cold_launch', return_value={'stoppedPidOutput': ''}) as cold, \
             patch.object(flow, 'settings', side_effect=[a, a]), patch.object(flow, 'adb', side_effect=['100', '101']), \
             patch.object(module, 'validate_encoding', return_value={'passed': True, 'validatedCount': 4}) as decode:
            flow.run()
        self.assertEqual(cold.call_count, 2)
        self.assertEqual(d.result['finalPid'], '101')
        self.assertEqual(decode.call_args.args[0], dict(zip(('headerBefore', 'settingsBefore', 'headerAfter', 'settingsAfter'), [PUBLIC] * 4)))

    def test_changed_identity_or_same_process_stops_before_decoder(self):
        a = {'header': PUBLIC, 'settings': PUBLIC}
        for second, pid in ((dict(a, header='changed'), '101'), (a, '100')):
            flow = module.IdentityRestart(self.driver())
            with patch.object(flow, 'cold_launch', return_value={}), patch.object(flow, 'settings', side_effect=[a, second]), \
                 patch.object(flow, 'adb', side_effect=['100', pid]), patch.object(module, 'validate_encoding') as decode, self.assertRaises(RuntimeError):
                flow.run()
            decode.assert_not_called()

    def test_transport_failure_cannot_masquerade_as_a_retired_process(self):
        for code, output, error in ((1, '', 'error: device offline'), (127, '', ''), (0, '100', ''), (0, '', '')):
            flow = module.IdentityRestart(self.driver())
            result = SimpleNamespace(returncode=code, stdout=output, stderr=error)
            with patch.object(flow, 'adb', return_value='') as command, \
                 patch.object(module.subprocess, 'run', return_value=result), self.assertRaises(RuntimeError):
                flow.cold_launch()
            command.assert_called_once_with('shell', 'am', 'force-stop', PACKAGE)

    def test_verified_retirement_is_required_before_a_successful_launch(self):
        for response in ('Status: error', 'Status: ok\nStatus: error', 'Status: ok'):
            flow = module.IdentityRestart(self.driver())
            retired = SimpleNamespace(returncode=1, stdout='', stderr='')
            with patch.object(flow, 'adb', side_effect=['', response]), \
                 patch.object(module.subprocess, 'run', return_value=retired) as query:
                if response == 'Status: ok':
                    self.assertEqual(flow.cold_launch()['processRetirement'], {'exitCode': 1, 'stdout': '', 'stderr': ''})
                else:
                    with self.assertRaises(RuntimeError): flow.cold_launch()
            self.assertEqual(query.call_args.args[0], ['adb', '-s', 'emulator-0000', 'shell', 'pidof', PACKAGE])

    def test_wrong_initial_apk_prevents_restart_and_native_taps(self):
        with tempfile.TemporaryDirectory() as temporary:
            class FakeDriver:
                def __init__(self, args): self.args=args; self.out=args.output; self.out.mkdir(); self.result={}
                def metadata(self): self.result['app']={'installedBaseApkSha256':'b'*64}
                def capture(self, name): pass
            with patch.object(module, 'load_base', return_value=SimpleNamespace(Driver=FakeDriver)), \
                 patch.object(module.IdentityRestart, 'run') as scenario, patch.object(module, 'source_snapshot', return_value={}), \
                 patch.object(module, 'harness_snapshot', return_value={}), contextlib.redirect_stdout(io.StringIO()):
                code = module.main(['--source', temporary, '--serial', 'emulator-0000', '--node', 'node', '--expected-apk-sha256', 'a'*64,
                                    '--output', temporary+'/new', 'identity-restart'])
            self.assertEqual(code, 1)
            scenario.assert_not_called()

    def test_main_snapshot_failure_changes_pass_and_nonzero_exit(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'new'
            class FakeDriver:
                def __init__(self, args): self.args=args; self.out=args.output; self.out.mkdir(); self.result={}
                def metadata(self): self.result['app']={'installedBaseApkSha256':'a'*64}
                def adb_run(self, *args): return '101'
                def capture(self, name): pass
            def scenario(flow): flow.driver.result['finalPid']='101'
            with patch.object(module, 'load_base', return_value=SimpleNamespace(Driver=FakeDriver)), \
                 patch.object(module.IdentityRestart, 'run', scenario), patch.object(module, 'source_snapshot', side_effect=[{'source':'old'}, {'source':'changed'}]), \
                 patch.object(module, 'harness_snapshot', return_value={'harness':'same'}), contextlib.redirect_stdout(io.StringIO()):
                status = module.main(['--source', temporary, '--serial', 'emulator-0000', '--node', 'node', '--expected-apk-sha256', 'a'*64,
                                      '--output', str(output), 'identity-restart'])
            self.assertEqual(status, 1)
            result = json.loads((output / 'result.json').read_text())
            self.assertEqual(result['status'], 'failed')
            self.assertIn('Application source', result['snapshotError'])


if __name__ == '__main__':
    unittest.main()
