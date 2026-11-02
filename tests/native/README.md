# Native host trace driver

This driver tests the installed Android app. It never starts a desktop browser, installs an APK, clears app data, creates an identity, changes source, or starts/stops Metro or an emulator. Use an authorized disposable test device. It writes private run evidence, including temporary fixture text, so do not use this early fixture driver on personal napplets or secret-entry screens.

Enable the project's pinned Node/ADB tools, install and foreground the current Android debug build, then run from the repository root with a fresh output directory:

```sh
python3 tests/native/driver.py --serial emulator-5554 trace-host --output .tools/evidence/native-trace-01
python3 tests/native/driver.py --serial emulator-5554 host-boundary --output .tools/evidence/native-boundary-01
python3 tests/native/driver.py --serial emulator-5554 renderer-loss --output .tools/evidence/native-renderer-loss-01
# Relaunch the existing app after each destructive scenario.
python3 tests/native/driver.py --serial emulator-5554 network-receiver --output .tools/evidence/native-receiver-01
python3 tests/native/driver.py --serial emulator-5554 navigation-boundary --output .tools/evidence/native-navigation-01
python3 tests/native/driver.py --serial emulator-5554 diagnostic-boundary --output .tools/evidence/native-diagnostics-01
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests/native -p 'test_*.py'
```

Optional `--launch` starts the existing app without force-stop or data clearing. `--timeout` controls readiness observations. Unknown future scenario names exit nonzero; no unimplemented mode returns success. An existing result is never overwritten.

`trace-host` requires the real native **Runtime connected** Android hierarchy label. It separately checks **Ready** and **Host colors**, taps the counter with actual ADB input, types an ASCII marker using Android input, and verifies the textarea and literal mirror. Controls use fresh Android hierarchy bounds where exposed. If this WebView omits virtual accessibility descendants, the driver explicitly records that defect, reads control rectangles from the actual debug WebView's existing untrusted frame, maps them into observed native WebView bounds, and still injects input only through ADB. That fallback proves runtime input; it does not satisfy accessibility acceptance.

`host-boundary` requires a current-app debug WebView socket. The pinned runtime Playwright dependency attaches through its Android API with `omitDriverInstall: true`. It evaluates only inside the existing opaque napplet frame. It does not replace the trusted host, inject a native adapter, alter sandbox/CSP, route requests or assert results from standalone browser tests. Probes cover inaccessible native objects/parent DOM/browser storage, unsupported/malformed envelopes, duplicate readiness, continued allowed theme requests, definitive fetch/WebSocket/image/script/worker denials, actual connect-src and img-src violations, and blocked top navigation. The worker can be rejected by opaque-origin enforcement before a CSP event; its denial layer is not inferred. The diagnostic connection is closed without navigating or force-stopping the app.

`renderer-loss` uses the actual current-app debugging target and CDP `Page.crash`, which intentionally terminates that WebView renderer. It independently requires the native **Runtime unavailable: renderer-stopped** hierarchy label, removal of all WebView nodes, an unchanged native app PID, and no surviving page target from the app's own DevTools inventory. It forwards only that observed app socket to an allocated port and removes its own forwarding on completion. Unsupported crash commands, timeouts, errors without removal, or surviving targets fail. It leaves the captured error screen visible; relaunch the app explicitly afterward. This does not prove other failure or stale-replay paths.

Evidence binds current installed APK hash, source working-file hashes, public device/Android/WebView version, actual checks and screenshot/XML hashes. Source files can change during a debug run: use the recorded hashes, not just HEAD. PNG records start with `visuallyInspected: false`; inspect them separately before claiming visual quality. A passing driver is limited to its listed probes and is not full native security or release acceptance.

Still unproven by the combined native modes: pre-ready traffic and unregistered siblings; direct native origin/isMainFrame forgery; request-rate limits; stale-generation replay after teardown; other navigation/SSL failure triggers; user-gesture popup, download/chooser/media/SSL/cookie paths; full identity/storage/signing/published loading; physical-device behavior; release-mode hostile-artifact execution. Receiver silence is scoped to the exact local nonce URLs and time window. Wrong generation and oversized diagnostics are tested only through explicitly trusted-host fault injection. Native failure-teardown changes require rebuilding and installing the new APK; source inspection alone cannot close them.

Primary attachment API: [Playwright AndroidWebView.page](https://playwright.dev/docs/api/class-androidwebview#android-web-view-page). This is debug instrumentation, separate from planned release UI Automator and malicious-artifact tests.

When the counter's accessibility label omits its numeric value, the driver records separate read-only DOM verification while retaining actual ADB input. It does not infer a counter from unrelated visible numbers or change accessibility settings to conceal missing descendants.

The hierarchy parser distinguishes the outer native WebView from Chromium’s nested virtual WebView by observed XML ancestry. It never chooses an ambiguous WebView based on guessed dimensions. Connection-time descendant visibility and post-attachment visibility are recorded separately.

`network-receiver` starts a nonce-scoped local HTTP/WebSocket receiver and allocates one ADB reverse with `--no-rebind`. Actual Android netcat HTTP and WebSocket handshake controls must reach it before and after the existing untrusted frame attempts fetch, WebSocket, image and script URLs. The receiver independently records all receipts and must see zero nonce-specific child attempts. Controls prove device-to-receiver transport; they do not disable or reproduce WebView CSP/mixed-content/native policy. The listener and owned reverse are cleaned up. The result is scoped to the recorded URLs and observation interval.

`navigation-boundary` probes file/content fetch, forbidden nested frames and popup creation from the existing untrusted frame, requiring the real runtime to remain usable. It then attempts self-navigation to about:blank and requires the native frame-navigation diagnostic plus removed WebView, unchanged app process and an empty app-specific target inventory. CSP and file/content access settings remain intact; the driver does not attribute a denial to an unobserved layer. This mode intentionally leaves the destroyed-session error visible.

`diagnostic-boundary` is **explicit trusted-host fault injection**, separate from napplet-origin security proof. It uses the actual existing AndroidX WebMessageListener object in the trusted document, sending wrong-generation, malformed, extra-field, invalid-code, unsupported and oversized diagnostics. Whitespace-padded otherwise valid JSON isolates the 2048-byte gate. Continued native readiness and a real theme response must survive. A subsequent valid error control must produce the exact diagnostic-probe native error and destroy the view/target while preserving the app process. This adds no app API, mock, listener replacement or relaxed origin/CSP setting. It does not forge origin or isMainFrame. This is the only test mode that evaluates trusted-host code.

Browser source-window coverage exists in `runtime/tests/runtime.spec.ts`: an unregistered sandboxed sibling posts ready/theme requests, and a synthetic MessageEvent claims the registered source. Both are denied while a subsequent real registered-frame theme request succeeds. That browser test creates its sibling from trusted test setup. The fixed current Android fixture cannot create a sibling of itself across its opaque boundary, so the browser result does not close the independent native sibling/pre-ready cases.


## iOS

The separate [iOS XCTest driver](ios/README.md) operates an explicitly selected,
already-booted Simulator and an existing installed app. Its first actual trace
passes native readiness, fixture theme, counter input, typed input and a separate
rendered mirror. Simulator runner configuration preserves the app under test.
Native iOS boundary, workspace, device and release checks remain independent from
the Android results and fail if their scenario is not implemented.

## Android workspace scenarios

The [workspace harness](android-workspace.md) adds causally correlated multi-WebView switching, content-state retention, overview scrolling and closing scenarios. It uses fresh native controls and an explicit installed APK hash. The older single-view driver remains for its original boundary checkpoint; it must not select an arbitrary target in the shared workspace.


The separate [identity system-authentication journey](android-identity-actions/README.md#actual-system-pin-deletion-journey)
explicitly manages a public PIN only on its named disposable auth emulator. Those
credential-setup actions are confined to that driver and are not part of the generic
host trace driver described above.

The [published transport runtime proof](android-published-transport-device/README.md)
runs the owning Java HTTPS and WSS TLS paths in a disposable emulator DEX. It
does not install or modify the normal app.

The [iPhone Simulator transport proof](ios-published-transport-simulator/README.md)
runs the owning Swift HTTPS and WSS paths as standalone native binaries with
a source-bound JSON receipt.

Whole-app requirements and remaining acceptance are tracked in the [testing plan](../../docs/testing.md).
