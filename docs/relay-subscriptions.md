# Live relay subscriptions

The selected [NAP-RELAY draft](https://github.com/napplet/naps/blob/0be8abce18beb46ca37bd4ddd042f58d30b4eedc/naps/NAP-RELAY.md) profile uses PR #2 revision
`0be8abce18beb46ca37bd4ddd042f58d30b4eedc`. NIP-01 comparison uses
`0046368a747c5c25ae2bec28bae0e537744c8f10`. This is a selected draft contract,
not an interoperability claim across every SDK release or future draft.

The genuine SDK sends `relay.subscribe` with original `id`, caller `subId`,
filters and optional relay. Replies are canonical `relay.event` with
`result: {event}`, `relay.eose`, and terminal `relay.closed`; `relay.close`
preserves its original caller ID. There is no public subscribe/close result ACK.
EOSE completes stored history while later matching events continue. A zero-limit
filter starts matching live events only after its relay connection sends EOSE.
The coordinator supplies that phase privately to the runtime because other relays
may still be sending stored history. The runtime omits the phase from the guest
reply. Fresh seven-field hash/signature/filter checks run at both boundaries.
Encrypted kinds 4 and 1059 are explicitly unsupported.

## Authority and bounds

Stream admission captures the native generation, public identity/epoch,
publisher, app, version, instance, grants, shared native sequence and actual
native recipient. Its one-use opaque lookup token stays app-only. Accepted stream
lifetime is independent of the ordinary 25-second pending native lease. Native
foreground/generation checks remain authoritative at the final renderer push;
JavaScript ownership checks add the runtime identity and workspace binding.
A close or revocation invalidates intent and delivery revisions before cancelling.

The process allows eight subscriptions and 64 session coordinators. A session can
hold three raw Relay streams, or two total streams when any stream uses Outbox.
Raw Relay uses the first two saved Network relays when the guest leaves the relay unspecified. Change their priority under Settings → Relays → Network. The native socket budget stays at 16 for the process. Filters retain the bounded core query
profile. A valid request for more stored events uses the existing limit of 32
per filter. Connections use fresh native UUIDs and host-created relay subscription
IDs; caller IDs cannot reopen closed intent. Trusted Network destinations are
snapshotted at admission; a scoped guest relay must already be trusted.

When the three raw slots are occupied, the runtime can hold up to three more
explicitly scoped raw starts for four seconds. Waiting starts hold no native
token and open no connection. A trusted terminal reply releases a slot, and
the runtime acknowledges it before dispatching the next waiting start. The
broker reports a policy denial only through its exact accepted native token.
Guest close, renderer teardown, or the original deadline removes the waiting
start. Unscoped and mixed Outbox streams keep their immediate quota behavior.

Serialized event size includes escaped content and tags and is bounded to 64 KiB.
The shared raw WSS frame ceiling is 66,560 bytes. Native frame delivery stays at one
unacknowledged frame per connection and renderer delivery to four messages/256
KiB per token. Native rolling wire bounds are 64 frames and 2 MiB per second.
The coordinator retains 1,024 recent event IDs and at most five consecutive failed
reconnect attempts with delays 1/2/4/8/16 seconds. Renderer acknowledgements use
the shared native sequence and exact monotonic per-stream delivery number.
Feed Lab retains 32 displayed rows and an editable draft. It renders text safely.

Malformed, invalidly signed, mismatching or excessive input quarantines that
connection for the current foreground interval. Other peers continue delivering
verified events. If every peer is exhausted or quarantined, the logical stream
closes. Transport failures retain the bounded retry policy; quarantine does not
retry until a fresh foreground connection interval.

All streams have a 15-second initial deadline (Outbox may select a shorter one).
At that deadline, pending peers stop. Aggregate EOSE requires an actual EOSE from
at least one peer; it indicates completion of available stored history, not full
relay coverage. Without any peer EOSE the stream closes with a timeout, even if
some verified events arrived. Background cancels the deadline and foreground
starts a fresh one. Terminal CLOSED is distinct from EOSE; an SDK or guest must
handle termination separately to clear its own loading state.

## Confirmed lifecycle

Loaded feeds stay live across napplet focus changes. Native background/inactivity
revokes socket delivery and cancels connections before React Native callbacks;
loaded verified read views and logical intent remain while the process survives.
Foreground creates fresh connection IDs, refreshes the original bounded recent
filter and deduplicates recent IDs. It does not promise gap-free history while
suspended. Native lifecycle revisions also handle a whole missed background/return
interval. Background alone does not send terminal `relay.closed`.

Explicit close, identity change, view removal/replacement, navigation, renderer
loss and termination revoke the old generation/intent. Revoked or closed reads do
not reconnect. Approval and pending transfer/background protections remain
independent. Android cancellation closes raw TCP synchronously; TLS close-notify
and cleanup remain on the worker, avoiding network writes on the UI thread.

## Optional AUTH announcements

The pinned [NIP-42 revision a2494f4](https://github.com/nostr-protocol/nips/blob/a2494f4f81d46684e5814a9bf35e2b1df978f955/42.md) permits AUTH announcements alongside public reads. Native/shared discovery, query and stream classifiers accept only an exact two-field string announcement under existing frame/byte/count/rate bounds, discard it and continue waiting for verified events/EOSE. No authentication state, guest challenge, signing permission or client AUTH response is created. An announcement is not successful history; malformed/flooded announcements and CLOSED fail closed. Required authentication stays denied under separate approval policy.

## Testing

Final Android/iOS acceptance remains open. See [testing](testing.md) for the unified requirement matrix, current quality gate, evidence limits and full standalone campaign.

Run `pnpm run test:subscriptions` and the [native subscription guide](../tests/native/feed-subscription/README.md). Cover actual WSS history/live delivery, duplicate/flood/invalid events, explicit close, foreground switch, background/return, missed lifecycle intervals, owner/view replacement and cold restart. Preserve independent signed-event observation; diagnostic frame faults and standalone registries cannot prove whole-app protected identity or published parity.
