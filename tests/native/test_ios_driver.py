import contextlib
import copy
import io
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("hypergolic_ios_driver", Path(__file__).with_name("ios-driver.py"))
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


class LauncherTests(unittest.TestCase):
    def test_source_manifest_covers_nested_sources_configs_and_native_assets(self):
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            names = ("src/App.tsx", "src/shell/motion.ts", "src/deeper/state.ts", "package.json", "pnpm-lock.yaml",
                     "modules/napplet-host/ios/Host.swift", "modules/napplet-host/ios/Resources/assets-manifest.json", "index.published.fixture.tsx")
            for name in (*names, "modules/napplet-host/android/build/generated/cache"):
                path = repo / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(name)
            before = driver.source_manifest(repo)
            self.assertEqual(set(before), set(names))
            driver.validate_source_snapshot(before, driver.source_manifest(repo))
            (repo / "src/shell/motion.ts").write_text("changed gesture classifier")
            with self.assertRaises(RuntimeError): driver.validate_source_snapshot(before, driver.source_manifest(repo))

    def test_full_bundle_manifest_includes_debug_native_code_and_arbitrary_resources(self):
        with tempfile.TemporaryDirectory() as temporary:
            bundle = Path(temporary) / "Installed.app"
            (bundle / "Frameworks").mkdir(parents=True)
            for name in ("Stub", "Hypergolic.debug.dylib", "Frameworks/Native", "assets-manifest.json", "main.jsbundle", "unknown-resource"):
                (bundle / name).write_text(name)
            before = driver.bundle_manifest(bundle)
            self.assertEqual(len(before), 6)
            (bundle / "Hypergolic.debug.dylib").write_text("changed native host")
            self.assertNotEqual(before, driver.bundle_manifest(bundle))
            (bundle / "outside").symlink_to(Path(temporary))
            with self.assertRaises(RuntimeError):
                driver.bundle_manifest(bundle)

    def test_simulator_mode_cannot_install_or_configure_target_app(self):
        runner = "__TESTROOT__/Debug-iphonesimulator/HypergolicUITests-Runner.app"
        target = {
            "BlueprintName": "HypergolicUITests", "TestBundlePath": "__TESTHOST__/PlugIns/HypergolicUITests.xctest", "TestHostPath": runner,
            "UseUITargetAppProvidedByTests": True, "DependentProductPaths": [runner, runner + "/PlugIns/HypergolicUITests.xctest"],
            "UITargetAppEnvironmentVariables": {"APP_BACKDOOR": "1"}, "UITargetAppCommandLineArguments": ["reset"],
            "TestingEnvironmentVariables": {"DYLD_FRAMEWORK_PATH": "__PLATFORMS__/Frameworks"},
        }
        document = {"TestConfigurations": [{"TestTargets": [target]}]}
        configured = driver.simulator_run(document, "runner.id", "installed.app", "abcdef012345", "UX Lab 1", "ux-lab-1", 30)
        actual = driver.test_targets(configured)[0]
        self.assertNotIn("UseDestinationArtifacts", actual)
        self.assertTrue(actual["UseUITargetAppProvidedByTests"])
        for forbidden in ("UITargetAppPath", "UITargetAppEnvironmentVariables", "UITargetAppCommandLineArguments"):
            self.assertNotIn(forbidden, actual)
        self.assertEqual(actual["TestingEnvironmentVariables"]["DYLD_FRAMEWORK_PATH"], "__PLATFORMS__/Frameworks")
        actual["UITargetAppPath"] = "unexpected.app"
        with self.assertRaises(RuntimeError):
            driver.simulator_run(document, "runner.id", "installed.app", "abcdef012345", "UX Lab 1", "ux-lab-1", 30)

    def test_multiple_test_targets_rejected(self):
        with self.assertRaises(RuntimeError):
            driver.test_targets({"TestConfigurations": [{"TestTargets": [{}, {}]}]})

    def test_v1_generated_layout_supported(self):
        target = {"BlueprintName": "HypergolicUITests", "TestBundlePath": "bundle"}
        self.assertIs(driver.test_targets({"HypergolicUITests": target, "__xctestrun_metadata__": {}})[0], target)

    def test_stale_incomplete_duplicate_and_failed_receipts_rejected(self):
        report = {
            "kind": "hypergolic-ios-trace-v1", "scenario": "trace-host", "completed": True, "allChecksPassed": True,
            "checks": [{"name": name, "passed": True} for name in driver.EXPECTED_CHECKS],
            "observations": {"nonce": "abcdef012345", "bundleIdentifier": "installed.app"},
        }
        driver.validate_report(report, "abcdef012345", "installed.app")
        for mutation in (lambda r: r["observations"].update(nonce="previous"),
                         lambda r: r["observations"].update(bundleIdentifier="another.app"),
                         lambda r: r.update(completed=False),
                         lambda r: r["checks"][0].update(passed=False),
                         lambda r: r["checks"].append(r["checks"][0])):
            changed = copy.deepcopy(report)
            mutation(changed)
            with self.assertRaises(RuntimeError):
                driver.validate_report(changed, "abcdef012345", "installed.app")

    def test_workspace_receipts_are_bound_to_exact_scenario_checks(self):
        for scenario in ("switch-state", "gestures", "closing", "card-cancel"):
            report = {"kind": "hypergolic-ios-workspace-v1", "scenario": scenario, "completed": True,
                      "allChecksPassed": True, "checks": [{"name": name, "passed": True} for name in driver.SCENARIOS[scenario]["checks"]],
                      "observations": {"nonce": "abcdef012345", "bundleIdentifier": "installed.app"}}
            driver.validate_report(report, "abcdef012345", "installed.app", scenario)
            with self.assertRaises(RuntimeError):
                driver.validate_report(report, "abcdef012345", "installed.app", "trace-host")
            report["checks"].pop()
            with self.assertRaises(RuntimeError):
                driver.validate_report(report, "abcdef012345", "installed.app", scenario)

    def test_future_scenario_never_runs_commands_or_writes_output(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(driver.subprocess, "run") as command:
            output = Path(temporary) / "evidence"
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
                driver.main(["--udid", "00000000-0000-4000-8000-000000000001", "identity", "--output", str(output)])
            self.assertEqual(error.exception.code, 2)
            command.assert_not_called()
            self.assertFalse(output.exists())

    def test_published_host_is_bound_to_direct_isolated_fixture_before_device_work(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(driver.subprocess, "run") as command:
            output = Path(temporary) / "evidence"
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
                driver.main(["--udid", "00000000-0000-4000-8000-000000000001", "published-host",
                             "--bundle-id", "org.nostrocket.hypergolic.dev", "--output", str(output)])
            self.assertEqual(error.exception.code, 2)
            command.assert_not_called()
            self.assertFalse(output.exists())
        bundle = "org.nostrocket.hypergolic.publishedhostfixture"
        report = {"kind": "hypergolic-ios-published-host-v1", "scenario": "published-host", "completed": True,
                  "allChecksPassed": True, "checks": [{"name": name, "passed": True}
                                                        for name in driver.SCENARIOS["published-host"]["checks"]],
                  "observations": {"nonce": "abcdef012345", "bundleIdentifier": bundle}}
        driver.validate_report(report, "abcdef012345", bundle, "published-host")
        report["checks"].pop()
        with self.assertRaises(RuntimeError):
            driver.validate_report(report, "abcdef012345", "org.nostrocket.hypergolic.identityuifixture", "published-host")

    def test_published_update_is_bound_to_public_only_fixture_before_device_work(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(driver.subprocess, "run") as command:
            output = Path(temporary) / "evidence"
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
                driver.main(["--udid", "00000000-0000-4000-8000-000000000001", "published-update",
                             "--bundle-id", "org.nostrocket.hypergolic.dev", "--output", str(output)])
            self.assertEqual(error.exception.code, 2)
            command.assert_not_called()
            self.assertFalse(output.exists())
        bundle = "org.nostrocket.hypergolic.publishedupdatefixture"
        report = {"kind": "hypergolic-ios-published-update-v1", "scenario": "published-update", "completed": True,
                  "allChecksPassed": True, "checks": [{"name": name, "passed": True}
                                                        for name in driver.SCENARIOS["published-update"]["checks"]],
                  "observations": {"nonce": "abcdef012345", "bundleIdentifier": bundle}}
        driver.validate_report(report, "abcdef012345", bundle, "published-update")
        report["checks"].pop()
        with self.assertRaises(RuntimeError):
            driver.validate_report(report, "abcdef012345", bundle, "published-update")

    def test_changed_access_is_bound_to_public_fixture_and_exact_receipt(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(driver.subprocess, "run") as command:
            output = Path(temporary) / "evidence"
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
                driver.main(["--udid", "00000000-0000-4000-8000-000000000001", "changed-access",
                             "--bundle-id", "org.nostrocket.hypergolic.dev", "--output", str(output)])
            self.assertEqual(error.exception.code, 2)
            command.assert_not_called()
            self.assertFalse(output.exists())
        bundle = "org.nostrocket.hypergolic.publishedupdatefixture"
        report = {"kind": "hypergolic-ios-changed-access-v1", "scenario": "changed-access", "completed": True,
                  "allChecksPassed": True, "checks": [{"name": name, "passed": True}
                                                        for name in driver.SCENARIOS["changed-access"]["checks"]],
                  "observations": {"nonce": "abcdef012345", "bundleIdentifier": bundle}}
        driver.validate_report(report, "abcdef012345", bundle, "changed-access")
        report["checks"].pop()
        with self.assertRaises(RuntimeError):
            driver.validate_report(report, "abcdef012345", bundle, "changed-access")

    def test_live_published_is_bound_to_public_fixture_and_exact_receipt(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(driver.subprocess, "run") as command:
            output = Path(temporary) / "evidence"
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
                driver.main(["--udid", "00000000-0000-4000-8000-000000000001", "live-published",
                             "--bundle-id", "org.nostrocket.hypergolic.dev", "--output", str(output)])
            self.assertEqual(error.exception.code, 2)
            command.assert_not_called()
            self.assertFalse(output.exists())
        bundle = "org.nostrocket.hypergolic.livepublishedfixture"
        report = {"kind": "hypergolic-ios-live-published-v1", "scenario": "live-published", "completed": True,
                  "allChecksPassed": True, "checks": [{"name": name, "passed": True}
                                                    for name in driver.SCENARIOS["live-published"]["checks"]],
                  "observations": {"nonce": "abcdef012345", "bundleIdentifier": bundle}}
        driver.validate_report(report, "abcdef012345", bundle, "live-published")
        report["checks"].pop()
        with self.assertRaises(RuntimeError):
            driver.validate_report(report, "abcdef012345", bundle, "live-published")

    def test_source_manifest_includes_changed_access_signed_fixture(self):
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            fixture = repo / "tests/napplets/fixtures/changed-access-fixture.ts"
            fixture.parent.mkdir(parents=True)
            fixture.write_text("public signed fixture")
            self.assertIn("tests/napplets/fixtures/changed-access-fixture.ts", driver.source_manifest(repo))

    def test_source_manifest_includes_published_update_fixture_entry(self):
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            entry = repo / "tests/native/published-update-fixtures/index.tsx"
            entry.parent.mkdir(parents=True)
            entry.write_text("public fixture entry")
            self.assertIn("tests/native/published-update-fixtures/index.tsx", driver.source_manifest(repo))

    def test_live_update_scenarios_require_isolated_bundle_and_exact_receipts(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(driver.subprocess, "run") as command:
            output = Path(temporary) / "evidence"
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
                driver.main(["--udid", "00000000-0000-4000-8000-000000000001", "live-update-v1",
                             "--bundle-id", "org.nostrocket.hypergolic.dev", "--output", str(output)])
            self.assertEqual(error.exception.code, 2)
            command.assert_not_called()
            self.assertFalse(output.exists())
        bundle = "org.nostrocket.hypergolic.livepublishedfixture"
        for scenario in ("live-update-v1", "live-update-v2"):
            report = {"kind": "hypergolic-ios-live-update-v1", "scenario": scenario, "completed": True,
                      "allChecksPassed": True, "checks": [{"name": name, "passed": True}
                                                        for name in driver.SCENARIOS[scenario]["checks"]],
                      "observations": {"nonce": "abcdef012345", "bundleIdentifier": bundle}}
            driver.validate_report(report, "abcdef012345", bundle, scenario)
            report["checks"].pop()
            with self.assertRaises(RuntimeError):
                driver.validate_report(report, "abcdef012345", bundle, scenario)

    def test_source_manifest_includes_live_fixture_and_publication_handoff(self):
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            for name in ("tests/native/live-published-fixture/index.tsx",
                         "tests/native/live-update-publication/release-pair.mjs"):
                path = repo / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("public QA source")
            manifest = driver.source_manifest(repo)
            self.assertIn("tests/native/live-published-fixture/index.tsx", manifest)
            self.assertIn("tests/native/live-update-publication/release-pair.mjs", manifest)

    def test_implicit_booted_selector_rejected_before_any_command(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(driver.subprocess, "run") as command:
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
                driver.main(["--udid", "booted", "trace-host", "--output", str(Path(temporary) / "evidence")])
            self.assertEqual(error.exception.code, 2)
            command.assert_not_called()


if __name__ == "__main__":
    unittest.main()
