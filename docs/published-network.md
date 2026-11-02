# Published napplet network boundary

The trusted loader verifies the signed kind-35129 manifest, exact publisher/`d` coordinate, original `/index.html` hash and NIP-5A aggregate after retrieval. Replies remain untrusted. App-only native WSS/HTTPS feed ordinary Settings `naddr` entry, pinned reopening and the published workspace.

## Destination policy

Classify every resolved address before connecting. Empty or mixed public/private answer sets fail. Reject private, loopback, link-local, documentation, multicast, reserved/transition blocks and IPv4-mapped IPv6, including some globally reachable special-purpose addresses conservatively. The policy's recorded range basis is the IANA [IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry), [IPv6](https://www.iana.org/assignments/iana-ipv6-special-registry) and [IPv6 address-space](https://www.iana.org/assignments/ipv6-address-space) registries; recheck mutable registries before release.

Published HTTPS accepts only credential-free public DNS hostnames, pins a vetted numeric address, and preserves the original hostname for TLS SNI/certificate checks. No redirects or encoded bodies. Bound original body/framing to 2 MiB; iOS uses strict content-length/chunked framing and 8 KiB receives. Cancellation/deadline closes the connection. Android uses the platform TLS socket; iOS uses [Network.framework](https://developer.apple.com/documentation/network/nwconnection) and an [original-hostname policy](https://developer.apple.com/documentation/security/secpolicycreatessl%28_%3A_%3A%29). No host-selected trust override exists in ordinary builds.

Android DNS has one bounded worker and a four-slot queue; a platform resolver ignoring interruption may outlive cancellation but cannot create an unbounded queue. iOS HTTPS/WSS can try another address from the same fully vetted answer set only before ready. No post-ready request/session failover; attempts share the original deadline.

## Relay integration contract

Only trusted Lookup relays resolve manifests; `naddr` hints cannot choose destinations. WSS uses the same all-address classification, numeric pinning and original-host TLS verification. Check the WebSocket accept value, mask outbound client frames and reject redirects, extensions and compression under [RFC 6455](https://www.rfc-editor.org/info/rfc6455/). Repeated unconsumed upgrade metadata is allowed after syntax/size checks; critical fields remain singletons. Native framing precedes JSON decoding or JavaScript delivery.

The bounded `REQ` captures exact publisher, kind35129 and `d`, with exact event ID on pinned reopening. Fanout is at most four native queries. Match the active subscription ID, collect initial EVENTs through EOSE, and end a connection on CLOSED, malformed/overflow data, timeout, cancellation or revocation. NOTICE grants no authority. [NIP-01](https://github.com/nostr-protocol/nips/blob/0046368a747c5c25ae2bec28bae0e537744c8f10/01.md) envelopes do not verify event signatures; the trusted loader still verifies signed events and artifact bytes. Lookup transport does not publish/sign. Exact bounded NIP-42 announcements are discarded without AUTH response; see [subscriptions](relay-subscriptions.md#optional-auth-announcements).

## Published admission and updates

App-only `fetchPublishedHttps(operationId, url)` returns bounded original-body Base64, with cancellation/revocation. The JS adapter checks canonical Base64 before reconstructing a bounded Response. Both native query cores are app-only and lifecycle-bound. Network permission alone grants no execution, signing or publisher trust.

SQLite schema v3 stores revisioned first-open grants by user/publisher/stable app ID. A verifier-branded artifact and exact capability set require explicit new/changed-grant review; stale decisions fail. Staging rechecks that admission throughout native transfer. Settings shows verified publisher, signed event and requested domains before first open; both hosts bind exact grants before claiming a one-use artifact.

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
