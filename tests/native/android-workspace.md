# Android live workspace evidence harness

This harness supplements the source Android driver with exact multi-WebView observations. It does not install, clear data, alter app source, or replace native input with JavaScript. The explicit --cold-launch option restarts only the installed app process; default operation does not launch or reset it.

## Current result

The existing target and observation tests remain in place. New offline short-card admission tests cover density conversion, clipped input, stale overview nodes, changed state/context, wrong focused runtime and stopping after a failed probe. Offline tests do not represent native execution.

The separate release-guard extension passed 17 native checks: the original 20dp upward stroke stayed in overview, an ordinary tap still opened its original runtime, then the existing navigation/closing sequence completed. The portable integration uses the same ADB stimulus and additionally checks exact card inventory and the returned native/Chromium binding. These added checks have offline coverage; this packaged refactor has not had a new device run.

`evidence/switch-state-05/result.json` PASSED after explicit cold launch (new PID14451). Thirteen checks establish all3 distinct native generation/frame/context identities and native input state, both-direction roundtrips, measured two-column opening order and overview return. All source hashes remained identical. Its5 screenshots were visually inspected; `visual-review.json` records observations separately from the immutable run receipt. Counters2/3/4 and unique drafts, selected03/05/07, vertical scroll711/861/1342CSSpx and rail250/496/563CSSpx were retained in the original runtimes.

Earlier failures remain preserved:

- `evidence/switch-state-01`: stopped before input because the original full UIAutomator dump included off-screen not-important views. The harness now uses `dump --compressed` and checks positive-area native bounds.
- `evidence/switch-state-02`: exactly one target changed from a real counter tap. A burst of Android typing was intercepted after `Android` by Gboard's stylus tutorial.
- `evidence/switch-state-03`: same preserved target/context, counter4; paced text failed while the keyboard tutorial covered the app. `failure.png` shows the tutorial. This is not a confirmed shell text-loss defect.
- `ime-current.png`, `ime-cancel-receipt.json`, `ime-after-cancel.png`, `ime-public-probe.png`: tutorial cancelled by its screenshot-observed Cancel button; actual `probe` text then appended to the fixture as `Androidprobe`. No keyboard settings changed. This was a diagnostic interaction, not a source-bound workspace pass.

The latest cold-launched source uses Handles SHA256 caeb8648a5915dabc88ad5f79bf84dda8f8d863e2e4bd1c99e100c79a6549448. `gestures-01` passed short cancellation, first-end stop and the first full switch, then failed on repeated UIAutomator timeouts. A subsequent direct screenshot shows UX Lab3 ready and the same app PID17205, so that failure is not a confirmed app crash. Four native MP4 clips are preserved. `overview-scroll-01` subsequently PASSED: a491-native-pixel upward drag over1600ms moved the first card from y514 to y325 (clipped native top), without any prompt or changed fixture state. `navigation-close-01` then PASSED without recording: short cancel, both ends, both handle taps/card return, rapid upward close with Keep open, exact context teardown3→2→1→0, and empty Settings route explicitly creating fresh UXLab4. Source and Android input holds are released; no device commands remain active. The installed Android binary remains the explicitly supplied accessibility APK; do not assume a later source edit is in that APK.

## Commands

```sh
# Configure the pinned tools described in docs/development.md.
PYTHONDONTWRITEBYTECODE=1 python3 tests/native/workspace_driver.py \
  --source "$PWD" \
  --serial "$HYPERGOLIC_ANDROID_SERIAL" --cold-launch \
  --expected-apk-sha256 "$HYPERGOLIC_ANDROID_APK_SHA256" \
  --output "$HYPERGOLIC_ANDROID_EVIDENCE" \
  switch-state
```

Other explicit scenarios: `gestures`, `closing`, `overview-scroll`, `navigation-close` (remaining gesture checks followed by closing in one baseline), `card-cancel`, and `card-cancel-and-navigation-close` (short card probe, then the existing navigation/closing sequence). The short probe reads actual display density, maps 20 logical pixels into an observed card and sends a 13ms ADB swipe. It checks all three cards, no prompt, exact existing contexts/state, then an ordinary native tap back to the bound runtime. It does not claim individual delivered motion samples or two-finger coverage. Optional `--record-motion` records6-second native screenrecord clips around actual handle/card input; it adds device load. `extract-motion-frames.swift` decodes actual MP4 frames with AVFoundation, preserving actual presentation timestamps, and may require macOS media-service access outside the filesystem sandbox. No animation-frame pass is inferred from a valid MP4 header. No implicit first CDP target is selected. An existing result directory is refused. The scenario requires three initial loaded fixtures and UX Lab1 focused; it preserves existing draft text rather than clearing it. Closing intentionally removes fixture sessions through their actual confirmation UI and explicitly opens a new temporary instance from the empty state.

```sh
cd tests/native
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest -v test_observations test_workspace_driver
node --test target-probe.test.mjs
```

## Target admission and proof

`target-probe.mjs` admits only page targets from the app PID's observed `webview_devtools_remote_PID` socket, with exact trusted host URL and one native UUIDv4 generation query. Every executable target in the inventory must pass. Target IDs, native generations, frame IDs and unique existing context IDs are recorded. It uses a caller-owned ADB local forward, removes only that forward, and does not restart ADB.

It observes the existing `about:srcdoc` napplet default context only. Fixed, read-only DOM expressions record fixture counter/draft/mirror, selected marker, edge marker, vertical/document/horizontal-rail position, and measured control bounds. No new world, main-frame evaluation, click, script scrolling, value assignment, private API, native bridge invocation, or fixture-state restoration occurs. The fixture must show genuine ready/theme state, expose only shell/theme APIs and have no direct native bridge.

The native AX header plus exact visible `runtime-status-ux-lab-N` must agree. The unique outer native WebView bounds must match Chromium's attached renderer screen rectangle. A real ADB counter tap must change exactly one existing target by one, with other fixture data unchanged. This causally binds native name to native generation and existing iframe context. Every return independently checks the visible native rectangle against that known target, as well as counter/draft/selection/scroll retention. Background state alone cannot pass as the focused view.

Chromium source owns these diagnostic rectangle fields in `AwDevToolsManagerDelegate::GetTargetDescription`:
https://chromium.googlesource.com/chromium/src/+/main/android_webview/browser/aw_devtools_manager_delegate.cc

## Accessibility and keyboard evidence limits

The actual emulator's `uiautomator help` documents `--compressed`. On the same initial app screen, full dump had210 nodes and the compressed dump97, excluding the off-screen runtime status/subtree. `DumpCommand` deliberately defaults to verbose/uncompressed layout (AOSP source):
https://android.googlesource.com/platform/prebuilts/fullsdk/sources/android-30/+/refs/heads/main/com/android/commands/uiautomator/DumpCommand.java
https://android.googlesource.com/platform/frameworks/uiautomator/+/dec12c69b4e09679f691050d8fdcab0a5e474258

These observations correct the initial full-dump concern; they are not a TalkBack session or a blanket accessibility pass. Android's counter AX label is `Counter` without an unambiguous numeric value; numeric state is explicitly observed through CDP instead. The keyboard's tutorial window was absent from the active-window XML even when visible in the screenshot. An active-window hierarchy alone cannot prove that an IME overlay is absent. Exact typed prefixes must arrive; failures retain screenshots for independent review.

## Evidence bounds

Each run records installed APK SHA256, its exact runtime asset hashes, actual device/WebView version, app PID, source commit/dirty inventory, runtime/shell/native source hashes before and after, target snapshots and actual ADB input arguments. A changed source fingerprint or app process fails the run. These are debug-Metro source bounds, not an embedded-JS release-binary attestation.

The driver checks functional gesture completion/cancellation/ends and the observed two-column card arrangement. It can record motion and has captured a short drag that visibly moves the live view and settles back. Complete zoom/resistance coverage still needs captured motion and independent review. It does not assert frame pacing or overall visual quality. No physical-device, release, restart-persistence, identity, storage or signing behavior is claimed here. iOS evidence remains separate.

Integration: copy only the new `workspace_driver.py`, `target-probe.mjs`, `observations.py`, `motion_recording.py` and their tests alongside the authoritative source `tests/native/driver.py`; the scratch `driver.py`, `base-driver.py` and `receiver.py` are read-only compatibility copies and must not overwrite newer source versions.

Run from the app repository root. Set `HYPERGOLIC_ANDROID_SERIAL` to the explicitly selected device shown by `adb devices`, `HYPERGOLIC_ANDROID_APK_SHA256` to the reviewed installed APK hash, and `HYPERGOLIC_ANDROID_EVIDENCE` to a new private output directory. A historical hash does not authorize assuming that a later binary is identical.
