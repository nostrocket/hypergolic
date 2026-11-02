#!/usr/bin/env python3
"""Actual isolated Android Approval Lab publication journey via a loopback relay proof server.

This driver never types into the WebView, imports identities, calls native authority
methods, or bypasses the visible approval sheet. It requires the fixture's existing
public textarea value, selected scalar-2 identity, a sealed installed APK, and a
separately started local relay server.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import sys
import time
from urllib.parse import urlparse
from urllib.request import Request, urlopen

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from approval_review import ApprovalReview, DESTINATIONS, public_npub, sha256
from identity_driver import source_snapshot
sys.path.pop(0)

PACKAGE = "org.nostrocket.hypergolic.identityfixture"
ACTIVITY = "org.nostrocket.hypergolic.dev.MainActivity"
SELECTED_NPUB = "npub1ccz8l9zpa47k6vz9gphftsrumpw80rjt3nhnefat4symjhrsnmjs38mnyd"
EXPECTED_PUBKEY = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"
NOTE = "Approval Lab test note"
PATHS = {"/relay.damus.io", "/nos.lol", "/bucket.coracle.social"}
APK = re.compile(r"[a-f0-9]{64}")


def load_driver(source: Path):
    spec = importlib.util.spec_from_file_location("hypergolic_publication_driver", source / "tests/native/driver.py")
    if spec is None or spec.loader is None:
        raise RuntimeError("Selected source lacks native driver")
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(source / "tests/native"))
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path.pop(0)
    return module


def relay_ready(path: Path) -> dict:
    value = json.loads(path.read_text())
    if not isinstance(value, dict) or value.get("expectedPubkey") != EXPECTED_PUBKEY:
        raise RuntimeError("Relay ready file is not the scalar-2 local proof server")
    if not isinstance(value.get("nonce"), str) or not isinstance(value.get("status"), str) or not isinstance(value.get("control"), str):
        raise RuntimeError("Relay ready file lacks local control details")
    status, control = urlparse(value["status"]), urlparse(value["control"])
    if status.scheme != "http" or control.scheme != "http" or status.hostname != "127.0.0.1" or control.hostname != "127.0.0.1" or status.port != control.port or status.path != "/status" or control.path != "/control":
        raise RuntimeError("Relay ready file does not describe one local loopback control server")
    if value.get("relayPaths") != {"/relay.damus.io": DESTINATIONS[0], "/nos.lol": DESTINATIONS[1], "/bucket.coracle.social": DESTINATIONS[2]}:
        raise RuntimeError("Relay ready file does not map the reviewed three destinations")
    return value


def harness_snapshot(source: Path) -> dict:
    paths = {
        "approval_publication.py": HERE / "approval_publication.py",
        "approval_review.py": HERE / "approval_review.py",
        "source/tests/native/driver.py": source / "tests/native/driver.py",
        "source/tests/relay/native-review-server.mjs": source / "tests/relay/native-review-server.mjs",
    }
    return {name: sha256(path) for name, path in paths.items()}


class Publication:
    scenario = "approval-publication"

    def __init__(self, driver, ready: dict):
        self.driver = driver
        self.ready = ready
        self.review = ApprovalReview(driver)
        self.sequence = 1

    def server(self, body: dict) -> dict:
        request = Request(self.ready["control"], data=json.dumps(body).encode(), method="POST", headers={
            "content-type": "application/json", "x-local-review-nonce": self.ready["nonce"],
        })
        with urlopen(request, timeout=10) as response:
            if response.status != 200:
                raise RuntimeError("Local relay control rejected the requested mode")
            return json.loads(response.read())

    def receipt(self) -> dict:
        with urlopen(self.ready["status"], timeout=10) as response:
            if response.status != 200:
                raise RuntimeError("Local relay status endpoint was unavailable")
            return json.loads(response.read())

    def wait_receipt(self, expected_events: int) -> dict:
        deadline = time.monotonic() + self.driver.args.timeout
        while time.monotonic() < deadline:
            receipt = self.receipt()
            if receipt.get("counts", {}).get("EVENT", 0) >= expected_events:
                return receipt
            time.sleep(0.2)
        raise RuntimeError("Timed out waiting for local relay EVENT receipts")

    def wait_held_upgrades(self) -> dict:
        deadline = time.monotonic() + self.driver.args.timeout
        while time.monotonic() < deadline:
            receipt = self.receipt()
            if receipt.get("heldUpgrades") == 3 and not receipt.get("counts", {}):
                return receipt
            time.sleep(0.1)
        raise RuntimeError("Timed out waiting for three held loopback upgrades without protocol frames")

    def wait_empty_terminal_receipt(self) -> dict:
        deadline = time.monotonic() + self.driver.args.timeout
        while time.monotonic() < deadline:
            receipt = self.receipt()
            if receipt.get("heldUpgrades") == 0 and not receipt.get("counts", {}):
                return receipt
            time.sleep(0.2)
        raise RuntimeError("Background revocation allowed a held relay upgrade to emit a protocol frame")

    def assert_no_event(self, name: str):
        receipt = self.receipt()
        if receipt.get("counts", {}):
            raise RuntimeError("Local relay observed a protocol frame before visible approval")
        self.driver.check(name, {"eventFrames": 0, "authFrames": 0, "allFrames": 0})

    def assert_publication(self, receipt: dict, sequence: int, mode: str):
        frames = [frame for frame in receipt.get("frames", []) if frame.get("type") == "EVENT"]
        events = receipt.get("events", [])
        if len(frames) != 3 or len(events) != 3 or {frame.get("path") for frame in frames} != PATHS:
            raise RuntimeError("Expected exactly one EVENT at each reviewed loopback relay path")
        if receipt.get("counts", {}).get("AUTH", 0) != 0 or sum(receipt.get("counts", {}).values()) != 3:
            raise RuntimeError("Relay proof observed AUTH or an extra protocol frame")
        if not all(event.get("valid") is True for event in events):
            raise RuntimeError("Local relay did not independently verify every signed EVENT")
        wire = [frame.get("frame", [None, None])[1] for frame in frames]
        if len({frame.get("raw") for frame in frames}) != 1 or len({event.get("id") for event in wire}) != 1:
            raise RuntimeError("Reviewed relay EVENT bytes or IDs differ")
        expected_tags = [["t", "hypergolic-approval-lab"], ["test-sequence", str(sequence)]]
        if not all(event.get("pubkey") == EXPECTED_PUBKEY and event.get("kind") == 1 and event.get("content") == NOTE and event.get("tags") == expected_tags for event in wire):
            raise RuntimeError("Signed relay EVENT differs from the reviewed Approval Lab request")
        self.driver.check("three-identical-independently-verified-events-" + mode, {
            "paths": sorted(PATHS), "eventId": wire[0]["id"], "sequence": sequence, "authFrames": 0,
        })

    def save_terminal_receipt(self, mode: str, sequence: int, receipt: dict):
        path = self.driver.out / f"relay-{sequence}-{mode}.json"
        path.write_text(json.dumps(receipt, indent=2) + "\n")
        repeated = self.receipt()
        self.assert_publication(repeated, sequence, mode)
        if repeated.get("counts") != receipt.get("counts"):
            raise RuntimeError("Local relay receipt changed after terminal publication")
        self.driver.check("terminal-receipt-has-no-duplicate-events-" + mode, {"receipt": path.name, "events": 3})

    def observed_send(self) -> int:
        rows = self.review.wait_control("content")
        content = next(row for row in rows if row.get("resource-id", "").split("/")[-1] == "content" and row.get("_webview-depth") != 0)
        if content.get("text") != NOTE:
            raise RuntimeError("Approval Lab textarea differs from the unchanged observed public fixture note")
        self.review.tap_webview("send", "approval-lab-send-observed-note")
        sequence = self.sequence
        self.sequence += 1
        return sequence

    def wait_success(self, sequence: int):
        def success(rows):
            text = " ".join(row.get("text", "") for row in rows if row.get("package") == self.driver.args.package)
            return f"Request {sequence} published." in text and "Event ID " in text
        self.driver.wait(success, f"SDK publication result for request {sequence}")

    def wait_outcome(self, expected: str):
        def outcome(rows):
            has_status = any(row.get("resource-id", "").split("/")[-1] == "approval-outcome" for row in rows)
            visible_text = " ".join(row.get("text", "") for row in rows if row.get("package") == self.driver.args.package)
            return has_status and expected in visible_text
        self.driver.wait(outcome, "truthful native approval outcome")

    def dismiss_outcome(self):
        self.review.press("approval-outcome")
        self.review.absent("approval-outcome")

    def approve_mode(self, mode: str, expect_success: bool = False):
        self.server({"reset": True, "mode": mode})
        self.assert_no_event("no-event-before-visible-approval-" + mode)
        sequence = self.observed_send()
        self.review.review_sheet(NOTE)
        self.driver.capture(f"review-{mode}")
        self.assert_no_event("no-event-before-native-approve-" + mode)
        self.review.press("approval-sheet-approve")
        receipt = self.wait_receipt(3)
        self.assert_publication(receipt, sequence, mode)
        if expect_success:
            self.wait_success(sequence)
            self.wait_outcome("Published to 3 of 3 relays.")
            self.driver.check("sdk-success-and-truthful-native-outcome", {"sequence": sequence, "outcome": "Published to 3 of 3 relays."})
        else:
            expected = "Publication could not be confirmed." if mode == "close-after-send" else "No relay accepted the event."
            self.review.wait_sdk_denial(sequence, NOTE)
            self.wait_outcome(expected)
            self.driver.check("sdk-denial-and-truthful-native-outcome-" + mode, {"sequence": sequence, "outcome": expected})
        self.save_terminal_receipt(mode, sequence, self.receipt())
        self.dismiss_outcome()
        return sequence

    def run_revocation_only(self):
        self.driver.result["scope"] = "Visible isolated Android approval background-revocation journey against a held local loopback upgrade; no external relay, secret exposure/input, import, or hidden authority call."
        self.driver.result["limitations"] = [
            "Only the fixed public scalar-2 fixture identity and local loopback relay server are exercised.",
            "Held upgrades prove no relay protocol frame was sent before background revocation; they do not prove public relay delivery or iOS behavior.",
            "Textarea content is observed unchanged; this driver performs no keyboard automation.",
        ]
        self.review.cold_launch()
        self.review.open_settings()
        self.review.open_approval_lab()
        self.server({"reset": True, "mode": "hold-upgrade"})
        self.assert_no_event("no-frame-before-background-revocation-approval")
        sequence = self.observed_send()
        self.review.review_sheet(NOTE)
        self.review.press("approval-sheet-approve")
        held = self.wait_held_upgrades()
        self.driver.check("three-upgrades-held-before-background", {"heldUpgrades": held["heldUpgrades"], "frames": 0})
        # Do not inspect UI here: native background revocation must race the held sockets directly.
        self.review.adb("shell", "input", "keyevent", "3")
        self.review.adb("shell", "am", "start", "-W", "-n", self.driver.args.package + "/" + self.driver.args.activity)
        self.server({"mode": "accept", "release": True})
        self.review.wait_sdk_denial(sequence, NOTE)
        self.wait_outcome("Approval was not completed.")
        receipt = self.wait_empty_terminal_receipt()
        path = self.driver.out / f"relay-{sequence}-background-revocation.json"
        path.write_text(json.dumps(receipt, indent=2) + "\n")
        self.driver.check("background-revocation-releases-held-upgrades-without-event", {"receipt": path.name, "eventFrames": 0, "authFrames": 0})
        self.dismiss_outcome()
        self.driver.result["finalPid"] = self.review.adb("shell", "pidof", self.driver.args.package)

    def run(self):
        if self.driver.args.package != PACKAGE:
            raise RuntimeError("Requires the isolated identity fixture package")
        self.driver.result["scope"] = "Visible isolated Android approval-to-loopback-relay publication journey; no external relay, secret exposure/input, import, or hidden authority call."
        self.driver.result["limitations"] = [
            "Only the fixed public scalar-2 fixture identity and local loopback relay server are exercised.",
            "Receipt verification proves received wire events, not public relay delivery, iOS behavior, or physical-device behavior.",
            "Textarea content is observed unchanged; this driver performs no keyboard automation.",
        ]
        self.review.cold_launch()
        self.review.open_settings()
        self.review.open_approval_lab()
        self.server({"reset": True, "mode": "accept"})
        self.assert_no_event("no-event-at-cold-lab-open")
        rejected = self.observed_send()
        self.review.review_sheet(NOTE)
        self.review.press("approval-sheet-reject")
        self.review.wait_sdk_denial(rejected, NOTE)
        self.assert_no_event("reject-produces-sdk-denial-without-event")
        self.approve_mode("accept", expect_success=True)
        for mode in ("reject", "auth-required", "close-after-send"):
            self.approve_mode(mode)
        self.driver.result["finalPid"] = self.review.adb("shell", "pidof", self.driver.args.package)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--serial", required=True)
    parser.add_argument("--package", default=PACKAGE)
    parser.add_argument("--activity", default=ACTIVITY)
    parser.add_argument("--adb")
    parser.add_argument("--expected-apk-sha256", required=True)
    parser.add_argument("--selected-npub", default=SELECTED_NPUB)
    parser.add_argument("--relay-ready", type=Path, required=True)
    parser.add_argument("--revocation-only", action="store_true")
    parser.add_argument("--timeout", type=float, default=90)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("scenario", choices=(Publication.scenario,))
    args = parser.parse_args(argv)
    if not APK.fullmatch(args.expected_apk_sha256) or args.package != PACKAGE or args.activity != ACTIVITY or not re.fullmatch(r"[A-Za-z0-9_.-]+", args.serial):
        parser.error("Explicit isolated fixture, activity, serial, and installed APK SHA-256 are required")
    if public_npub(args.selected_npub) != SELECTED_NPUB or not 1 <= args.timeout <= 120:
        parser.error("The known scalar-2 public npub and a 1-120 second timeout are required")
    args.source = args.source.resolve(); args.output = args.output.expanduser().resolve(); args.relay_ready = args.relay_ready.expanduser().resolve()
    if args.output.exists() or not args.relay_ready.is_file(): parser.error("Evidence output must be fresh and relay ready.json must exist")
    ready = relay_ready(args.relay_ready)
    active = None
    status = 1
    try:
        active = load_driver(args.source).Driver(args)
        active.result["sourceBefore"] = source_snapshot(args.source)
        active.result["harnessBefore"] = harness_snapshot(args.source)
        active.metadata()
        if active.result["app"]["installedBaseApkSha256"] != args.expected_apk_sha256:
            raise RuntimeError("Installed APK differs from explicit handoff hash")
        journey = Publication(active, ready)
        if args.revocation_only:
            journey.run_revocation_only()
        else:
            journey.run()
        active.metadata()
        if active.result["app"]["installedBaseApkSha256"] != args.expected_apk_sha256:
            raise RuntimeError("Installed APK changed during journey")
        if active.result["sourceBefore"] != source_snapshot(args.source) or active.result["harnessBefore"] != harness_snapshot(args.source):
            raise RuntimeError("Application source or publication harness changed during journey")
        active.result["status"] = "passed"; status = 0
    except Exception as error:
        if active:
            active.result["status"] = "failed"; active.result["error"] = str(error)
            try: active.capture("failure")
            except Exception as capture_error: active.result["captureError"] = str(capture_error)
        else: print("FAILED: " + str(error), file=sys.stderr)
    finally:
        if active:
            active.result["finishedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            active.out.mkdir(parents=True, exist_ok=True)
            (active.out / "result.json").write_text(json.dumps(active.result, indent=2) + "\n")
            print(json.dumps({"status": active.result["status"], "result": str(active.out / "result.json")}))
    return status


if __name__ == "__main__":
    raise SystemExit(main())
