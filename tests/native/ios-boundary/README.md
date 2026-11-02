# iOS WK boundary tests

This independent UIKit app compiles the owning `modules/napplet-host/ios/RestrictedNappletHost.swift` directly by PBX source reference. There is no second policy implementation. It uses a separate `org.nostrocket.hypergolic.boundaryprobe` identity and a generated, byte-verified resource bundle. The Expo wrapper remains an owning-app integration check.

Historical checkpoint: the reviewed core was exercised on iPhone17 Simulator/iOS26.5: 12 methods passed in the first 13-method run; an invalid-session receipt helper asserted an intentionally absent URL. After correcting optional recorder metadata, that one method passed separately. The original failed run remains preserved in private build evidence. This describes observed coverage across two runs, not one green suite.

The 13 methods cover genuine Kehto ready/theme, opaque parent/native/storage access, guest and synthetic diagnostic source spoofing, absent handler in wrong worlds, real child-frame native rejection, exact native schema/generation/UTF-8 limits, valid main-frame diagnostic admission, per-URI CSP network denial, top/self navigation, actual core unmount/session revocation, and invalid/reused sessions. Native-only instrumentation installs a distinct isolated-world observer before load to capture genuine WKFrameInfo. The app exposes no Expo testing API.

All script stimulus is privileged native frame-scoped injection. Its execution is not a guest CSP bypass. Each denial that should leave a live session is followed by a parent-source theme.get.result barrier with exact expected palette. CSP evidence requires individually attributed effectiveDirective/blockedURI for fetch, WebSocket, image, script and worker. It does not establish packet-level zero-egress. A native-retained WKView can still evaluate after unmount; the test establishes handler/session revocation, not renderer disappearance. The original seventeen methods use no private forced-process API or fabricated native frame/message.

From this directory, after the owning runtime assets exist (`pnpm runtime:build` at repository root):

```sh
python3 build.py
```

The helper verifies the reviewed core/wrapper/fixture hashes, creates ignored Resources/, compiles without simulator input, rejects changing inputs and seals full app/test products in ignored `build/boundary-build.json`. A future runtime/core change requires review and a fresh explicit expected-runtime baseline. Never silently regenerate expected hashes from whatever source happens to exist.

After an explicit device handoff, use the chosen already-booted UDID and a fresh private xcresult path:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test-without-building \
  -project BoundaryProbe.xcodeproj -scheme BoundaryProbe \
  -destination 'platform=iOS Simulator,id=EXPLICIT_UDID' \
  -derivedDataPath build -resultBundlePath evidence/FRESH-RUN.xcresult \
  -parallel-testing-enabled NO -maximum-concurrent-test-simulator-destinations 1
```

Record pre/post sealed source and product hashes and export actual xcresult summary/attachments. A successful compilation is not a native test pass. Tests attach actual nonce-bound frame metadata, generation/session values, native events and JSON observations. Preserve failed runs and distinguish unsupported native claims from executed evidence. Physical-device and production Expo-wrapper validation remain separate.

## Native capability transport checkpoint

The 15 September 2026 transport revision passes all 17 tests in one Simulator run.
The source-linked target now also compiles CapabilityLeaseRegistry.swift and
CapabilityTransport.swift; their hashes are part of the explicitly reviewed
baseline. The unchanged UX Lab runtime includes the previously reviewed Kehto
operation patches. Four additional tests admit native-owned snapshots, exercise
one-use replies, deny forged sources/frames/generations, and revoke claimed work
on close or frame navigation. Capability requests use privileged native injection;
no real SDK storage, database, signer or Expo-wrapper journey is claimed here.
All 18 sealed inputs and 12 products matched after execution. Historical failed
receipts remain preserved separately. See [scope and remaining work](../../../docs/native-capabilities.md).


The subsequent State Lab runtime revision also passes all 17 methods in one run.
The baseline pins all three bundled fixture records and the new host asset bytes.
The four transport-only methods now configure UX Lab with the theme domain, so
SDK startup does not introduce an unrelated identity request. Their injected
storage-shaped message tests native snapshot transport only; it grants no storage
permission. Genuine SDK/Expo SQLite and identity switching pass in the separate
owning-app State Lab journey. The revised seal retains 18 inputs and 12 products.


## Physical fault additions — October 2026

Three additional methods exercise real renderer termination with claimed/queued
leases and a fresh WebKit process; four-per-generation/eight-global queue bounds
across three actual WK views, including consumed overload sequences; and UTF-8
wire/snapshot limits with replay checks. These are native transport tests using
privileged real main-frame injection. They do not establish Expo authorization,
protected signing, ordinary published loading or complete SEC acceptance.

Only the test bundle invokes WebKit’s private `_killWebContentProcess` control
and reads `_webProcessIdentifier`, following the [pinned WebKit declaration](https://github.com/WebKit/WebKit/blob/2cb4a4edf352593c30f835b967a5b3699fefc898/Source/WebKit/UIProcess/API/Cocoa/WKWebViewPrivate.h). The test requires the control to exist, observes the actual
production termination delegate and revoked leases, then verifies a different
process/generation and a valid reply with no stale response. No private SPI is
added to application code. A separate signed source-linked physical build seals
current inputs; the historical expected-runtime baseline stays unchanged.
Compilation and source inspection alone do not prove these methods passed.

All twenty methods pass in one physical iPhone16/iOS26.5 run on 8 October2026.
The stronger final run also verifies both overload replay counters and measures
a 2,097,515-byte snapshot using the first request’s captured native registration.
The separate app compiles49 unmodified core sources; Expo wrappers and the unused
Expo-dependent fixture-release transport are excluded. Both existing installed
Hypergolic records and all three local app product seals remain identical, the
primary app process stays unchanged, and returning to the QA app reuses its process.
The original build-membership failure and earlier passing revision are retained.
The original seventeen methods and historical expected-runtime remain unchanged.
SEC-01/03 retain partial status; Android and owning-app parity remain open.


## Independent physical network receiver — 8 October 2026

`Tests/NetworkBoundaryTests.swift` is an additional physical test target member,
requiring `HG_BOUNDARY_RECEIVER_URL` and `HG_BOUNDARY_RECEIVER_NONCE`. A controlled
LAN HTTP/TCP listener must independently observe exactly the before/after control
requests and no guest requests or extra TCP accepts. Two unrestricted WK views
prove the receiver is reachable from the actual device/app. The guest attempts
fetch, XHR, WebSocket, image, script, stylesheet, worker, form and popup operations;
per-path CSP events attribute the applicable denials. The form submission also
records its exact target/method and unchanged location in an `allow-scripts`-only
sandbox. The [HTML sandbox rules](https://html.spec.whatwg.org/multipage/browsers.html#sandboxed-forms-browsing-context-flag) explain why forms need their own allowance;
a form-action CSP event is not required when sandboxing already blocks submission.

The prepared physical target reuses the previously permitted disposable transport
probe identity, adds only test-harness LAN/HTTP WebContent configuration, and
compiles49 unchanged production core sources. The normal Hypergolic identities,
permissions and policies are unchanged. The default historical project does not
include this receiver-dependent member; include it explicitly for the prepared
physical receiver run. Never count an unconfigured/unreachable receiver as a pass.

All21 methods pass in one actual iPhone16/iOS26.5 run. Source/product seals and
both installed Hypergolic metadata records stay unchanged; primary process and
QA return process persist. The failed manifest relocation and initial form-event
assertion remain preserved. The independent receiver stops after the bounded run.
This proves the named LAN attempts with privileged native injection; it does not
prove DNS/UDP/public HTTPS, private-key absence or all navigation/download/file/
content/owning Expo/published escapes. SEC-02 remains partial; Android parity is open.


## Published Outbox admission component

`-only-testing:BoundaryTests/PublishedOutboxTests` runs three tests through the
production published byte loader and original SDK on the actual WKWebView core.
`Fixtures/published-outbox-manifest.json` signs the unchanged UX Lab HTML with a
public disposable test identity and is never published. The owning JS verifier
checks its signature/artifact before native resource staging; staging itself is a
trusted test caller. App-only completions supply canonical query/rejection replies,
a signed stream event and the broker's correlated close action. This scope proves
native claims/one-use consumption/delivery/revocation, not protected signing,
ordinary Expo consent UI, WSS or physical/OS lifecycle. Existing core/wrapper/
authority source fingerprints remain mandatory; the expected transport and runtime
fingerprints explicitly reflect this reviewed admission change.
