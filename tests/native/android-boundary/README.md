# Android native boundary instrumentation

This test-only instrumentation compiles against the unmodified production
`NappletHostView`, native transports and packaged runtime. A disposable ordinary
Expo Release app supplies the real React/Expo context. Each test attaches its own
native view; the guest runs the original bundled UX Lab and SDK. No second host
policy, fabricated frame, test Expo API or enabled production fault hook is used.

The package is `org.nostrocket.hypergolic.androidboundaryprobe`; the instrumentation
package adds `.test`. The label remains Hypergolic. Both are distinct from the
retained primary and QA apps. The build helper never installs, launches, captures
or otherwise accesses a device. It preserves generated packaging files by using
a Gradle init script rather than rewriting them. Products use the existing local
development signer; they are test builds, not production distribution artifacts.

## Prepared scope

Seven cases require actual Android WebView callbacks and positive controls:

- Native main/opaque guest frame observations, original SDK readiness and exact
  parent-source theme response; guest parent/local-storage/native bridge denial;
  native-owned registration and a one-use generation-bound reply.
- Malformed JSON/schema, wrong generation, invalid numeric sequences and replay
  rejection followed by a fresh valid native admission and response.
- A real matching-origin child invokes the actual privileged listener, but gains
  no main-frame authority; the original opaque guest and exact main sequence
  continue to work.
- Four-per-generation/eight-global native queue limits across three actual views;
  consumed overload sequence rejection after capacity becomes available.
- Explicit native foreground input revokes claimed/queued work; actual view
  destruction revokes its generation and stale delivery cannot reach replacement.
- Valid UTF-8 JSON whose byte count exceeds the wire bound despite fewer characters;
  an in-bound wire whose native registration snapshot is oversized, denied sequence
  replay, and fresh valid admission after both byte denials.
- Actual public Android renderer termination, claimed/queued lease revocation,
  destroyed-view removal and a different renderer handle/native generation with
  no stale response reaching the replacement.

Reflection observes the owning native registry and exact view fields. It does
not insert requests, alter counters, replace dispatchers or bypass host admission.
A distinct nonce-bound diagnostic listener records the callback's real WebView,
origin and main-frame flag. Native document-start injection supplies fixed probe
operations in each real frame; native `evaluateJavascript` supplies main-frame
stimulus. The observer is privileged test instrumentation and changes the test
browser environment. Its presence or successful injection proves no guest CSP
bypass. Opaque origins are distinguished by genuine frame-scoped reply proxies,
not by comparing two serialized `null` origins. The injected probes use no new
Origin API dependency or polyfill on older WebViews.

This is transport coverage. A storage-shaped injected message in the theme-only
registration grants no storage permission. Manually attached views have no React
JavaScript callback registration; registry observations and actual WebView replies
are the test oracles. Normal Expo capability dispatch/permissions, SQLite, protected
signing, real OS background/lock/application process death, published artifacts,
independent network egress and complete SEC acceptance remain
separate work. Compilation cannot establish that any native case passes.

## Build only

Prepare the normal generated Android project and reviewed runtime through the
existing development workflow first. Enable the pinned local toolchain if present,
then use a fresh output directory outside the repository:

```sh
# Configure the pinned tools described in docs/development.md.
python3 -B tests/native/android-boundary/build.py --output /tmp/android-boundary-build-01
```

`expected-inputs.json` pins the reviewed 62 native/build/runtime inputs. A changed
input requires review before an explicit rebaseline. The helper seals the full
source snapshot, unchanged generated packaging, signed app/test APKs, exact runtime
bytes, JavaScript bundle and Gradle log. It refuses an existing output directory
and reports `compiled-not-executed`. Preserve every failed build and its log.

The 9 October 2026 offline build compiles the signed ARM64 Release app and instrumentation APK with
all inputs unchanged, exact runtime bytes and matching development certificates.
The first failure was a missing instrumentation compile dependency; the corrected
init script adds the same pinned WebKit 1.17.0 dependency already used by the host.
No application source, lockfile, device or acceptance status changed. Private
build evidence retains all three initial builds, including the cleanup ordering review. These five cases had not executed at that checkpoint.

## Future physical run

First confirm the owner has closed every identity backup panel and that recording
is stopped. Use the exact sealed artifacts and an explicitly selected device.
Never target a retained primary/QA package, reset its data or change OS permissions
to make the test pass. Check source/product hashes before and after the run,
including the retained installed apps. Install only these two disposable artifacts:

```sh
adb -s EXPLICIT_SERIAL install app.apk
adb -s EXPLICIT_SERIAL install -t test.apk
python3 -B tests/native/android-boundary/run.py \
  --serial EXPLICIT_SERIAL --build /tmp/EXACT_SEALED_BUILD \
  --output /tmp/FRESH_NATIVE_RUN
```

Retain the original instrumentation output, device/API/WebView metadata, every
per-case result, nonce-bound frame/response observations and exact artifact/source
seals. Require all seven named cases and successful owned cleanup. Bootstrap/emitter,
frame injection, timing or unsupported-platform failures stay failures; do not
fabricate a frame, replace the transport or weaken an assertion. A physical pass
can add only its named partial evidence to the existing matrix. It cannot close a
whole security or product requirement by itself.

API authority: [AndroidX WebMessageListener](https://developer.android.com/reference/androidx/webkit/WebViewCompat.WebMessageListener)
provides the actual source origin and main-frame flag; [WebViewCompat](https://developer.android.com/reference/androidx/webkit/WebViewCompat)
documents origin-scoped listeners and document-start script injection. The test
checks the installed provider's feature support before using those APIs.


## Actual emulator fault checkpoint — 9 October 2026

All seven cases pass in one Android API36/ARM64 emulator run with493 assertions,
then pass again through `run.py` with exact installed-byte/source and owned cleanup
verification. The provider is WebView133.0.6943.137. Both runs use the same sealed
ordinary Release app and instrumentation. All62 reviewed native/build/runtime
inputs, the compiled owning implementation and Java test body remain unchanged
through execution. A fresh disposable AVD uses the already installed image;
existing emulator userdata/snapshots and both phones are untouched. The owned
emulator shuts down after testing, and its temporary userdata is removed.

The original native run fails observing a reply because the initial test watched
the iOS window-message path. The corrected observer listens on the real Android
native message object, with exact result type and generation. Five cases then pass
with347 assertions before the byte/renderer/per-view-replay additions. The new
runner's first preflight rejects a valid dotted package path; its raw receipt is
retained and no native action occurs. The corrected runner passes all seven cases,
requires exact source/artifact hashes and cleanup, and never installs, resets or
automatically retries after an observation timeout. Preserve every predecessor.

The measured oversized native snapshot is2,097,521 bytes against a2,097,152-byte
limit, while its original wire fits. The renderer test uses the public
[WebViewRenderProcess.terminate](https://developer.android.com/reference/android/webkit/WebViewRenderProcess)
API, requires Android29+ and a real renderer handle, observes actual production
renderer-fault destruction/revocation, then requires a different handle and live
SDK/native responses from the new generation. Handle identity is not an OS PID.
No private process SPI or enabled application fault switch is involved.

This proves the named emulator transport scope. No physical Android case, protected
signer, complete owning authorization, OS background/lock/application death,
independent egress or whole SEC row is accepted. All61 matrix scopes/statuses remain
unchanged, six cross-platform complete/55 open. Physical testing waits for both
owner backup-panel closure confirmations.


## Physical Android native transport/fault run — 9 October 2026

All seven source-linked cases pass in one physical Android16/API36 run with498
assertions on WebView153. Genuine main/opaque/matching-origin-child callbacks,
original SDK positive controls, schema/generation/replay, one-use replies,
per-view/global queues and consumed overload replay, native foreground-input/close
revocation, UTF-8 wire/snapshot bounds and actual public renderer termination/
fresh-generation recovery are exercised. All eleven owned probes close; all67
source inputs and both installed test products remain unchanged during execution.
This is native transport coverage with privileged diagnostic stimulus, without
React JS callback registration; protected signer/storage authorization, real OS
background/lock/app death, independent egress and verified-published parity remain.

The runner now receives its own Hypergolic application label through the androidTest
manifest. Its label and manifest become build/run seals. The signed build seals
1,242 inputs and62 owning native/runtime pins. Target app bytes remain identical
to the predecessor; only runner packaging changes. Label alone does not resolve
the installer rejection. Inspection shows the real Xiaomi USB-install dialog with
Install and countdown Deny controls. The already-authorized ordinary Install click
succeeds; Remember my choice stays unchecked. Earlier owner-reported approval and
rejected attempts remain, with their exact cause unconfirmed. No installer bypass
or OS restriction change occurs.

Both newly owned test packages are subsequently hash-verified and uninstalled;
the prior launcher returns and both retained QA/primary APK hashes remain. Canonical
private `android-native-boundary-physical01` preserves originals, source, build,
installer reconciliation and cleanup. SEC01/03 become partial on Android; six of61
full cross-platform rows complete/55 open. Pre-documentation source-bound Doctor100/430 and ten
audits run; aislop98 contains only the two exact approved locked Forge/braces
advisories. The normal verifier remains red, with full evidence preserved. No new
exception, suppressed finding, production policy change or source push. Usage93%,
ceiling about98%; full Plan03/04/Phase2 remain open.


## Optional independent network case

The eight-case mode requires an independently observed private LAN HTTP receiver,
a fresh32-character hexadecimal nonce, and a disposable cleartext-control build:

```sh
python3 tests/native/android-boundary/build.py --network-control --output "$SEALED_BUILD"
# Install only the sealed disposable app and test APKs under the device owner's approval.
python3 tests/native/android-boundary/run.py --serial "$DEVICE_SERIAL" \
  --build "$SEALED_BUILD" --output "$NATIVE_EVIDENCE" \
  --network-receiver "$LAN_HTTP_ORIGIN" --network-nonce "$RECEIVER_NONCE"
```

The receiver must return a body whose text is `boundary-control-ok` at
`/<nonce>/control/before` and `/<nonce>/control/after`. Give these unrestricted
control pages an inline data favicon to avoid automatic favicon traffic.
Independently log every HTTP request and accepted TCP connection throughout the
native run and a bounded quiet interval. Require exactly the two controls from
the target phone, two TCP accepts and zero additional requests/connections.
The native runner's receipt alone cannot prove this external observation.

The test stimulates fetch/XHR/WebSocket/image/script/stylesheet/worker/form/popup
in the actual opaque guest. Six exact nonce/path/effective-CSP violations,
eight denied API outcomes, a connected POST form with unchanged location, the
original sandbox and original SDK theme barrier must all pass. Diagnostic native
injection is privileged stimulus; it does not represent a guest CSP bypass.

The control manifest overlays only the disposable Release build when explicitly
selected. It allows LAN cleartext controls without editing generated packaging,
ordinary app configuration, production native sources or the pinned runtime.
The build/run seals include both new test files; mismatched network arguments and
control-build receipts fail before instrumentation. Default mode retains seven
cases with no overlay. Receiver controls use ordinary WebViews in the same app;
the owning host retains mixed-content, native interception and CSP restrictions.
Remove only exact owned disposable test packages after reconciliation.

## Physical receiver checkpoint — 9 October 2026

Two physical Android16/API36/WebView153 runs pass all eight selected native cases,
565 assertions each. The final strict LAN audit observes only two controls and
two TCP accepts, with zero guest/additional traffic through the one-second quiet
interval. Twelve owned probes close;69 test/owning source inputs and both exact
installed products remain unchanged. Build seals1,244 inputs and62 owning pins.
The predecessor receiver audit remains failed because of two automatic control
favicons; its native run passed. The final correction changes only receiver
control HTML to use a data favicon, retaining the strict audit.

An initial terminal install rejection remains despite an observed ordinary
instantaneous Install click. Filtered timestamps show input before cancellation;
its exact cause is unconfirmed. Normal120ms button presses subsequently install
both exact APKs. No OS security setting, installer identity or remembered consent
changes. All attempts remove owned test packages and stop receivers. Read-only
inventory identifies four retained historical app IDs; their APK hashes remain
unchanged and their data is preserved. Owner selection is needed before old-app
consolidation, because uninstalling an app erases its local identities/settings.

Canonical private `android-native-network04` preserves119 byte-verified originals.
SEC02 becomes Android partial; six of61 full cross-platform requirements remain
complete/55 open. This is bounded LAN HTTP/TCP evidence under the disposable
control overlay, with privileged fixed stimulus. DNS/UDP/publicHTTPS,
protected-key absence, full navigation/download/file/content, normal Expo domain
authorization and published parity remain open. Pre-documentation source-bound
Doctor100/430, ten audits and all engines complete; aislop98 has only the two exact
approved locked Forge/braces advisories. The normal quality gate remains red.
No new exception, production policy change or source push. Usage94%; full
Plan03/04/Phase2 remain open under the approximately98%-used ceiling.
