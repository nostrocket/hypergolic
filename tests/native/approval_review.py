#!/usr/bin/env python3
"""Android Approval Lab rejection and queue-lifecycle journey.

This driver targets only the isolated identity fixture. It never imports an
identity, approves a request, signs an event, or opens a relay connection.
Every native input is derived from the current UIAutomator hierarchy.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
from identity_driver import source_snapshot
NPUB = re.compile(r"npub1[023456789acdefghjklmnpqrstuvwxyz]{58}")
APK = re.compile(r"[a-f0-9]{64}")
PUBLIC_PUBLISHER = "f" * 64
PUBLIC_PUBLISHER_NPUB = "npub1lllllllllllllllllllllllllllllllllllllllllllllllllllsq7lrjw"
DESTINATIONS = ("wss://relay.damus.io/", "wss://nos.lol/", "wss://bucket.coracle.social/")
PUBLIC_FIXTURE_NOTE = "Approval Lab test note"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def public_npub(value: str) -> str:
    if not isinstance(value, str) or not NPUB.fullmatch(value):
        raise ValueError("A canonical public selected npub is required")
    return value


def id_matches(row: dict, identifier: str) -> bool:
    resource = row.get("resource-id", "")
    return resource != "android:id/content" and resource.split("/")[-1] == identifier


def has_area(row: dict) -> bool:
    match = re.fullmatch(r"\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]", row.get("bounds", ""))
    return bool(match and int(match[3]) > int(match[1]) and int(match[4]) > int(match[2]))


def descriptor(rows: list[dict], identifier: str, package: str, native_only: bool = True) -> dict:
    found = [row for row in rows if id_matches(row, identifier)
             and row.get("package") == package and has_area(row)
             and (not native_only or row.get("_webview-depth") == 0)]
    if len(found) != 1:
        raise RuntimeError(f"{identifier}: expected one observed native control")
    row = found[0]
    bounds = row.get("bounds", "")
    if row.get("enabled") != "true":
        raise RuntimeError(f"{identifier}: observed control is unavailable")
    return row


def text_by_id(rows: list[dict], identifier: str, package: str) -> str:
    return descriptor(rows, identifier, package).get("text", "")


def publisher_observation(value: str) -> dict[str, str]:
    lines = [line for line in value.splitlines() if line]
    if lines != [PUBLIC_PUBLISHER, PUBLIC_PUBLISHER_NPUB]:
        raise RuntimeError("Approval sheet publisher differs from the bundled public publisher")
    return {"hex": lines[0], "npub": lines[1]}


def destination_observations(rows: list[dict], package: str) -> list[str]:
    # Destination Text nodes have no testID and may be emitted as one
    # newline-separated native Text value. Select only visible package text.
    found = []
    for row in rows:
        if row.get("package") != package or row.get("_webview-depth") != 0:
            continue
        found.extend(line for line in row.get("text", "").splitlines() if line in DESTINATIONS)
    if sorted(found) != sorted(DESTINATIONS) or len(found) != len(DESTINATIONS):
        raise RuntimeError("Approval sheet destinations differ from the reviewed relay configuration")
    return found


class ApprovalReview:
    scenario = "approval-review"

    def __init__(self, driver):
        self.driver = driver
        self.package = driver.args.package
        self.selected_npub = public_npub(driver.args.selected_npub)
        self.actions = driver.result.setdefault("actions", [])
        self.marker = "ApprovalLabNativeReject"
        self.next_sequence = 1

    def adb(self, *arguments, **kwargs):
        self.actions.append({"operation": "adb", "arguments": list(arguments)})
        return self.driver.adb_run(*arguments, **kwargs)

    def tap(self, row, name):
        self.actions.append({"operation": "native-tap", "control": name, "bounds": row["bounds"]})
        self.driver.tap(row)

    def control(self, identifier):
        for _ in range(8):
            rows = self.rows()
            try:
                return descriptor(rows, identifier, self.package)
            except RuntimeError:
                if not identifier.startswith("settings-"):
                    raise
                scrolls = [row for row in rows if row.get("package") == self.package
                           and row.get("_webview-depth") == 0
                           and row.get("class") == "android.widget.ScrollView"
                           and row.get("scrollable") == "true"]
                if len(scrolls) != 1:
                    raise RuntimeError("Settings control is not visible and no unique observed native ScrollView exists")
                bounds = scrolls[0].get("bounds", "")
                match = re.fullmatch(r"\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]", bounds)
                if not match:
                    raise RuntimeError("Observed Settings ScrollView has invalid bounds")
                x1, y1, x2, y2 = map(int, match.groups())
                if x2 <= x1 or y2 <= y1:
                    raise RuntimeError("Observed Settings ScrollView has no visible area")
                self.adb("shell", "input", "swipe", str((x1 + x2) // 2),
                         str(y1 + (y2 - y1) * 4 // 5), str((x1 + x2) // 2),
                         str(y1 + (y2 - y1) // 4), "350")
        raise RuntimeError("Timed out observing " + identifier)

    def press(self, identifier):
        self.tap(self.control(identifier), identifier)

    def rows(self):
        return self.driver.nodes()[1]

    def wait_control(self, identifier):
        native_only = identifier not in {"content", "send", "send-three"}
        def visible(rows):
            try:
                descriptor(rows, identifier, self.package, native_only=native_only)
                return True
            except RuntimeError:
                return False
        return self.driver.wait(visible, identifier)[1]

    def absent(self, identifier):
        deadline = time.monotonic() + self.driver.args.timeout
        while time.monotonic() < deadline:
            rows = self.rows()
            if not any(id_matches(row, identifier)
                       and row.get("package") == self.package and row.get("_webview-depth") == 0 for row in rows):
                return
            time.sleep(0.2)
        raise RuntimeError(f"{identifier} remained visible")

    def open_settings(self):
        self.press("shell-settings")
        rows = self.wait_control("settings-full-npub")
        observed = text_by_id(rows, "settings-full-npub", self.package)
        if observed != self.selected_npub:
            raise RuntimeError("Installed isolated fixture has a different selected public npub")
        self.driver.check("selected-public-identity", {"npub": observed})

    def open_approval_lab(self):
        self.press("settings-open-approval-lab")
        self.wait_control("content")
        self.driver.check("approval-lab-opened", "Observed Settings action opened the SDK Approval Lab")

    def public_input(self, _requested_marker: str) -> str:
        rows = self.wait_control("content")
        input_node = descriptor(rows, "content", self.package, native_only=False)
        initial = input_node.get("text", "")
        if initial != PUBLIC_FIXTURE_NOTE:
            raise RuntimeError("Approval Lab default public note changed unexpectedly")
        self.actions.append({"operation": "native-text-observation", "publicFixture": True,
                             "content": initial, "inputChanged": False})
        return initial

    def send_one(self):
        content = self.public_input(self.marker)
        self.tap_webview("send", "approval-lab-send")
        sequence = self.next_sequence
        self.next_sequence += 1
        return sequence, content

    def tap_webview(self, identifier: str, name: str):
        rows = self.wait_control(identifier)
        self.tap(descriptor(rows, identifier, self.package, native_only=False), name)

    def review_sheet(self, expected_content: str):
        rows = self.wait_control("approval-sheet")
        content = text_by_id(rows, "approval-sheet-content", self.package)
        if content != expected_content:
            raise RuntimeError("Approval sheet content differs from the actual SDK request note")
        publisher = publisher_observation(text_by_id(rows, "approval-sheet-publisher", self.package))
        identity = text_by_id(rows, "approval-sheet-identity", self.package)
        if identity != self.selected_npub:
            raise RuntimeError("Approval sheet selected identity differs from the explicit public identity")
        destinations = destination_observations(rows, self.package)
        self.driver.check("exact-native-approval-review", {"content": content, "publisher": publisher,
                          "selectedNpub": identity, "destinations": destinations})
        return rows

    def wait_sdk_denial(self, sequence: int, expected_content: str):
        def denied(rows):
            text = " ".join(row.get("text", "") for row in rows if row.get("package") == self.package)
            lowered = text.casefold()
            return (f"request {sequence} failed." in lowered and expected_content in text)
        self.driver.wait(denied, f"SDK rejection result for request {sequence}")

    def reject(self, check_name: str, expected_content: str, sequence: int, last: bool):
        self.review_sheet(expected_content)
        self.press("approval-sheet-reject")
        if last:
            self.absent("approval-sheet")
            self.wait_sdk_denial(sequence, expected_content)
        self.driver.check(check_name, {"sdkDenied": last, "nativeRejected": True,
                          "networkEffect": "not exercised; no approval input"})

    def run(self):
        if self.package != "org.nostrocket.hypergolic.identityfixture":
            raise RuntimeError("Requires the isolated identity fixture package")
        self.driver.result["scope"] = "Isolated Android Approval Lab UI and native rejection lifecycle; no approval, signing, relay or external publication."
        self.driver.result["limitations"] = [
            "Public selected npub, public fixture publisher and public relay destinations only.",
            "UIAutomator and SDK-visible denial are observed on the supplied APK; this is not signing or relay acceptance proof.",
            "No physical-device, release-hardening, iOS or Android API 26-29 claim.",
        ]
        self.driver.result["firstLaunch"] = self.cold_launch()
        self.open_settings()
        self.open_approval_lab()
        single_sequence, single_content = self.send_one()
        self.driver.capture("01-exact-review")
        self.reject("single-sdk-request-rejected-without-publication", single_content, single_sequence, last=True)

        queue_marker = "ApprovalLabQueueReject"
        queue_content = self.public_input(queue_marker)
        self.tap_webview("send-three", "approval-lab-send-three")
        queue_sequences = tuple(range(self.next_sequence, self.next_sequence + 3))
        self.next_sequence += 3
        self.review_sheet(queue_content)
        self.press("approval-sheet-dismiss")
        self.absent("approval-sheet")
        self.wait_control("approval-resume")
        self.driver.capture("02-paused-queue")
        self.driver.check("dismiss-pauses-review-with-requests-pending", {"resumeRequired": True, "pending": 2})
        self.press("approval-resume")
        self.reject("resumed-queued-request-1-rejected", queue_content, queue_sequences[1], last=False)
        self.reject("resumed-queued-request-2-rejected", queue_content, queue_sequences[2], last=True)

        background_marker = "ApprovalLabBackgroundReject"
        background_content = self.public_input(background_marker)
        self.tap_webview("send", "approval-lab-send-background")
        background_sequence = self.next_sequence
        self.next_sequence += 1
        self.review_sheet(background_content)
        self.adb("shell", "input", "keyevent", "3")
        self.adb("shell", "am", "start", "-W", "-n", self.package + "/" + self.driver.args.activity)
        self.wait_control("approval-resume")
        self.absent("approval-sheet")
        self.driver.capture("03-background-paused")
        self.driver.check("background-preserves-pending-review-without-autoprompt", {"paused": True, "autoPrompt": False})
        self.press("approval-resume")
        self.reject("explicit-resume-rejects-backgrounded-request", background_content, background_sequence, last=True)
        self.press("shell-settings")
        self.press("settings-done")
        self.driver.result["finalPid"] = self.adb("shell", "pidof", self.package)

    def cold_launch(self):
        self.adb("shell", "am", "force-stop", self.package)
        self.adb("shell", "am", "start", "-W", "-n", self.package + "/" + self.driver.args.activity)
        return {"dataCleared": False, "reason": "Explicit process restart before the public approval journey"}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--serial", required=True)
    parser.add_argument("--package", default="org.nostrocket.hypergolic.identityfixture")
    parser.add_argument("--activity", default="org.nostrocket.hypergolic.dev.MainActivity")
    parser.add_argument("--adb")
    parser.add_argument("--expected-apk-sha256", required=True)
    parser.add_argument("--selected-npub", required=True)
    parser.add_argument("--node", default=shutil.which("node"))
    parser.add_argument("--timeout", type=float, default=90)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("scenario", choices=(ApprovalReview.scenario,))
    args = parser.parse_args(argv)
    if not APK.fullmatch(args.expected_apk_sha256): parser.error("Exact installed APK SHA-256 required")
    public_npub(args.selected_npub)
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", args.serial): parser.error("Explicit serial required")
    if not re.fullmatch(r"[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+", args.package): parser.error("Explicit package required")
    if not re.fullmatch(r"[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+", args.activity): parser.error("Explicit Activity required")
    if args.output.exists(): parser.error("Evidence output must be a new directory")
    args.source = args.source.resolve(); args.output = args.output.expanduser().resolve()
    spec = importlib.util.spec_from_file_location("hypergolic_native_driver", args.source / "tests/native/driver.py")
    if spec is None or spec.loader is None: parser.error("Selected source lacks native driver")
    base = importlib.util.module_from_spec(spec); sys.path.insert(0, str(args.source / "tests/native"))
    try: spec.loader.exec_module(base)
    finally: sys.path.pop(0)
    active = None; status = 1
    try:
        active = base.Driver(args)
        active.result["sourceBefore"] = source_snapshot(args.source)
        active.result["harnessBefore"] = {"approval_review.py": sha256(HERE / "approval_review.py")}
        active.metadata()
        if active.result["app"]["installedBaseApkSha256"] != args.expected_apk_sha256:
            raise RuntimeError("Installed APK differs from explicit handoff hash")
        ApprovalReview(active).run()
        active.metadata()
        if active.result["app"]["installedBaseApkSha256"] != args.expected_apk_sha256:
            raise RuntimeError("Installed APK changed during journey")
        active.result["sourceAfter"] = source_snapshot(args.source)
        active.result["harnessAfter"] = {"approval_review.py": sha256(HERE / "approval_review.py")}
        if active.result["sourceBefore"] != active.result["sourceAfter"] or active.result["harnessBefore"] != active.result["harnessAfter"]:
            raise RuntimeError("Application source or test driver changed during journey")
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


if __name__ == "__main__": raise SystemExit(main())
