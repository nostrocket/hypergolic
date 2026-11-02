import contextlib
import importlib.util
import io
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location("approval_review", HERE / "approval_review.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
sys.path.pop(0)

PACKAGE = "org.nostrocket.hypergolic.identityfixture"
SELECTED = "npub1ccz8l9zpa47k6vz9gphftsrumpw80rjt3nhnefat4symjhrsnmjs38mnyd"


def row(identifier, *, text="", depth=0, package=PACKAGE, enabled="true"):
    return {"resource-id": identifier, "package": package, "_webview-depth": depth,
            "enabled": enabled, "bounds": "[10,10][110,60]", "text": text}


class ApprovalReviewHelpers(unittest.TestCase):
    def test_selected_npub_requires_canonical_public_value(self):
        self.assertEqual(module.public_npub(SELECTED), SELECTED)
        for value in ("", "nsec1" + "q" * 58, SELECTED[:-1], SELECTED + "q", "npub1" + "1" * 58):
            with self.subTest(value=value), self.assertRaises(ValueError):
                module.public_npub(value)

    def test_controls_must_be_observed_in_expected_package_and_bounds(self):
        valid = row("approval-sheet-reject")
        self.assertIs(module.descriptor([valid], "approval-sheet-reject", PACKAGE), valid)
        bad = [dict(valid, package="other.app"), dict(valid, **{"_webview-depth": 1}),
               dict(valid, bounds="[0,0][0,0]"), dict(valid, enabled="false"),
               dict(valid, **{"resource-id": "fake-approval-sheet-reject"})]
        for candidate in bad:
            with self.subTest(candidate=candidate), self.assertRaises(RuntimeError):
                module.descriptor([candidate], "approval-sheet-reject", PACKAGE)

    def test_webview_input_requires_observed_depth_and_enabled_control(self):
        virtual = row("content", depth=1)
        self.assertIs(module.descriptor([virtual], "content", PACKAGE, native_only=False), virtual)
        with self.assertRaises(RuntimeError):
            module.descriptor([virtual], "content", PACKAGE)
        with self.assertRaises(RuntimeError):
            module.descriptor([row("android:id/content")], "content", PACKAGE, native_only=False)

    def test_publisher_and_destinations_are_exact_public_configuration(self):
        observed = module.publisher_observation(module.PUBLIC_PUBLISHER + "\n" + module.PUBLIC_PUBLISHER_NPUB)
        self.assertEqual(observed["hex"], module.PUBLIC_PUBLISHER)
        rows = [row("publish-to", text="\n".join(module.DESTINATIONS))]
        self.assertEqual(module.destination_observations(rows, PACKAGE), list(module.DESTINATIONS))
        with self.assertRaises(RuntimeError):
            module.publisher_observation("f" * 64 + "\nnpub1" + "q" * 58)
        with self.assertRaises(RuntimeError):
            module.destination_observations([row("publish-to", text=module.DESTINATIONS[0])], PACKAGE)

    def test_cli_rejects_existing_output_and_never_loads_device_driver(self):
        with __import__("tempfile").TemporaryDirectory() as temporary:
            output = Path(temporary) / "existing"
            output.mkdir()
            argv = ["--source", temporary, "--serial", "emulator-5556", "--expected-apk-sha256", "a" * 64,
                    "--selected-npub", SELECTED, "--output", str(output), module.ApprovalReview.scenario]
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                module.main(argv)


class ApprovalFlowGuards(unittest.TestCase):
    def test_rejection_path_does_not_expose_an_approval_action(self):
        fake = SimpleNamespace(args=SimpleNamespace(package=PACKAGE, selected_npub=SELECTED, timeout=1), result={})
        flow = module.ApprovalReview(fake)
        self.assertEqual(flow.marker, "ApprovalLabNativeReject")
        self.assertNotIn("approve", " ".join(flow.actions).casefold())

    def test_public_input_observes_frozen_public_fixture_note(self):
        class FakeDriver:
            def __init__(self):
                self.args = SimpleNamespace(package=PACKAGE, selected_npub=SELECTED, timeout=1)
                self.result = {}
                self.text = "Approval Lab test note"
                self.commands = []
            def wait(self, predicate, _description):
                rows = [row("content", text=self.text, depth=1)]
                self.assert_predicate = predicate
                if not predicate(rows): raise AssertionError("fake observed content control was not accepted")
                return b"", rows
            def tap(self, _row): pass
            def adb_run(self, *args, **_kwargs):
                self.commands.append(args)
                return ""
        fake = FakeDriver()
        self.assertEqual(module.ApprovalReview(fake).public_input("ApprovalLabExactNote"),
                         "Approval Lab test note")
        self.assertEqual(fake.text, "Approval Lab test note")
        self.assertEqual(fake.commands, [])


if __name__ == "__main__":
    unittest.main()
