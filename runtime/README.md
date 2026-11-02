# Hypergolic web runtime

This package builds the trusted Kehto document embedded by Android WebView and
iOS WKWebView. It hosts reviewed bundled fixtures and verified published napplets
in opaque sandboxed frames. The native shell owns identity, permissions, trusted
review and effects; this web package neither stores private keys nor supplies a
browser signer.

## Build and check

Use Node 24.20.0 and pnpm 10.34.5. From this directory:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium webkit
pnpm verify
pnpm audit --audit-level=high
```

`verify` runs TypeScript, builds the host and runs Chromium/WebKit tests. `test`
also builds a separate capability-test host under ignored `.test-fixtures/`;
that host is never copied into native assets.

Before native builds, run from the repository root:

```sh
pnpm run runtime:build
```

That command builds this package, checks SHA-256/length against
`assets-manifest.json`, copies identical `dist/index.html` and `dist/host.js`
into both native modules, and seals the fixture-release catalog. The manifest is
a build sidecar, not an executable WebView resource. No source map, remote host
script or CSS file is required. Bundled HTML/manifest hashes must match reviewed
catalog pins; runtime packaging does not silently rebuild napplet sources.

## Artifacts and native boundary

The trusted native host supplies a fresh generation and exact packaged document.
Android uses the app-assets HTTPS origin; iOS uses its checked resource bundle
and isolated WebKit content world. Never install a wildcard bridge or
`addJavascriptInterface` fallback. See the [native contract](../docs/native-contract.md)
for origin/frame, platform and lifecycle checks.

Bundled fixtures verify original UTF-8 HTML/hash/aggregate before frame creation;
unsigned fixtures do not establish publisher trust. Published mode retrieves a
generation-bound artifact through ordered native chunks, rechecks its claims,
bytes and aggregate, and inserts leading CSP before publisher markup. It accepts
no guest/network URL or HTML prop. Signed-manifest verification and first-open
consent remain separate shell requirements; see the
[artifact registry](../docs/published-artifact-registry.md).

Diagnostics are bounded `ready` or `error` messages naming generation and fixed
code, without raw exceptions or content. `ready` means a genuine Kehto session
registered, not that guest rendering or acceptance completed. Capability, stream,
routing and private byte-transfer messages use separate validated lanes; this
bridge is no longer diagnostic-only.

The frame uses `sandbox="allow-scripts"`, no-referrer and a leading default-deny
CSP. Direct network, external scripts, workers, nested frames, forms and navigation
are unavailable. Granted resources may project bounded Blob media; WebView policy
still does not grant direct guest networking. Exact source Window, trusted event,
schema, readiness and rate checks precede Kehto dispatch. Close/pagehide or a
subsequent document load tears down listeners, registry, native client and frame.
Native code separately revokes callbacks and effect authority.

## Selected capability surface

`shell.ready` receives the admitted environment, not a fixed theme-only profile.
The reviewed native domains are identity, storage, theme, relay, resource, upload,
link, intent, inc, notify, config and outbox. Each artifact receives only its
admitted subset; Outbox is removed from its usable environment without Relay.
Domain availability is not full conformance or an operation approval.

Theme uses the shell's current system appearance; identity is read-only and
native-backed. Whole-operation adapters handle storage, relay/Outbox reads,
subscriptions and publication, resources, uploads, intent/INC, foreground
notifications and shell configuration. Link handling is native-mediated. The
optional [close-check service](../docs/close-check.md) and advisory
[support report](../docs/nap-support.md) confer no additional authority.

The [capability contract](../docs/capability-contract.md) and its linked references
own wire fields, limits, permission and lifecycle policy. Incoming signer services,
Value/zaps and unsupported domains are not provided by this runtime.

## Whole-operation native adapter seam

The locked [shell patch](patches/@kehto__shell@0.20.0.patch) forwards trusted
`operationOverrides`; the [runtime patch](patches/@kehto__runtime@0.22.0.patch)
selects reviewed operations only after registered-session, domain, ACL and firewall
checks. A selected handler consumes the operation even when it fails; it cannot
fall through to built-in persistence, relay publication or signing. An absent
override retains upstream behavior, so native configuration must keep unsupported
services disabled. `auth.getSigner()` stays null, and browser storage is not the
authoritative saved-data backend.

Replies retain original correlation/source and stop after unregister/replacement
or teardown. Native responses cannot select another recipient. Config subscribers
receive only no-ID `config.values` pushes; correlated get replies stay separate.
Transport cleanup cannot undo already dispatched effects. Native lease, exact
payload, deadline and final effect/delivery checks remain mandatory.

Host configuration supplies per-operation SDK/client deadlines; guests cannot
choose them. Ordinary defaults are 30 seconds in the injected SDK namespace and
27 seconds in the native client. An admitted Relay domain selects a 660-second
`relay.publish` response budget by default, with any trusted bundled override
preserved. `outbox.publish` also selects 660 seconds. This policy applies to
verified-published and bundled artifacts. Native approval still expires within
600 seconds; a longer response budget grants no extra approval lifetime.

The published-artifact regression uses the shipped Approval Lab SDK and real
byte verification, Kehto and native client. Native artifact metadata/transport
and replies are doubled. It checks delayed correlated denial, duplicate replies,
ordinary read timeouts, no retransmission and the response deadline; it does not
prove native signing, relay delivery or device acceptance. See
[signing approval](../docs/signing-approval.md).

## Secure randomness

The shell patch retains `crypto.randomUUID` when available and replaces the
request-ID fallback with 16 secure `getRandomValues` bytes encoded as hex. Without
either secure API, creation fails before posting. `src/secure-random-compat.ts`
also supplies secure version-4 UUIDs for older secure WebViews. Correlation IDs
are not native generation or approval authority. No `Math.random` fallback exists;
the final bundle build rejects any such call.

## Versions, notices and evidence

The manifests/lockfile pin Kehto shell/runtime/services 0.20.0/0.22.0/0.20.0,
ACL/firewall 0.18.0/0.5.0, NAP core/NAP 0.31.1 and nostr-tools 2.24.0. Kehto source
is [f031d5d](https://github.com/kehto/web/tree/f031d5d2264d047cd40e2524bf12b7f68c74caa6).
Selected SHELL/THEME, NIP-5A/5D and capability revisions are recorded in the
[native](../docs/native-contract.md#selected-versions-and-authorities) and
[capability](../docs/capability-contract.md#owning-specifications-and-supported-profile)
contracts. Updating packages does not silently select new draft semantics.

The build enumerates actual contributing packages in `assets-manifest.json`,
writes `THIRD_PARTY_NOTICES.txt` and appends notices to `host.js`. Preserve original
licenses and clearly identified declaration-only material. Missing upstream
original attribution and source-provenance gaps remain documented under
[runtime attribution](../docs/native-dependency-notices.md#runtime-attribution).

Browser tests cover real Kehto dispatch, adapters, genuine SDK messages, sandbox
and CSP behavior, source/replay/schema rejection, private byte carriers and late
delivery. Their native ports/artifact sinks are explicit diagnostic doubles.
Neither browser engines, successful build nor theme/Ready labels prove WebView
native isolation, protected storage, external signers or complete Android/iOS
acceptance. Use [native harnesses](../tests/native/README.md) and the
[testing plan](../docs/testing.md); final Phase 2/3 acceptance remains open.
