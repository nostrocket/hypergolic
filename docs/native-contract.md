# Native runtime contract

Android WebView and iOS WKWebView host a packaged trusted Kehto document and one
opaque `sandbox="allow-scripts"` napplet frame per view. Native configuration and
the selected [capability profile](capability-contract.md) determine authority.
Readiness diagnostics are not capability grants. Full Phase 2/3 native security
and device acceptance remain open; see [testing](testing.md).

## Android native host

`src/runtime/NappletHost.tsx` accepts shell-owned descriptors/configuration and
diagnostics, never arbitrary HTML or URLs. Native code creates a fresh generation
and loads the exact trusted document at
`https://appassets.androidplatform.net/assets/runtime/index.html?sessionId=GENERATION`.
Only packaged host resources and explicitly owned artifact routes are served;
unknown resources are blocked. There is no `addJavascriptInterface` or wildcard
bridge. Missing WebMessageListener support fails closed.

The diagnostic listener is restricted to the exact trusted HTTPS origin and
independently checks main frame, WebView identity, URL, generation, string type,
2 KiB UTF-8 limit and selected schema. Dedicated capability transports separately
capture source-bound requests. Diagnostic/control messages cannot confer signing
or storage authority. Failure, teardown and renderer loss revoke registration
and remove the view; retry requires a new generation.

Native policy denies browser persistence, unrestricted file/content access,
cookies, mixed content, popups, downloads, geolocation/media permission and
JavaScript dialogs. File chooser requests are denied except a single-file input
admitted by the live, focused, upload-enabled native owner. Its picker returns
only the selected prepared/copied representation to the captured generation;
this grants no generic WebView file/content access. Navigation cannot replace
the trusted document.

## iOS native host

`HypergolicNappletHostAssets.bundle` contains the generated trusted HTML,
JavaScript and asset manifest. Native receipt checks hashes/lengths and limits
file read access to that bundle. Shared generation copies byte-identical host
assets to both platforms.

WKWebView uses a nonpersistent store, default-deny content rules and exact
bootstrap/script/image exceptions. Named native handlers live in an isolated
`WKContentWorld`. A main-frame-only adapter forwards browser-trusted,
source-checked messages. Native receipt checks world, view, main frame, exact
URL/file origin, generation, schema and message bounds. File-origin WebCrypto
must be available or loading fails closed.

Navigation/action/response delegates reject replacement documents and popups;
public callbacks deny dialogs, media/motion permission and credential challenges.
The public file-chooser callback denies requests except the exact captured
single-file upload picker path: correct view, live focused Upload grant,
non-main-frame about:srcdoc/about:blank recipient, no directories or multiple
selection. The deployment target is iOS 18.4 because this public callback begins
there. Callback annotations must conform to
the installed WebKit actor/sendability contract so denial methods are invoked.

Unmount, recycle, failure and renderer loss revoke the generation, unregister
handlers and remove the WKWebView. Keep content rules attached until release.
Unfocus ends editing inside that view without discarding its JavaScript state.
Revoked authority does not imply immediate destruction of every retained renderer
reference. The production policy belongs to `RestrictedNappletHost.swift`; the
[WK boundary harness](../tests/native/ios-boundary/README.md) compiles that source.

## Artifact and browser boundary

Build/runtime verification checks original UTF-8 bytes, HTML SHA-256 and NIP-5A
aggregate. CSP/namespace injection must not change the bytes used for verification.
The outer CSP admits only its packaged script and controlled bootstrap. The child
CSP precedes guest scripts and denies network, external scripts, workers, nested
frames, forms, base overrides, media and objects except selected native-mediated
resource projection. The sandbox has no same-origin, popup, download, form or
top-navigation grant.

Source-window identity, trusted browser event, strict schema, readiness and rate
checks precede Kehto dispatch. Native navigation revokes authority before a
replacement frame can inherit its WindowProxy; subsequent iframe-load detection
is a backstop. Upstream permissive ACLs or best-effort browser storage cannot
authorize native effects or establish authoritative saved data.

## Selected versions and authorities

| Component | Selection |
| --- | --- |
| Expo / React Native | 57.0.20 / 0.86.3 |
| AndroidX WebKit | 1.17.0, with runtime feature detection |
| Kehto shell / runtime / services | 0.20.0 / 0.22.0 / 0.20.0 |
| Kehto ACL / firewall | 0.18.0 / 0.5.0 |
| Outer NAP core / NAP | 0.31.1 / 0.31.1 |
| Outer nostr-tools | 2.24.0, excluded from Hermes |
| Fixture SDK | 0.27.2, built separately |

Kehto release source: [f031d5d](https://github.com/kehto/web/tree/f031d5d2264d047cd40e2524bf12b7f68c74caa6).
Wire authority: [SHELL/THEME 5ac0490](https://github.com/napplet/naps/tree/5ac0490461ca6fec2f0d2e45b4835cf9bc08de24/naps),
[NIP-5A a2494f4](https://github.com/nostr-protocol/nips/blob/a2494f4f81d46684e5814a9bf35e2b1df978f955/5A.md)
and [NIP-5D draft 24711d9](https://github.com/dskvr/nips/blob/24711d9c47bbdd07908bf1d52bf677d9cbc530f0/5D.md).
Package compatibility is not full protocol/native conformance.

## Published napplet verification gate

Entry accepts lowercase `naddr1…` or `nostr:naddr1…` for kind 35129, binding
publisher and `d` identifier. Kind 35128 is an nsite and is not interchangeable.
Accept valid NIP-19 TLV field orderings; re-encoding is not a byte-equality gate.
Relay hints are validated but do not replace the shell's configured Lookup list.
Web URLs and `nevent` are not selected napplet entry points.

Verify a fresh NIP-01 ID/signature, exact kind/publisher/`d`, one `/index.html`
SHA-256 path and original artifact bytes. Compute the aggregate from that path
hash. `x` is optional under the pinned revisions but must match when present.
The selected single self-contained HTML limit is 2 MiB; signed manifest is 64 KiB.
HTTPS Blossom tags are retrieval hints, not authority. First-open publisher/access
consent remains distinct from cryptographic validity. [Admission](nap-support.md)
records the requested set and supported grant intersection.

Lookup and HTTPS use the native [network boundary](published-network.md), including
public-address checks at connection time. Ordinary React Native `fetch` cannot
substitute for that guarantee. A selected event pins a version: absent or
mismatched bytes must not fall back to another event.

### Required native handoff

After review, app-only registries independently verify size, UTF-8, SHA-256,
aggregate and exact session/publisher/app/event/version claims. Account/epoch
and consent authority remain with the admission and native capability owners;
the byte registry's claims do not contain an independent account field. A view claims an opaque
handle once for its generation; React props never carry HTML, paths or arbitrary
URLs. The runtime receives bounded generation-bound bytes, rechecks hashes, injects
CSP/namespace and mounts the frame. Native byte validation replaces neither
signed-event checks nor consent.

Restart needs a fresh handle. Descriptors retain coordinate, content version and
exact signed event ID. Reverify cached bytes or fetch only that pinned event;
unavailable/corrupt state requires recovery. Accepted updates change version/event
pin together. Legacy descriptors without valid pins fail closed. See the
[registry](published-artifact-registry.md) and [workspace](workspace-storage.md).

## Reproduction and evidence

```sh
pnpm run runtime:install
pnpm run runtime:test
pnpm run prebuild:android
NODE_ENV=development CI=true ./android/gradlew -p android assembleDebug --no-daemon -PreactNativeArchitectures=arm64-v8a --console=plain
```

Runtime generation validates its manifest before copying host assets; native
builds reject absent bundles. Keep original fixtures, locks, generation code and
third-party notices with the source. See [runtime instructions](../runtime/README.md)
and [development](development.md) for iOS generation and toolchains. Native probes
distinguish real guest input, source/world metadata, CSP observations, controlled
receiver evidence and trusted-host fault injection. None alone proves complete
zero-egress behavior or physical security. Acceptance cases and remaining gates
are maintained in [testing](testing.md).
