# iOS native UI tests

This standalone XCTest UI runner targets an **already-installed Hypergolic app** on an **explicitly selected, already-booted iOS Simulator**. It uses public XCTest input and accessibility APIs. It does not evaluate JavaScript, alter app source, replace the app bundle, clear app data, start Metro, boot a Simulator, change privacy/accessibility settings, manage keys or enroll accounts.

The runner activates the existing app, increments the focused UX Lab counter, appends a unique temporary marker and scrolls that fixture as needed. Use a disposable test session with **UX Lab 1 focused**, its overview/settings closed, and no personal or secret text visible. XCTest attachments contain screenshots, accessible text and temporary fixture input. Evidence belongs in a private output directory.

## Readiness and execution

The `trace-host` scenario passed on an iPhone 17 Simulator running iOS 26.5: native and WK readiness, the host theme, counter 0 → 1, native typed input and its separate rendered mirror. The full installed bundle manifest and recorded source hashes matched before and after. Source hashes describe the checkout; they do not identify the JavaScript bytes served by Metro. Each new run must pass independently.

`switch-state` passed all seven checks after an explicit app-only cold launch: distinct A/B counters and notes, edge and overview round trips, equal-width two-column geometry with the third card on the next row, and both end stops. `gestures` passed all four checks: measured vertical and horizontal content movement, marker selection, and retained counter/draft/selection/scroll positions. These runs used public XCTest on iOS 26.5; no native generation, transition frame pacing or physical-device claim is made.

Coordinate input and source changes with the app owner. A development build can keep executing old JavaScript after its Metro/HMR connection is lost. Current filesystem hashes or a debugger's fetched script text alone do not establish the running code. If a cold launch is needed, obtain scope for losing disposable in-memory fixture state and record it separately; this driver never restarts the target app.
With the current app installed and the Simulator ready, run:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
python3 tests/native/ios-driver.py \
  --udid "$HYPERGOLIC_IOS_UDID" \
  --repo "$PWD" \
  trace-host --output "$HYPERGOLIC_IOS_EVIDENCE"
```

Set `HYPERGOLIC_IOS_EVIDENCE` to a new private output directory and `HYPERGOLIC_IOS_UDID` to the explicitly selected booted Simulator from `xcrun simctl list devices available`. The verified first run used iPhone 17 / iOS 26.5. The driver rejects the ambiguous selector `booted`. `--bundle-id` defaults to `org.nostrocket.hypergolic.dev`. `--expected-title` and `--expected-session` default to `UX Lab 1` and `ux-lab-1`; these must describe the fixture actually in focus. A new output path is required for every run. No earlier evidence is overwritten.

The Python launcher:

1. Records current Xcode/Simulator metadata, a deterministic hash manifest of every file in the installed app bundle, harness hashes, and optional source hashes. This includes Xcode's debug dylib, frameworks, asset manifests and bundled JavaScript. It reads no application data directory.
2. Builds only `HypergolicUITests-Runner.app` in the evidence directory. The standalone project has no application target, app dependency or application launch environment.
3. Verifies the built runner's exact bundle ID and test bundle. Xcode's generated Simulator run configuration must contain only this runner and its test bundle as dependent products, with no target-app path.
4. Preserves Xcode's generated `UseUITargetAppProvidedByTests` mode. Target launch arguments/environment are removed. Xcode installs only the runner; `XCUIApplication(bundleIdentifier:).activate()` selects the already-installed app and preserves an existing instance. `UseDestinationArtifacts` is not used on Simulator.
5. Runs one scenario on the selected Simulator, without parallel destinations, exports all custom XCTest attachments, rechecks installed artifact hashes, rejects changed source snapshots when `--repo` is supplied, and validates a nonce-bound receipt with exactly that scenario's expected checks. Any failed, missing, stale or ambiguous receipt returns nonzero.

The test runner remains installed afterward. The app's temporary counter/draft/scroll position remain changed. The driver does not uninstall, terminate or reset either app on completion. A timeout is a failed run requiring inspection; it is never reported as proof.

## Exact proof scope

`trace-host` requires these five independent checks:

| Check | Observable evidence |
|---|---|
| Native runtime ready | Exact focused native header and that session's `Runtime connected` accessibility label |
| Fixture ready and theme | `Ready · …` plus `Host colors` in the one active accessible WKWebView |
| Counter delta | Real XCTest button tap and numeric accessibility value increasing by one |
| Typed input | Real XCTest textarea input containing this run's unique marker |
| Rendered mirror | A distinct visible static text exactly matching the textarea value |

The counter value must be observable through its own accessibility element or descendants. iOS 26.5 exposes `Counter, application status` with a numeric child. WebKit exposes three nested accessibility WebView nodes for one host; the driver selects the unique visible leaf by descendant queries and rejects multiple leaf siblings. The workspace helper waits for exact fixture Ready and Host colors descendants while WebKit expands its accessibility tree after cold launch; native status and an empty WK wrapper alone are insufficient. The retry is bounded and multiple leaves still fail. Missing or ambiguous values fail. The driver never infers a counter from unrelated text or imports a browser result.

The textarea tap uses its observed center, requires that point inside the visible WebView and outside all observed handle rectangles, and records the geometry before public `XCUICoordinate.tap`. It fails without tapping when that clear point is unavailable. Static mirror matching excludes the textarea bounds because WebKit also exposes editor contents as nested static text.

Screenshots, XCTest debug hierarchy text and public `snapshot()` attribute trees are attached at readiness, after tapping, after typing, mirror observation and final teardown. Query logic uses public element attributes; it never parses the unstable `debugDescription` string. `result.json` and `trace-report.json` name actual checks. PNG records start with `visuallyInspected: false`; inspect the images before describing visual quality.

`switch-state` and `gestures` are separate native scenarios. Inspect each native run's receipt before claiming the complete scenario passed. `switch-state` preserves existing fixture notes, seeds distinct counters and fresh notes in UX Labs 1 and 2, round-trips by handle gestures and overview, verifies two-column card geometry, and stops at both ends. It uses the native input toolbar Done button when a keyboard is already visible. `gestures` measures vertical anchor and horizontal marker movement, selects a marker, then requires counter/draft, selected marker and both measured scroll positions to survive an edge-switch roundtrip. Gesture coordinates come from observed element bounds; content gestures reject endpoints covered by handles/keyboard.

Both workspace scenarios start with UX Lab 1 focused and the original three loaded UX Labs. They append temporary text and preserve earlier state; they do not reset or reopen sessions. Run them with `switch-state` or `gestures` in place of `trace-host`, using a fresh output directory. Their result is in `workspace-report.json`. Native generation identity, renderer identity and transition frame pacing are not directly observable through this public accessibility driver and are not claimed.

`closing` passed all nine native checks on iOS 26.5 with the clean Manual recognizer. Run it after `gestures`, with the original three loaded UX Labs and exactly one selected marker in UX Lab 1. It appends fresh A/B notes, checks gentle overview scrolling separately from rapid upward card swipes, verifies the exact unknown-state warning and Keep open retention, then confirms removal of only the target. It checks retained B state before closing the remaining fixtures through visible controls and exercises Settings/Open navigation from the quiet empty overview. Closing deliberately discards the disposable fixtures' live state. Their removal from accessibility does not prove native renderer destruction or saved-state persistence. The first native run exposed a gentle card-scroll failure. A matched diagnostic confirmed that a Manual recognizer hands that same stroke to scrolling, and the separate clean closing run then passed: gentle card movement, rapid warning, Keep open retention, target-only removal, retained B state, visible closing controls and empty navigation. The closing sequence passed again on the final release-guard source with the integrated native WK host. Its full installed bundle and source manifests matched before/after.

`card-cancel` passed all three checks on the release-guard source: the original short stroke stayed in overview, a real two-finger pinch caused no navigation or close, and the saved fixture values returned. Earlier native failures remain preserved: the short stroke opened the card until final released coordinates were checked independently of the native tap recognizer. It sends an observed 20 px upward stroke at 1500 px/sec, then a public XCTest pinch starting with two fingers inside the observed card, requires no close prompt or missing card, and returns to the exact saved counter/draft. `ios_touch_evidence.py` requires an archived short-stroke down/move/up trajectory matching the exact observed endpoints, then reads Xcode’s own archived pinch attachment and requires two overlapping complete down/move/up paths with distinct native pointer identities, separated starting points and actual inward pinch movement whose coordinates stay inside the recorded card. An unsupported archive shape or unavailable input returns nonzero. The passing two-path check proves two simultaneous fingers from gesture start; it does not prove adding a second finger after a drag is already active. The tested zero-final-hold drag archives record an endpoint MOVE and coincident UP. Requiring archived intermediate MOVE samples would be invalid: Xcode stores a synthesized trajectory, not the delivered native callback stream. The verifier binds requested endpoints, while separate UI assertions require no navigation or close. Native delivery timing is not inferred from those archives. Run it before `closing`, while the three fixtures remain loaded.

Unknown scenarios fail before any build/device operation. Named future modes (`identity`, `host-boundary`, `renderer-loss`) explicitly return nonzero. Identities/signing, published loading, native attack probes, renderer teardown, chooser/dialog/permission denials, physical devices and release signing remain unproved by this runner. Native iOS security requires separate actual WK evidence and cannot inherit Hermes, Android or browser results.

## Offline checks

```sh
cd tests/native
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest -v test_ios_driver test_ios_touch_evidence
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun swiftc -frontend -parse ios/XCTest/HypergolicUITests/HostTraceTests.swift ios/XCTest/HypergolicUITests/WorkspaceTests.swift
plutil -lint ios/XCTest/HypergolicUITests.xcodeproj/project.pbxproj
```

The UI runner minimum deployment version is 18.4 to match the current host candidate. It does not modify the application's deployment target. Builds use the selected Xcode's Simulator SDK and require no Apple development account.

## Primary API references

- [XCUIApplication.init(bundleIdentifier:)](https://developer.apple.com/documentation/xcuiautomation/xcuiapplication/init(bundleidentifier:)): uses the installed application when no matching build is supplied.
- [XCUIApplication.activate()](https://developer.apple.com/documentation/xcuiautomation/xcuiapplication/activate()): activates without terminating an existing instance.
- [XCTest attachments](https://developer.apple.com/documentation/xctest/adding-attachments-to-tests-activities-and-issues): `keepAlways` preserves attachments for passing tests.
- [XCUIElement.snapshot()](https://developer.apple.com/documentation/xcuiautomation/xcuielementsnapshotproviding/snapshot()) and [debugDescription](https://developer.apple.com/documentation/xcuiautomation/xcuielement/debugdescription): structured public attributes versus debugging-only text.
- Local owning tool documentation: `man xcodebuild.xctestrun`, the `.xctestrun` emitted by `build-for-testing` for this standalone project, `xcrun xcresulttool export attachments --help`, and `xcrun xcresulttool get test-results summary --help`. The observed Xcode error limits `UseDestinationArtifacts` to physical iOS devices despite the man page's general description.
