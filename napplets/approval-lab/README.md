# Approval Lab

Approval Lab is an unsigned, standalone test napplet for Hypergolic's explicit
approval flow. It reads the selected public identity through `@napplet/sdk` and
submits unsigned kind-1 notes, kind-0 profile metadata or kind-10002 relay lists
through `relay.publish`.
The default is a note. Selecting profile metadata captures the bio as a JSON
`about` field and warns that acceptance replaces the selected identity’s profile;
use a development identity and the controlled QA relay for that test.

The fixture deliberately has no signing key, signer protocol, network client,
persistent storage, outbox or retry queue. Each button press captures an immutable
request payload, including its event kind and serialized content. A selected shell must review, sign and publish it.

```sh
pnpm verify
```

The browser tests use an explicitly labelled SDK mock. They prove fixture behavior
and artifact metadata, not native approval, signing, relay delivery or security.

Profile metadata follows [NIP-01 at the selected revision](https://github.com/nostr-protocol/nips/blob/01e707bacdc87cf262db80545aecaa8f17ac2a4f/01.md).
Changing the editor or event type after submission cannot change an existing
request. Each result shows its captured kind and actual content. Physical kind-0
review/signature/receipt acceptance remains a separate Phase 2.11 test.


Hypergolic retains both previous exact packaged artifacts for saved Approval Lab
views. Open a new Approval Lab view for these event-type controls; existing views
keep their original version. Both retained copies are excluded from new openings and fixture releases.


Relay-list metadata follows [NIP-65 at revision 0046368](https://github.com/nostr-protocol/nips/blob/0046368a747c5c25ae2bec28bae0e537744c8f10/65.md).
The separate editor accepts up to 16 `r` tags with a secure WebSocket URL and
optional `read` or `write`; omitted roles mean both. Empty tags can revoke the
advertised list. Content is always empty. The list and diagnostic correlation tags
are captured and frozen before immediate or delayed submission, then displayed in
the result. Use development identities: accepting relays replace their advertised
list. Batch publication is disabled, and only one relay-list request may remain in flight.
Ordinary note requests still use the existing four-request queue.

This fixture only checks input format. The shell remains responsible for native
URL/DNS/TLS policy, per-request approval, signing and actual relay delivery. It
creates no list automatically and does not write the shell's Outbox cache.
Physical list publication and subsequent Outbox routing/fanout need separate proof.
