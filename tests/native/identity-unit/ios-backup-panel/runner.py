#!/usr/bin/env python3
"""Build and run the source-linked iOS native backup-panel Simulator proof."""
import argparse, datetime, hashlib, json, os, plistlib, re, subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
PRODUCTION = ("modules/identity-store/ios/NativeBackupPanel.swift",
              "modules/identity-store/ios/NostrSecretBech32.swift")
EXPECTED_TESTS = 3


def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def write_json(path, value): path.write_text(json.dumps(value, indent=2) + "\n")
def environment():
    return dict(os.environ, DEVELOPER_DIR=os.environ.get("DEVELOPER_DIR", "/Applications/Xcode.app/Contents/Developer"))


def production_inputs():
    expected = json.loads((HERE / "source-manifest.json").read_text())["productionSources"]
    actual = {}
    for name in PRODUCTION:
        path = REPO / name
        if not path.is_file() or path.is_symlink() or path.resolve() != path.absolute():
            raise RuntimeError("Missing regular owning production source: " + name)
        actual[name] = digest(path)
    if actual != expected:
        raise RuntimeError("Owning production source changed; explicitly review and update source-manifest.json")
    return actual


def harness_inputs():
    ignored = {"README.md"}
    return {str(path.relative_to(HERE)): digest(path) for path in sorted(HERE.rglob("*"))
            if path.is_file() and path.name not in ignored}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--udid", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9-]{8,80}", args.udid):
        raise RuntimeError("Use an explicit Simulator UDID")
    output = args.output.resolve()
    if output.exists() or output.is_relative_to(REPO) and not output.is_relative_to(REPO / ".tools"):
        raise RuntimeError("Use a fresh output outside source or under ignored .tools")
    output.mkdir(parents=True)
    before_production, before_harness = production_inputs(), harness_inputs()
    project = HERE / "BackupPanelProbe.xcodeproj"
    derived = output / "derived"
    build = ["xcodebuild", "build-for-testing", "-project", str(project), "-scheme", "BackupPanelProbe",
             "-configuration", "Debug", "-destination", "generic/platform=iOS Simulator",
             "-derivedDataPath", str(derived), "CODE_SIGNING_ALLOWED=NO"]
    with (output / "build.log").open("w") as log:
        built = subprocess.run(build, env=environment(), stdout=log, stderr=subprocess.STDOUT, timeout=600)
    receipt = {"schema": 1, "status": "build-failed" if built.returncode else "compiled",
               "dateUTC": datetime.datetime.now(datetime.timezone.utc).isoformat(),
               "scope": "Simulator UIKit lifecycle with public scalar 2; no protected storage, LocalAuthentication, production availability, or capture claim.",
               "productionSources": before_production, "buildCommand": build, "buildExitCode": built.returncode}
    write_json(output / "receipt.json", receipt)
    built.check_returncode()
    manifests = list((derived / "Build/Products").glob("*.xctestrun"))
    if len(manifests) != 1:
        raise RuntimeError("Expected one generated XCTest manifest")
    xctestrun = manifests[0]
    document = plistlib.loads(xctestrun.read_bytes())
    if "TestConfigurations" in document:
        targets = [target for config in document["TestConfigurations"] for target in config["TestTargets"]]
    else:
        targets = [value for key, value in document.items()
                   if not key.startswith("__") and isinstance(value, dict)]
    if len(targets) != 1 or targets[0].get("IsUITestBundle") is True:
        raise RuntimeError("Expected one owned unit-test bundle")
    test = ["xcodebuild", "test-without-building", "-xctestrun", str(xctestrun),
            "-destination", "platform=iOS Simulator,id=" + args.udid, "-parallel-testing-enabled", "NO",
            "-resultBundlePath", str(output / "Tests.xcresult")]
    with (output / "test.log").open("w") as log:
        tested = subprocess.run(test, env=environment(), stdout=log, stderr=subprocess.STDOUT, timeout=600)
    receipt.update(status="test-failed" if tested.returncode else "executed", testCommand=test, testExitCode=tested.returncode)
    write_json(output / "receipt.json", receipt)
    tested.check_returncode()
    raw = subprocess.check_output(["xcrun", "xcresulttool", "get", "test-results", "summary",
                                   "--path", str(output / "Tests.xcresult")], env=environment(), text=True)
    summary = json.loads(raw); write_json(output / "test-summary.json", summary)
    if summary.get("totalTestCount") != EXPECTED_TESTS or summary.get("passedTests") != EXPECTED_TESTS \
            or summary.get("failedTests") != 0 or summary.get("skippedTests") != 0:
        raise RuntimeError("Incomplete or failed XCTest result")
    if production_inputs() != before_production or harness_inputs() != before_harness:
        raise RuntimeError("Source changed during build or execution")
    receipt.update(status="passed", totalTests=EXPECTED_TESTS, passedTests=EXPECTED_TESTS,
                   failedTests=0, skippedTests=0,
                   buildLogSha256=digest(output / "build.log"), testLogSha256=digest(output / "test.log"),
                   xctestrunSha256=digest(xctestrun))
    write_json(output / "receipt.json", receipt)
    print(json.dumps({"status": "passed", "receipt": str(output / "receipt.json")}))


if __name__ == "__main__": main()
