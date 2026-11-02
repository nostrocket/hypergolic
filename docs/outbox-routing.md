# Outbox routing

Implementation through Outbox is complete; final CAP-12/CAP-14 acceptance remains open.

## Selected contract and policy

[NAP-OUTBOX PR32](https://github.com/napplet/naps/blob/4589a8f9a16d8aa29b3740e2b3b0cdca11e0976e/naps/NAP-OUTBOX.md) is pinned to `4589a8f9a16d8aa29b3740e2b3b0cdca11e0976e`; [NIP-65](https://github.com/nostr-protocol/nips/blob/0046368a747c5c25ae2bec28bae0e537744c8f10/65.md)/NIP-01 to `0046368a747c5c25ae2bec28bae0e537744c8f10`. This is a selected draft profile, not full stable-domain conformance.

Original SDK getEvent/query/resolveRelays/subscribe/close/publish use the trusted native host. Outbox requires both outbox and relay grants. Lookup relays discover verified signed kind10002 lists; data reads use author write relays and required recipient publication uses inbox read relays. Replacement winners follow NIP-01, including lowest lexical ID for equal timestamps. Signature/filter checks apply to stored and network data. Private/local/insecure destinations remain denied by the existing native DNS/TLS/public-WSS policy.

The identity-specific persistent list cache is fresh for 24 hours after a successful verified lookup. Reads may retain verified stale data for up to seven days while refreshing. Missing/failed discovery or authorless reads use bounded Network fallback and validated hints, reporting incomplete results truthfully. Publication refreshes expired metadata before review and refuses stale required routing. Missing own usable metadata permits labelled Network fallback; missing required inbox metadata blocks before review/signing.

## Review, publication and receipts

Before trusted review, freeze the exact unsigned primary template and the full unique union of own write, explicitly requested inbox read and explicit relay destinations. Bounds are 64 authors and 16 unique relay destinations; required fanout is never silently truncated. No automatic p-tag recipient inference is selected. toOutbox:false skips own discovery and own-list redistribution while explicit and required inbox destinations still apply.

Each new primary event needs exact approval. The native owner binds reviewed event/hash/identity/source/targets, freezes the signed primary bytes once, consumes each approved group/relay pair once and checks revocation at final emission. Fanout uses at most four concurrent connections and a shared 15-second deadline. The complete signed EVENT frame must fit 8192 bytes, including UTF-8, escaping and signature overhead; an oversized existing ancillary list denies review rather than disappearing.

The exact existing verified signed own kind10002 may be a separately reviewed ancillary item, sent only to approved destinations. No new list signature, automatic list creation or unrelated indexer broadcast occurs. This selected redistribution policy extends the pinned draft's at-most-one-signed-event rule, even though only one new event is signed. It must not be described as strict draft conformance.

Primary success requires every required inbox relay to accept; without required inboxes, at least one primary ACK is needed. An unrelated ACK cannot compensate for a rejected, unknown or cancelled required inbox. The existing-list receipt group has independent outcomes and cannot reverse primary acceptance. Native trusted UI distinguishes accepted, rejected, unknown and cancelled-before-send. ACK means relay acceptance, not recipient consumption. Original SDK failures retain their selected canonical error shape. No automatic retry occurs; a retry requires a new review.

Read/stream connections stay live across loaded foreground switches. Background closes them and foreground refreshes routing before reconnecting. Close, update and identity changes revoke old authority. Publication uses the focused approval lifecycle; switching invalidates approved publication. Upload's separate permission to continue across switches does not extend to publication. Pending reviews are distinct: background pauses them until explicit native resume, retaining the unchanged reviewed event within the bounded pending lifetime.


## Acknowledgement and transport boundary

A receipt is one complete JSON relay array with exact event ID, Boolean and reason. Reject trailing/concatenated input, raw NUL, invalid JSON grammar and non-JSON platform-parser extensions before graph allocation. Preserve the first exact ACK even if a later reply contradicts it. Android checks grammar before its platform parser; decoded values still undergo event correlation, type/field-count, reason and depth limits. The envelope is at most 2 MiB/depth 12; ACK reasons are at most 4096 UTF-8 bytes. Invalid post-send replies leave the outcome unknown. The syntax basis is [RFC 8259](https://www.rfc-editor.org/rfc/rfc8259).

WSS upgrade permits repeated unconsumed metadata after syntax/size checks; critical upgrade fields remain singletons. DNS/TLS, nonce, framing, forbidden-header and native ownership checks remain mandatory. This follows [RFC 9110 field lines](https://httpwg.org/specs/rfc9110.html#field.lines), [Server-Timing](https://www.w3.org/TR/server-timing/) and [RFC 6455 section 11.3.3](https://www.rfc-editor.org/rfc/rfc6455#section-11.3.3). See [published transport](published-network.md).

## Published admission

Outbox is in the reviewed published-domain set under support profile `hypergolic-native-2026-10-13-v1`. Remembered narrower grants require fresh review; denial preserves the old grant. Outbox-only admission can load but acquires no Relay authority: usable SDK Outbox requires both grants. Exact operation-specific native review remains mandatory. Injected URL authority parameters, stale source/generation and wrong publisher/app/version/account epoch fail closed. Existing signed-list redistribution remains the documented draft extension.

Local and selected external methods use the same exact approval binding; [external signing](external-signing.md) defines method choice, explicit Resume, cancellation and uncertain outcomes. Production protected iOS identity is unavailable on Simulator; never substitute a fixture signer and call that production proof.

## Testing

Final Android/iOS acceptance remains open. See [testing](testing.md) for the unified requirement matrix, current quality gate, evidence limits and full standalone campaign.

Run `pnpm run test:outbox`, `pnpm run typecheck`, original-SDK runtime tests and the [native Outbox runners](../tests/native/outbox/README.md) / [publication proofs](../tests/native/outbox/publication/README.md). Require ordinary app-UID/Expo/guest/protected-signer composition, exact independent frames and signer counters, all-required/ancillary fanout, lifecycle/cache/race/faults and published parity on both hosts. Standalone shell-UID/pre-signed TLS proofs establish only their named primitives.
