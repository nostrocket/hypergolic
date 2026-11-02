#!/usr/bin/env python3
"""Public XCTest driver for an already-installed app on an explicitly named simulator."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = ROOT / "ios" / "XCTest"
EXPECTED_CHECKS = {
    "native-runtime-ready", "fixture-ready-and-theme", "counter-input-and-delta",
    "native-text-input", "typed-rendered-mirror",
}
SCENARIOS = {
    "ui-style": {"checks": {"empty-shelf", "address-validation", "grouped-identity-settings", "workspace-navigation", "close-protection", "trusted-review"}, "kind": "hypergolic-ios-workspace-v1", "test": "WorkspaceTests/testUIStyle"},
    "identity-delete-unavailable": {"checks": {"delete-exact-target", "unavailable-has-no-confirm", "cancel-keeps-workspace"}, "kind": "hypergolic-ios-workspace-v1", "test": "WorkspaceTests/testIdentityDeleteUnavailable"},
    "state-close": {"checks": {"state-close-warning", "state-reopen-shared", "state-reopen-instance"}, "kind": "hypergolic-ios-workspace-v1", "test": "WorkspaceTests/testStateClose"},
    "state-storage": {"checks": {"state-identity", "state-storage-operations", "state-restart", "state-instance-scope", "state-owner-isolation", "state-identity-isolation"}, "kind": "hypergolic-ios-workspace-v1", "test": "WorkspaceTests/testStateStorage"},
    "identity-switch": {"checks": {"identity-settings-safe-area", "identity-cancel-retains-live-state", "identity-import-restarts-all", "identity-duplicate-and-selector", "identity-selection-after-restart"}, "kind": "hypergolic-ios-workspace-v1", "test": "WorkspaceTests/testIdentitySwitch"},
    "workspace-restart": {"checks": {"selected-napplet-after-restart", "opening-order-after-restart", "explicit-empty-after-restart"}, "kind": "hypergolic-ios-workspace-v1", "test": "WorkspaceTests/testWorkspaceRestart"},
    "card-cancel": {"checks": {"short-card-stroke-cancel", "two-touch-card-cancel", "cancelled-card-state-retained"}, "kind": "hypergolic-ios-workspace-v1", "test": "WorkspaceTests/testCardCancellation"},
    "closing": {"checks": {"seed-close-state", "gentle-overview-scroll", "rapid-swipe-warning", "keep-open-retains-state", "close-removes-only-target", "other-session-state-retained", "visible-close-controls", "quiet-empty-overview", "empty-settings-and-open"}, "kind": "hypergolic-ios-workspace-v1", "test": "WorkspaceTests/testClosing"},
    "trace-host": {"checks": EXPECTED_CHECKS, "kind": "hypergolic-ios-trace-v1", "test": "HostTraceTests/testHostTrace"},
    "switch-state": {"checks": {"seed-a", "seed-b-isolated", "edge-roundtrip-a", "two-column-overview", "overview-restore-b", "stop-at-last", "stop-at-first-and-restore-a"}, "kind": "hypergolic-ios-workspace-v1", "test": "WorkspaceTests/testSwitchState"},
    "gestures": {"checks": {"vertical-content-scroll", "horizontal-content-scroll", "marker-selection", "scroll-and-selection-retained"}, "kind": "hypergolic-ios-workspace-v1", "test": "WorkspaceTests/testGestures"},
    "approval-review": {"checks": {"exact-public-review", "reject-denies-sdk", "dismiss-pauses-queue", "background-preserves-pending"}, "kind": "hypergolic-ios-workspace-v1", "test": "WorkspaceTests/testApprovalReview"},
    "published-host": {"checks": {"review-exact-signed-fixture", "native-host-connected", "close-returns-to-fixture"}, "kind": "hypergolic-ios-published-host-v1", "test": "WorkspaceTests/testPublishedHost"},
    "live-published": {"checks": {"live-native-relay-https", "live-first-open-exact-review", "live-guest-connected"}, "kind": "hypergolic-ios-live-published-v1", "test": "WorkspaceTests/testLivePublished"},
    "published-update": {"checks": {"public-fixture-and-runtime", "first-open-exact-review", "update-cancel-retains-old", "update-accept-replaces-host", "cold-restart-retains-v2", "rollback-rejected-after-restart", "background-retains-verified-v2"}, "kind": "hypergolic-ios-published-update-v1", "test": "WorkspaceTests/testPublishedUpdate"},
    "live-update-v1": {"checks": {"live-public-fixture", "live-first-open-exact-review", "live-v1-connected"}, "kind": "hypergolic-ios-live-update-v1", "test": "WorkspaceTests/testLiveUpdateV1"},
    "live-update-v2": {"checks": {"live-v1-before-update", "live-update-exact-review", "live-decline-retains-v1", "live-accept-renders-v2", "live-cold-restart-retains-v2"}, "kind": "hypergolic-ios-live-update-v1", "test": "WorkspaceTests/testLiveUpdateV2"},
    "changed-access": {"checks": {"public-fixture-and-runtime", "first-open-exact-review", "update-review-exact-candidate", "changed-access-decline-retains-v1", "changed-access-accept-replaces-host"}, "kind": "hypergolic-ios-changed-access-v1", "test": "WorkspaceTests/testChangedAccess"},
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def bundle_manifest(bundle: Path) -> dict:
    """Hash the full installed app bundle, including debug dylibs and resources, never app data."""
    resolved = bundle.resolve()
    files = {}
    for path in sorted(bundle.rglob("*")):
        if path.is_symlink():
            target = path.resolve(strict=True)
            if not target.is_relative_to(resolved):
                raise RuntimeError("Installed app bundle symlink escapes its bundle: " + str(path))
            files[str(path.relative_to(bundle))] = {"symlink": os.readlink(path)}
        elif path.is_file():
            files[str(path.relative_to(bundle))] = {"sha256": sha256(path), "bytes": path.stat().st_size}
    return files


def source_manifest(repo: Path) -> dict:
    paths = set()
    for directory in ("src", "runtime/src", "runtime/fixtures", "runtime/dist", "modules/napplet-host", "assets", "scripts", "tests/native/published-update-fixtures", "tests/native/live-published-fixture", "tests/native/live-update-publication", "tests/napplets/fixtures"):
        for path in (repo / directory).rglob("*"):
            relative = path.relative_to(repo)
            if path.is_file() and not {"build", ".gradle", "node_modules", ".expo"}.intersection(relative.parts):
                paths.add(path)
    for name in ("package.json", "pnpm-lock.yaml", "app.json", "app.config.ts", "app.config.js", "babel.config.js",
                 "babel.config.cjs", "metro.config.js", "metro.config.cjs", "index.ts", "index.fixture.tsx", "index.published.fixture.tsx", "runtime/package.json", "runtime/pnpm-lock.yaml"):
        path = repo / name
        if path.is_file():
            paths.add(path)
    return {str(path.relative_to(repo)): sha256(path) for path in sorted(paths)}


def test_targets(document: dict) -> list[dict]:
    """Support Apple's generated v1 and v2 xctestrun layouts, fail on ambiguity."""
    if "TestConfigurations" in document:
        targets = [target for config in document["TestConfigurations"]
                   if config.get("IsEnabled", True) for target in config.get("TestTargets", [])]
    else:
        targets = [value for name, value in document.items()
                   if not name.startswith("__") and isinstance(value, dict) and "TestBundlePath" in value]
    if len(targets) != 1 or targets[0].get("BlueprintName", "HypergolicUITests") != "HypergolicUITests":
        raise RuntimeError("Expected exactly one generated HypergolicUITests test target")
    return targets


def simulator_run(document: dict, runner_id: str, bundle_id: str, nonce: str,
                    title: str, session: str, timeout: float, scenario: str = "trace-host") -> dict:
    for target in test_targets(document):
        runner_path = "__TESTROOT__/Debug-iphonesimulator/HypergolicUITests-Runner.app"
        allowed = {runner_path, runner_path + "/PlugIns/HypergolicUITests.xctest"}
        if (target.get("UseUITargetAppProvidedByTests") is not True or "UITargetAppPath" in target
                or target.get("TestHostPath") != runner_path
                or target.get("TestBundlePath") != "__TESTHOST__/PlugIns/HypergolicUITests.xctest"
                or set(target.get("DependentProductPaths", [])) != allowed):
            raise RuntimeError("Generated Simulator test configuration must contain only the owned runner and no app target")
        for key in ("UITargetAppEnvironmentVariables", "UITargetAppCommandLineArguments"):
            target.pop(key, None)
        target.update({
            "TestHostBundleIdentifier": runner_id,
            "ParallelizationEnabled": False,
            "SystemAttachmentLifetime": "keepAlways",
            "UserAttachmentLifetime": "keepAlways",
            "OnlyTestIdentifiers": [SCENARIOS[scenario]["test"]],
        })
        target.setdefault("EnvironmentVariables", {}).update({
            "HG_TARGET_BUNDLE_ID": bundle_id, "HG_SCENARIO": scenario, "HG_NONCE": nonce,
            "HG_EXPECTED_TITLE": title, "HG_EXPECTED_SESSION": session, "HG_TIMEOUT": str(timeout),
        })
    return document


def validate_source_snapshot(before: dict, after: dict) -> None:
    if before != after:
        raise RuntimeError("Recorded app source changed during the run; native evidence cannot be bound to one checkout snapshot")


def validate_report(report: dict, nonce: str, bundle_id: str, scenario: str = "trace-host") -> None:
    checks = report.get("checks", [])
    expected = SCENARIOS[scenario]
    if (report.get("kind") != expected["kind"] or report.get("scenario") != scenario
            or report.get("completed") is not True or report.get("allChecksPassed") is not True
            or len(checks) != len(expected["checks"]) or {row.get("name") for row in checks} != expected["checks"]
            or not all(row.get("passed") is True for row in checks)
            or report.get("observations", {}).get("nonce") != nonce
            or report.get("observations", {}).get("bundleIdentifier") != bundle_id):
        raise RuntimeError("XCTest trace report is incomplete, failed, stale or belongs to another bundle")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--udid", required=True, help="Explicit already-booted iOS Simulator UUID; 'booted' is not accepted")
    parser.add_argument("--bundle-id", default="org.nostrocket.hypergolic.dev")
    parser.add_argument("--developer-dir", default=os.environ.get("DEVELOPER_DIR", "/Applications/Xcode.app/Contents/Developer"))
    parser.add_argument("--repo", type=Path, help="Optional read-only source correspondence metadata")
    parser.add_argument("--live-update-bundle", type=Path, help="Public signed QA handoff for live-update scenarios")
    parser.add_argument("--expected-title", default="UX Lab 1")
    parser.add_argument("--expected-session", default="ux-lab-1")
    parser.add_argument("--timeout", type=float, default=30)
    parser.add_argument("scenario", choices=["ui-style", "identity-delete-unavailable", "state-close", "state-storage", "identity-switch", "workspace-restart", "card-cancel", "trace-host", "switch-state", "gestures", "closing", "approval-review", "published-host", "live-published", "published-update", "live-update-v1", "live-update-v2", "changed-access", "identity", "host-boundary", "renderer-loss"])
    parser.add_argument("--output", type=Path, required=True, help="New private evidence directory, never overwritten")
    args = parser.parse_args(argv)
    if args.scenario not in SCENARIOS:
        parser.error(f"{args.scenario} is not implemented for iOS; no build or device action was attempted")
    if args.scenario == "published-host" and args.bundle_id != "org.nostrocket.hypergolic.publishedhostfixture":
        parser.error("published-host requires the isolated direct published-host fixture bundle")
    if args.scenario == "live-published" and args.bundle_id != "org.nostrocket.hypergolic.livepublishedfixture":
        parser.error("live-published requires the isolated public-only live fixture bundle")
    if args.scenario == "published-update" and args.bundle_id != "org.nostrocket.hypergolic.publishedupdatefixture":
        parser.error("published-update requires the isolated public-only published-update fixture bundle")
    if args.scenario == "changed-access" and args.bundle_id != "org.nostrocket.hypergolic.publishedupdatefixture":
        parser.error("changed-access requires the isolated public-only changed-access fixture bundle")
    live_fixture = None
    if args.scenario.startswith("live-update-"):
        if args.bundle_id != "org.nostrocket.hypergolic.livepublishedfixture" or not args.live_update_bundle:
            parser.error("live updates require the isolated public-only live fixture and --live-update-bundle")
        bundle_path = args.live_update_bundle.expanduser().resolve()
        inspected = subprocess.run(["node", str(ROOT / "live-update-publication" / "cli.mjs"),
                                    "inspect", "--bundle", str(bundle_path)],
                                   cwd=ROOT.parents[1], capture_output=True, text=True, timeout=20, check=False)
        if inspected.returncode:
            parser.error("signed live-update handoff verification failed: " + inspected.stderr[:200])
        live_fixture = json.loads(inspected.stdout)
        if live_fixture.get("relays") != ["wss://relay.damus.io"]:
            parser.error("live-update handoff relay is outside the fixture's normal Lookup list")
    elif args.live_update_bundle:
        parser.error("--live-update-bundle belongs only to live-update scenarios")
    if not re.fullmatch(r"[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}", args.udid):
        parser.error("--udid must be an explicit Simulator UUID")
    if not re.fullmatch(r"[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)+", args.bundle_id):
        parser.error("Invalid bundle ID")
    if not 1 <= args.timeout <= 60:
        parser.error("--timeout must be between 1 and 60 seconds")
    output = args.output.expanduser().resolve()
    output.mkdir(parents=True, exist_ok=False)
    environment = dict(os.environ, DEVELOPER_DIR=args.developer_dir)
    nonce = uuid.uuid4().hex[:12]
    result = {
        "kind": "hypergolic-ios-native-run-v1", "passed": False, "scenario": args.scenario,
        "nonce": nonce, "udid": args.udid, "bundleIdentifier": args.bundle_id,
        "startedAtUnix": time.time(), "commands": [],
        "limitations": [
            "Simulator UI trace only; physical device, release signing and iOS security attacks are not proved.",
            "No JavaScript evaluation: inaccessible counter values fail rather than inheriting browser or Hermes success.",
            "Screenshots require independent visual inspection; keyboard dismissal is recorded only, not asserted.",
            "Fixture input and scroll position are intentionally changed; application data is never wiped.",
            "Source hashes describe listed filesystem files, not the served Metro bundle bytes; no served-bundle observer is used.",
        ],
    }
    sequence = 0

    def run(arguments: list[str], *, timeout: float = 60, check: bool = True) -> subprocess.CompletedProcess:
        nonlocal sequence
        sequence += 1
        log = output / f"{sequence:02d}-{Path(arguments[0]).name}.log"
        result["commands"].append({"argv": arguments, "log": log.name})
        with log.open("w") as stream:
            process = subprocess.run(arguments, cwd=PROJECT_ROOT, env=environment, stdout=stream, stderr=subprocess.STDOUT, timeout=timeout, text=True)
        value = subprocess.CompletedProcess(arguments, process.returncode, log.read_text())
        if check and process.returncode:
            raise RuntimeError(f"Command failed ({process.returncode}); inspect {log}")
        return value

    def installed_metadata() -> dict:
        app = Path(run(["xcrun", "simctl", "get_app_container", args.udid, args.bundle_id, "app"]).stdout.strip())
        info = plistlib.loads((app / "Info.plist").read_bytes())
        if info.get("CFBundleIdentifier") != args.bundle_id:
            raise RuntimeError("Installed app bundle identifier mismatch")
        return {
            "container": str(app), "bundleIdentifier": info["CFBundleIdentifier"],
            "version": info.get("CFBundleShortVersionString"), "build": info.get("CFBundleVersion"),
            "minimumOSVersion": info.get("MinimumOSVersion"),
            "files": bundle_manifest(app),
        }

    def source_metadata() -> dict:
        if not args.repo:
            return {"recorded": False}
        return source_manifest(args.repo)

    try:
        result["xcodeVersion"] = run(["xcodebuild", "-version"]).stdout.strip()
        devices = json.loads(run(["xcrun", "simctl", "list", "devices", "available", "--json"]).stdout)
        matches = [(runtime, device) for runtime, group in devices["devices"].items() for device in group if device["udid"].lower() == args.udid.lower()]
        if len(matches) != 1 or matches[0][1].get("state") != "Booted":
            raise RuntimeError("Explicit simulator must already be available and Booted; no boot was attempted")
        result["simulator"] = {"runtime": matches[0][0], **matches[0][1]}
        result["installedBefore"] = installed_metadata()
        result["sourceBefore"] = source_metadata()
        result["harness"] = {str(path.relative_to(ROOT)): sha256(path) for path in [ROOT / "ios-driver.py", ROOT / "ios_touch_evidence.py", *PROJECT_ROOT.rglob("*")]
                             if path.is_file() and path.suffix in (".swift", ".py", ".pbxproj", ".xcscheme")}
        write_json(output / "result.json", result)
        derived = output / "DerivedData"
        run(["xcodebuild", "build-for-testing", "-project", str(PROJECT_ROOT / "HypergolicUITests.xcodeproj"),
             "-scheme", "HypergolicUITests", "-configuration", "Debug", "-sdk", "iphonesimulator",
             "-destination", "generic/platform=iOS Simulator", "-derivedDataPath", str(derived),
             "CODE_SIGNING_ALLOWED=NO"], timeout=300)
        products = derived / "Build/Products"
        runners = list(products.glob("Debug-iphonesimulator/HypergolicUITests-Runner.app"))
        manifests = list(products.glob("*.xctestrun"))
        if len(runners) != 1 or len(manifests) != 1:
            raise RuntimeError("Expected one standalone UI runner and one generated xctestrun")
        runner = runners[0]
        runner_id = plistlib.loads((runner / "Info.plist").read_bytes())["CFBundleIdentifier"]
        if runner_id != "org.nostrocket.hypergolic.uitests.xctrunner" or not (runner / "PlugIns/HypergolicUITests.xctest").is_dir():
            raise RuntimeError("Refusing to install an unexpected UI runner artifact")
        result["runner"] = {"bundleIdentifier": runner_id, "executableSha256": sha256(runner / "HypergolicUITests-Runner")}
        expected_title = "Signed host QA fixture" if args.scenario == "published-host" else args.expected_title
        expected_session = "published-host-qa-fixture" if args.scenario == "published-host" else args.expected_session
        document = simulator_run(plistlib.loads(manifests[0].read_bytes()), runner_id, args.bundle_id, nonce,
                                   expected_title, expected_session, args.timeout, args.scenario)
        if live_fixture:
            for target in test_targets(document):
                target["EnvironmentVariables"].update({
                    "HG_LIVE_NADDR": live_fixture["naddr"],
                    "HG_LIVE_PUBLISHER": live_fixture["publisher"],
                    "HG_LIVE_IDENTIFIER": live_fixture["identifier"],
                    "HG_LIVE_V1": live_fixture["v1"],
                    "HG_LIVE_V2": live_fixture["v2"],
                })
            result["liveFixture"] = live_fixture
        if args.scenario == "identity-switch":
            if args.bundle_id != "org.nostrocket.hypergolic.identityuifixture":
                raise RuntimeError("Identity UI scenario requires the isolated public-key fixture")
            helper = ROOT / "public-test-identity.mjs"
            fixture = json.loads(subprocess.check_output(["node", str(helper)], text=True, env=environment))
            result["publicFixtureHelperSha256"] = sha256(helper)
            for target in test_targets(document):
                target["EnvironmentVariables"].update({"HG_PUBLIC_TEST_NSEC": fixture["nsec"], "HG_PUBLIC_TEST_NPUB": fixture["npub"]})
        configured = products / "HypergolicSimulator.xctestrun"
        configured.write_bytes(plistlib.dumps(document))
        # Xcode installs only the validated standalone runner; no app build is supplied.
        bundle = output / "Tests.xcresult"
        test = run(["xcodebuild", "test-without-building", "-xctestrun", str(configured),
                    "-destination", "platform=iOS Simulator,id=" + args.udid,
                    "-parallel-testing-enabled", "NO", "-maximum-concurrent-test-simulator-destinations", "1",
                    "-resultBundlePath", str(bundle)], timeout=900 if live_fixture else 600, check=False)
        result["xcodeTestExitCode"] = test.returncode
        if not bundle.is_dir():
            raise RuntimeError("Xcode produced no result bundle")
        summary = run(["xcrun", "xcresulttool", "get", "test-results", "summary", "--path", str(bundle)], check=False)
        if summary.returncode == 0:
            result["testSummary"] = json.loads(summary.stdout)
            write_json(output / "test-summary.json", result["testSummary"])
        attachments = output / "attachments"
        run(["xcrun", "xcresulttool", "export", "attachments", "--path", str(bundle), "--output-path", str(attachments)])
        result["installedAfter"] = installed_metadata()
        result["sourceAfter"] = source_metadata()
        if result["installedBefore"]["files"] != result["installedAfter"]["files"]:
            raise RuntimeError("Installed application binary/assets changed during the run")
        if args.repo:
            validate_source_snapshot(result["sourceBefore"], result["sourceAfter"])
        reports = []
        for path in attachments.rglob("*"):
            if not path.is_file():
                continue
            try:
                candidate = json.loads(path.read_text())
                if isinstance(candidate, dict) and candidate.get("kind") == SCENARIOS[args.scenario]["kind"]:
                    reports.append(candidate)
            except (ValueError, UnicodeDecodeError):
                pass
        result["attachments"] = [{"path": str(path.relative_to(output)), "sha256": sha256(path),
                                  **({"visuallyInspected": False} if path.suffix.lower() == ".png" else {})}
                                 for path in attachments.rglob("*") if path.is_file()]
        if len(reports) != 1:
            raise RuntimeError(f"Expected one current trace report attachment; found {len(reports)}")
        result["trace"] = reports[0]
        write_json(output / ("trace-report.json" if args.scenario == "trace-host" else "workspace-report.json"), reports[0])
        validate_report(reports[0], nonce, args.bundle_id, args.scenario)
        if args.scenario == "card-cancel":
            from ios_touch_evidence import verify_two_touch_input, verify_short_stroke_input
            stimulus = next(value for value in reports[0]["gestures"] if value["name"] == "short-card-stroke")
            result["shortStrokeInput"] = verify_short_stroke_input(attachments, stimulus)
            result["twoTouchInput"] = verify_two_touch_input(attachments, reports[0]["observations"]["twoTouchTarget"]["bounds"])
        if test.returncode != 0:
            raise RuntimeError("XCTest failed despite a complete trace receipt; inspect result bundle")
        result["passed"] = True
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.TimeoutExpired) as error:
        result["error"] = str(error)
    finally:
        result["finishedAtUnix"] = time.time()
        write_json(output / "result.json", result)
    print(json.dumps({"passed": result["passed"], "result": str(output / "result.json"), "error": result.get("error")}, indent=2))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
