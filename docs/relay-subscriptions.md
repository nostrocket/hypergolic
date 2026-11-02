# Live relay subscriptions

The selected [NAP-RELAY draft](https://github.com/napplet/naps/blob/0be8abce18beb46ca37bd4ddd042f58d30b4eedc/naps/NAP-RELAY.md) profile uses PR #2 revision
`0be8abce18beb46ca37bd4ddd042f58d30b4eedc`. NIP-01 comparison uses
`0046368a747c5c25ae2bec28bae0e537744c8f10`. This is a selected draft contract,
not an interoperability claim across every SDK release or future draft.

The genuine SDK sends `relay.subscribe` with original `id`, caller `subId`,
filters and optional relay. Replies are canonical `relay.event` with
`result: {event}`, `relay.eose`, and terminal `relay.closed`; `relay.close`
preserves its original caller ID. There is no public subscribe/close result ACK.
EOSE completes stored history while later matching events continue. Fresh
seven-field hash/signature/filter checks run before app delivery and again at the
captured runtime recipient. Encrypted kinds 4 and 1059 are explicitly unsupported.

## Authority and bounds

Stream admission captures the native generation, public identity/epoch,
publisher, app, version, instance, grants, shared native sequence and actual
native recipient. Its one-use opaque lookup token stays app-only. Accepted stream
lifetime is independent of the ordinary 25-second pending native lease. Native
foreground/generation checks remain authoritative at the final renderer push;
JavaScript ownership checks add the runtime identity and workspace binding.
A close or revocation invalidates intent and delivery revisions before cancelling.

The process allows eight subscriptions, two per session, two trusted relays per
subscription and 64 session coordinators. Filters retain the bounded core query
profile. Connections use fresh native UUIDs and host-created relay subscription
IDs; caller IDs cannot reopen closed intent. Trusted Network destinations are
snapshotted at admission; a scoped guest relay must already be trusted.

Event size is bounded to 64 KiB, raw text to 66 KiB, native frame delivery to one
unacknowledged frame per connection and renderer delivery to four messages/256
KiB per token. Native rolling wire bounds are 64 frames and 2 MiB per second.
The coordinator retains 1,024 recent event IDs and at most five consecutive failed
reconnect attempts with delays 1/2/4/8/16 seconds. Renderer acknowledgements use
the shared native sequence and exact monotonic per-stream delivery number.
Feed Lab retains 32 displayed rows and an editable draft. It renders text safely.

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
