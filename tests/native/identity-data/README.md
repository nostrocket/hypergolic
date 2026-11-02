# Native public identity tracer

These isolated public-only entries exercise genuine State Lab SDK calls through
Kehto, native Android WebView/iOS WKWebView, native capability leases, the normal
broker and the dedicated native SQLite cache. They contain no private key or signer.
`observe-profile.mjs` records an independently verified signed profile from a trusted
public WSS relay into private run evidence. The build injects only its public user
and configured relay; provider metadata stays out of source.

Activate the checkout toolchains before building. Create a fresh sample and output
folder. Run `build.py --platform android|ios --sample SAMPLE --output OUTPUT`;
optional iOS `--reuse-derived` reuses build objects. Do not edit input source during
a sealed build or journey. Install the exact APK/app, then run `android.py` with
`--serial`, `--apk`, `--build`, `--sample`, `--output`, or `ios.py` with `--device`,
`--app`, `--build`, `--sample`, `--output`. Both reject product/source drift.
The Android runner reuses the existing observed-bounds UI/input helper; its optional
fast native UI dump uses the already built public QA jar. Set
`HYPERGOLIC_UPLOAD_UI_DUMP=fast` only after installing that jar.

Start each complete journey with a fresh installation of this owned fixture package.
The live read must make one actual WSS attempt. The subsequent cold launch must use
native SQLite without a network attempt. Closure/reopening checks the same durable
cache. Later cases deliberately change trusted destinations/clock, emit diagnostic
EOSE/late frames, revoke the trusted owner epoch while a view stays open, select a different public identity or tamper the cache signature.
They prove controlled offline policy and denied delivery, not public relay outages,
airplane mode, protected identity switching, ordinary published admission or physical
device security. Public relay source replacement during a run can invalidate its
independent expected snapshot; preserve the failure and obtain a fresh sample.

Reports preserve original SDK output, native inputs/AX, screenshots, exact source
and installed product hashes. Screenshots need visual inspection. A passing build,
SDK adapter or browser test does not establish native acceptance. CAP-06 remains
open until the full identity-data phase and its final gates pass.

## Selected public-list and badge tracer

`create-list-fixture.mjs` signs deterministic diagnostic events with public disposable
scalars 1/2; it never publishes them. `lists.tsx` uses those returned relay frames
through the production query parser and cryptographic verifier, then the genuine
State Lab SDK, native leases, dedicated SQLite stores and trusted review/Settings
components. Its 22 cases include all selected projections, unknown/deferred reads,
cold remembered permission, older offline cache, app/publisher/user isolation,
invalid recipient and signature, owner/background cancellation and a queued reply
after revocation and explicit reapproval. The old native ticket must still be active
before that queued delivery, so expiry cannot masquerade as the revocation gate.
A new native request count is checked for each asserted SDK outcome.

Use `build.py --suite lists` with `public-list-fixture.json` as `--sample`, then
`android-lists.py` or `ios-lists.py` with the same arguments as the profile drivers.
The Android list driver additionally waits for stable input bounds clipped to the
observed WebView. iOS waits for the WebView after modal dismissal. Frames, offline
clock/destinations, disposable owners and the queued-reply race are diagnostics;
this entry makes no public WSS, protected identity or normal signed-admission claim.
The separate native registry programs in `tests/native/identity-list-access` prove
revocation epochs and exact owner tuples without claiming a WebView journey.

## Normal signed admission

`stage-published-labs.mjs` signs the exact staged State/Feed SDK HTML using public
scalar2 without publication. `published.tsx` opens them through normal
IdentityShell/Settings, manifest/hash verification, first-open consent, native
transfer, RuntimeOwner and dedicated native SQLite stores. Its two disposable
public identities use the real confirmed IdentityTransition and per-user workspace;
no protected key storage or signer is claimed. Relay frames, a persisted QA clock
advance and offline destinations are diagnostic inputs through production parsers.
The observer records new native reads, query/frame attempts and artifact lookups.

Build with `--suite published` and the public-list fixture sample, then run
`android-published.py` or `ios-published.py` with the same sealed arguments. Clear
this owned QA package before a complete journey. Cold restart within a journey
retains the signed workspace, domain/list permissions and controlled offline mode.
The 14 selected checks compare original SDK values independently and exercise
normal domain/list decisions, Settings revoke, bounded stale refresh, ordinary
public-only identity switching, and Feed Lab's explicit follows control. No
external transport, protected device, public fixture publication or MVP claim is
implied. Preserve failures and inspect screenshots before acceptance.
