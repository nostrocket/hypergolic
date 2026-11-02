# Relay query

The selected historical-read profile now runs through genuine SDK → Kehto → native
capability lease → app-owned native WSS → validated reply. The normal application
uses the current trusted Network settings. Feed Lab is an unsigned, reviewed
embedded fixture; it requests `relay` and has optional theme access.

## Selected contracts and limits

The owning [NAP-RELAY draft](https://github.com/napplet/naps/blob/0be8abce18beb46ca37bd4ddd042f58d30b4eedc/naps/NAP-RELAY.md)
remains selected at PR 2 revision `0be8abce18beb46ca37bd4ddd042f58d30b4eedc`.
[NIP-01](https://github.com/nostr-protocol/nips/blob/0046368a747c5c25ae2bec28bae0e537744c8f10/01.md)
was checked at `0046368a747c5c25ae2bec28bae0e537744c8f10` on 30 September 2026.
Successful replies contain `{type:"relay.query.result",id,events:[{event}]}`;
failures contain the same type/id and `error`, with `events` absent. A complete,
valid EOSE response with no events is successful empty retrieval. Connection or
validation failure is never represented as an empty successful result.

| Boundary | Selected limit/behavior |
| --- | --- |
| Filters | 1–4; ids/authors/kinds/since/until/limit and single-letter tag filters |
| Lists | 1–64 entries; exact lowercase hex64 for ids/authors/#e/#p |
| Request | 16 KiB; limit defaults to 32; explicit 0–32 accepted |
| Events | 32 raw events/relay and 32 unique aggregate events; 64 KiB/event; 512 KiB aggregate event bytes |
| Transport | Up to 16 selected public WSS Network relays, sequentially; 64 frames/relay |
| Lifetime | One 15-second total deadline; two concurrent queries per service and per broker |
| Selection | Filter conditions AND; filters OR; newest timestamp first, then ascending id; per-filter limits |
| Validation | Fresh NIP-01 fields, independent event hash and signature, filter match; no verification-cache trust |

Unknown extensions, empty lists, partial hex prefixes, invalid timestamps and
caller-selected relay/identity fields are denied. The selected bounded profile
can therefore reject requests that a broader implementation accepts. Result
limits fail explicitly instead of silently truncating the aggregate.

A query snapshots trusted destinations at admission. At least one complete valid
relay response is required. An individual relay failure is tolerated when another
completes; results are best effort, and neither EOSE nor success proves complete
history across unavailable relays. A total timeout fails the query even if an
earlier relay succeeded. There is no cache, sidecar augmentation or NIP-65 routing.

## Ownership and compatibility

The existing native request registry binds the caller to its immutable session,
generation, identity epoch, publisher, app, version, instance and granted domains.
The broker rechecks native lease and owner validity before dispatch and delivery.
Revocation aborts in-flight reads; native background/expiry is checked while work
is pending, before React Native lifecycle callbacks necessarily arrive. Final
native delivery independently checks the same generation. Reads never acquire a
signing approval or a scoped storage binding.

## Compatibility

The relay domain covers only selected operations. [Subscriptions](relay-subscriptions.md), individually reviewed publication and [Outbox routing](outbox-routing.md) have their own lifetime/permission policies. Query authority does not imply encrypted publication or automatic AUTH. Current tolerant admission reports unavailable groups without granting their operations; see [NAP support](nap-support.md). Optional AUTH announcements are discarded under the selected [read policy](relay-subscriptions.md#optional-auth-announcements); required authentication stays denied.

## Testing

Final Android/iOS acceptance remains open. See [testing](testing.md) for the unified requirement matrix, current quality gate, evidence limits and full standalone campaign.

Run `pnpm run test:query` and the [native Feed query guide](../tests/native/feed-query/README.md). Compare signed known events, empty EOSE, invalid signatures/filter mismatch, missing EOSE, frame/event floods, timeout and revoked owners. Diagnostic frame doubles, standalone transport/TLS proofs, actual SDK native reads and ordinary protected/published journeys are separate evidence.
