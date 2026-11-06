# Published napplet network boundary

The trusted loader verifies the signed kind-35129 manifest, exact publisher/`d` coordinate and original `/index.html` bytes. Replies remain untrusted. App-only native WSS and HTTPS serve Settings `naddr` entry, pinned reopening and the published workspace.

## Destination policy

Classify every resolved address before connecting. Empty or mixed public/private answer sets fail. Reject private, loopback, link-local, documentation, multicast, reserved/transition blocks and IPv4-mapped IPv6, including some globally reachable special-purpose addresses conservatively. The policy's recorded range basis is the IANA [IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry), [IPv6](https://www.iana.org/assignments/iana-ipv6-special-registry) and [IPv6 address-space](https://www.iana.org/assignments/ipv6-address-space) registries; recheck mutable registries before release.

Published artifact HTTPS starts at the signed SHA-256 path and admits up to 16 MiB of original HTML. It can follow up to three HTTPS redirects under the original deadline. Each hop requires a credential-free public DNS hostname, a freshly vetted numeric address and TLS verification for that hop’s hostname. Loops and compressed response bodies fail closed. iOS uses bounded content-length or chunked framing and receives 8 KiB at a time. Cancellation or deadline expiry closes the connection. Android uses the platform TLS socket. iOS uses [Network.framework](https://developer.apple.com/documentation/network/nwconnection) and an [original-hostname policy](https://developer.apple.com/documentation/security/secpolicycreatessl%28_%3A_%3A%29). No host-selected trust override exists in ordinary builds.

Android DNS has one bounded worker and a four-slot queue; a platform resolver ignoring interruption may outlive cancellation but cannot create an unbounded queue. iOS HTTPS/WSS can try another address from the same fully vetted answer set only before ready. No post-ready request/session failover; attempts share the original deadline.

## Relay integration contract

Only trusted Lookup relays resolve manifests; `naddr` hints cannot choose destinations. WSS uses the same all-address classification, numeric pinning and original-host TLS verification. Check the WebSocket accept value, mask outbound client frames and reject redirects, extensions and compression under [RFC 6455](https://www.rfc-editor.org/info/rfc6455/). Repeated unconsumed upgrade metadata is allowed after syntax/size checks; critical fields remain singletons. Native framing precedes JSON decoding or JavaScript delivery.

The bounded `REQ` captures exact publisher, kind35129 and `d`, with exact event ID on pinned reopening. Fanout is at most four native queries. Match the active subscription ID, collect initial EVENTs through EOSE, and end a connection on CLOSED, malformed/overflow data, timeout, cancellation or revocation. NOTICE grants no authority. [NIP-01](https://github.com/nostr-protocol/nips/blob/400d157c53264b8e58c7b3cdbd21ef546fb7a157/01.md) envelopes do not verify event signatures; the trusted loader still verifies signed events and artifact bytes. Lookup transport does not publish/sign. Exact bounded NIP-42 announcements are discarded without AUTH response; see [subscriptions](relay-subscriptions.md#optional-auth-announcements).

## Published admission and updates

Hypergolic admits two signed shapes for named kind-35129 publications.

| Format | Signed HTML hash | Capability declarations |
| --- | --- | --- |
| Legacy single path | One `path /index.html <sha256>` tag and an optional matching `x <aggregate> aggregate` | `requires` |
| NIP-5D named | One two-field `x <sha256>` tag and a nonempty plain-text description in event `content` | `R` required and `O` optional |

Both formats require one exact `d` tag and the same signed-event, HTTPS and HTML validation. Hypergolic rejects mixed shapes and duplicate capability declarations, including a domain declared as both required and optional. The modern admission profile covers named publications. Its addressing excludes root and snapshot kinds. Source and artwork metadata are independent of artifact admission. Modern `z` and `i` advertisements confer no routing authority in the pinned host. [NIP-5D draft at c041f84](https://github.com/dskvr/nips/blob/c041f84667c1781c3c1d5bfbd970943131b38cc9/5D.md)

The cache stores the original signed event and the original HTML. Both formats derive the same native runtime version from `SHA256("<html-sha256> /index.html\n")`. For a modern event this is a compatibility value for storage and the pinned Kehto runtime. The signed `x` stays the raw HTML digest. Equivalent bytes retain their existing version identity across a format migration. This admission profile uses Hypergolic’s pinned Kehto window-message projection. The draft’s newer private `MessagePort` projection has separate transport requirements.

Normal Lookup selects the newest eligible event across both formats and refuses distinct eligible revisions at the newest timestamp. Discovery can supply an expected event ID, which must match that selection before the host downloads HTML. An installed pin instead queries and verifies its exact event. Both paths still verify the downloaded original bytes before staging. The published HTML envelope accepts well-formed comments before the explicit root and head tags. The runtime places trusted CSP and bootstrap scripts at the start of the real head.

App-only `fetchPublishedArtifactHttps` returns a verified-length claim for a bounded native response. The app reads canonical Base64 in sequential 48 KiB chunks, then the trusted loader checks the signed SHA-256 against the complete original bytes. Final read, cancellation, backgrounding and expiry release the native body. Download bodies, pending uploads and staged artifacts each have a 32 MiB aggregate native budget. The persistent artifact cache stays at 16 MiB total and skips any row larger than that budget. Avatar HTTPS uses its separate 2 MiB profile and disallows redirects. Both native query cores are app-only and lifecycle-bound.

SQLite schema v4 stores revisioned first-open grants by user/publisher/stable app ID. A verifier-branded artifact and exact capability set require explicit review for new or changed grants. Stale decisions fail. Settings shows the publisher, signed event, required and optional domains, and any unavailable capabilities. The user’s approval grants only the supported domains from the two sets. Missing required domains produce a warning. Missing optional domains leave those features unavailable. Moving a domain between the two sets requires fresh review. The modern admission profile `hypergolic-native-2026-11-06-v1` also requires a one-time review of grants remembered under older profiles, including legacy publications. Declining that review preserves the prior grant and pin. Staging rechecks the admission throughout transfer. Both native hosts bind the exact grant before claiming a one-use artifact.

A separate BLOB cache is scoped by user/publisher/app/exact event. Every hit rechecks signatures and HTML hashes; saved workspace rows are untrusted until pin and grant verification. Explicit update checks reverify the old pin and accept only a newer verified event for the same publisher/app. Review shows old/new event IDs; changed access requires separate consent. Decline preserves running pin/data. Acceptance cancels old signing, revokes its native session and stages fresh bytes under a new one-use session. A relay publication also needs live verified workspace/native-generation binding and exact operation review. Revoking a grant must revoke its live admission before restaging: identity/session epochs are checked, not a new database lookup per chunk. [Outbox](outbox-routing.md#published-admission) additionally requires its Relay dependency.

## Owning checks

```sh
python3 tests/native/public-ip-classifier/run.py
python3 tests/native/android-published-https/runner.py
python3 tests/native/android-published-https-bridge/runner.py
python3 tests/native/published-https/run.py
python3 tests/native/published-https/tls_runner.py
python3 tests/native/websocket-frames/run.py
python3 tests/native/ios-published-wss/tls_runner.py
python3 tests/native/android-published-transport-device/runner.py --serial "${HYPERGOLIC_TEST_ANDROID_SERIAL:?Select a disposable emulator}" --output "${HYPERGOLIC_TEST_OUTPUT:?Select a new output directory}"
python3 tests/native/ios-published-transport-simulator/runner.py --simulator "${HYPERGOLIC_TEST_IOS_UDID:?Select a booted Simulator}" --output "${HYPERGOLIC_TEST_OUTPUT:?Select a new output directory}"
```

TLS proofs need local sockets/OpenSSL and controlled disposable trust inputs. `HYPERGOLIC_NETWORK_PROOF` gates iOS resolve/address/anchor seams; ordinary builds exclude them. `HYPERGOLIC_TLS_SIMULATOR_UDID` selects the same standalone TLS suites in a booted arm64 Simulator. Android shell-UID and standalone Swift binaries do not exercise Expo/app-UID/system-trust/lifecycle composition. Handshake/client-frame proofs also live under `tests/native/websocket-handshake`, `tests/native/websocket-client-frames`, `tests/native/android-published-wss` and `tests/native/ios-published-wss`.

## Testing

Final Android/iOS acceptance remains open. See [testing](testing.md) for the unified requirement matrix, current quality gate, evidence limits and full standalone campaign.

Require ordinary native first-open/cancel, two publishers, tampered/oversized artifacts, DNS/TLS/upgrade/redirect faults, background/revocation, exact-pin restart, real live update and full published fixture parity. The [live-update guide](../tests/native/live-update-publication/README.md) describes the v1/v2 harness; preparation is not a published update pass.
