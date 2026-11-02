"""Read Xcode's own touch attachments; never invoke a private automation API."""
from __future__ import annotations
import hashlib
import json
import math
import plistlib
from pathlib import Path


def decode_archive(data: bytes) -> dict:
    archive = plistlib.loads(data)
    objects = archive["$objects"]
    def decode(value, depth=0):
        if depth > 40:
            raise ValueError("Excessively nested input archive")
        if isinstance(value, plistlib.UID):
            return decode(objects[value.data], depth + 1)
        if isinstance(value, list):
            return [decode(item, depth + 1) for item in value]
        if isinstance(value, dict):
            if "NS.objects" in value and "NS.keys" not in value:
                return decode(value["NS.objects"], depth + 1)
            if "NS.objects" in value and "NS.keys" in value:
                return dict(zip(decode(value["NS.keys"], depth + 1), decode(value["NS.objects"], depth + 1)))
            return {key: decode(item, depth + 1) for key, item in value.items() if key != "$class"}
        return value
    return decode(archive["$top"]["root"])


def validate_two_paths(record: dict, bounds: dict) -> dict:
    paths = record.get("eventPaths", [])
    if len(paths) != 2:
        raise ValueError("Expected exactly two native touch paths")
    x, y, width, height = (float(bounds[key]) for key in ("x", "y", "width", "height"))
    if width <= 0 or height <= 0:
        raise ValueError("Empty observed target")
    samples = []
    intervals = []
    identities = [path.get("index") for path in paths]
    if any(type(value) is not int for value in identities) or len(set(identities)) != 2:
        raise ValueError("Native touch paths lack distinct pointer identities")
    for path in paths:
        events = path.get("pointerEvents", [])
        if path.get("pathType") != 1 or len(events) < 3 or events[0].get("eventType") != 1 or events[-1].get("eventType") != 3:
            raise ValueError("Not a complete native down/move/up touch path")
        points = []
        last_time = -1.0
        for event in events:
            px, py, offset = (float(event[key]) for key in ("coordinate.x", "coordinate.y", "offset"))
            if not all(math.isfinite(v) for v in (px, py, offset)) or offset < last_time:
                raise ValueError("Invalid native touch coordinates/timing")
            if not x <= px <= x + width or not y <= py <= y + height:
                raise ValueError("Native touch left the observed card target")
            points.append({"x": px, "y": py, "offsetSeconds": offset, "eventType": event["eventType"]})
            last_time = offset
        intervals.append((points[0]["offsetSeconds"], points[-1]["offsetSeconds"]))
        samples.append(points)
    if abs(intervals[0][0] - intervals[1][0]) > 0.02 or min(v[1] for v in intervals) - max(v[0] for v in intervals) <= 0:
        raise ValueError("Touches were not simultaneous")
    starts = [(points[0]["x"], points[0]["y"]) for points in samples]
    ends = [(points[-1]["x"], points[-1]["y"]) for points in samples]
    start_separation = math.dist(*starts)
    end_separation = math.dist(*ends)
    if start_separation < 2 or any(math.dist(start, end) < 2 for start, end in zip(starts, ends)) or end_separation >= start_separation - 2:
        raise ValueError("Native paths do not show two separated moving fingers pinching inward")
    return {"paths": samples, "pointerIdentities": identities, "startSeparation": start_separation, "endSeparation": end_separation, "targetBounds": bounds, "simultaneousTouchCount": 2,
            "scope": "Both touches began together inside the observed card. In-flight second-finger cancellation is not proved."}


def verify_two_touch_input(attachments: Path, bounds: dict) -> dict:
    matches = []
    manifest = json.loads((attachments / "manifest.json").read_text())
    for group in manifest:
        for item in group.get("attachments", []):
            if not item.get("suggestedHumanReadableName", "").startswith("Synthesized Event"):
                continue
            filename = item["exportedFileName"]
            path = attachments / filename
            if path.parent != attachments or not path.is_file():
                raise ValueError("Unexpected attachment path")
            try:
                value = validate_two_paths(decode_archive(path.read_bytes()), bounds)
            except (ValueError, KeyError, TypeError, IndexError, plistlib.InvalidFileException):
                continue
            matches.append({"attachment": filename, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), **value})
    if len(matches) != 1:
        raise RuntimeError(f"Expected exactly one archived two-touch input inside the observed card; found {len(matches)}")
    return matches[0]


def validate_short_stroke(record: dict, stimulus: dict) -> dict:
    paths = record.get("eventPaths", [])
    if len(paths) != 1 or paths[0].get("pathType") != 1:
        raise ValueError("Short stroke must have one native touch path")
    events = paths[0].get("pointerEvents", [])
    if len(events) < 3 or events[0].get("eventType") != 1 or events[-1].get("eventType") != 3:
        raise ValueError("Short stroke lacks a complete down/move/up trajectory")
    samples = []
    last_time = -1.0
    for event in events:
        px, py, offset = (float(event[key]) for key in ("coordinate.x", "coordinate.y", "offset"))
        if not all(math.isfinite(value) for value in (px, py, offset)) or offset < last_time:
            raise ValueError("Invalid stroke coordinates/timing")
        if event not in (events[0], events[-1]) and event.get("eventType") != 2:
            raise ValueError("Unexpected intermediate event")
        samples.append({"x": px, "y": py, "offsetSeconds": offset, "eventType": event["eventType"]})
        last_time = offset
    for sample, endpoint in ((samples[0], stimulus["start"]), (samples[-1], stimulus["end"])):
        if abs(sample["x"] - endpoint["x"]) > 0.1 or abs(sample["y"] - endpoint["y"]) > 0.1:
            raise ValueError("Stroke does not match observed requested endpoints")
    travel = samples[0]["y"] - samples[-1]["y"]
    if not 12 < travel < 32 or any(abs(sample["x"] - samples[0]["x"]) > 0.1 for sample in samples):
        raise ValueError("Stroke is not an upward sub-close-threshold input")
    displacements = [samples[0]["y"] - sample["y"] for sample in samples]
    if any(not 0 <= value < 32 for value in displacements) or any(a > b for a, b in zip(displacements, displacements[1:])):
        raise ValueError("Short stroke overshoots or reverses its upward path")
    return {"path": samples, "upwardTravel": travel,
            "scope": "Xcode's synthesized trajectory endpoints match the requested short stroke. MOVE and UP may share a timestamp; interpolation and delivered native callback timing are not observed. Actual no-navigation/no-close comes from separate XCTest UI assertions."}



def verify_short_stroke_input(attachments: Path, stimulus: dict) -> dict:
    matches = []
    for group in json.loads((attachments / "manifest.json").read_text()):
        for item in group.get("attachments", []):
            if not item.get("suggestedHumanReadableName", "").startswith("Synthesized Event"):
                continue
            filename = item["exportedFileName"]
            path = attachments / filename
            if path.parent != attachments or not path.is_file():
                raise ValueError("Unexpected attachment path")
            try:
                value = validate_short_stroke(decode_archive(path.read_bytes()), stimulus)
            except (ValueError, KeyError, TypeError, IndexError, plistlib.InvalidFileException):
                continue
            matches.append({"attachment": filename, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), **value})
    if len(matches) != 1:
        raise RuntimeError(f"Expected one archived short stroke matching observed endpoints; found {len(matches)}")
    return matches[0]
