# Mesh over paired LAN devices

This implementation targets the complete guest API in
[NAP-MESH bf9a472](https://github.com/napplet/naps/blob/bf9a4722244e29661c06d2fb4db7d3c7346d064a/naps/NAP-MESH.md).
It is under construction and is not advertised by ordinary builds. Protocol
components or controlled tests do not establish paired-device acceptance.

## Circle and transport

The shell owns a per-account circle of explicitly paired devices. Discovery
finds endpoints; it does not establish trust. A paired device may use the same
account. Reachable peer counts deduplicate member public keys, including the
selected user's key once when another paired device uses that account.

The first transport connects Hypergolic devices on one LAN using native TLS 1.3
with mutual certificate authentication and stored SPKI pins. This does not
implement Myco's FIPS transport or pairing protocol. No public relay, guest
socket, internet rendezvous or transport-key substitution for an event author is
part of this profile. The app operates in the foreground; OS local-network
permission and a usable LAN are separate from pairing and napplet consent.

Each pinned device certificate is a private self-signed trust anchor. Exactly
one presented certificate is accepted, with the expected SPKI, algorithm, usage,
self-signature and validity period. This grants no trust to certificates issued
by that key. The backend preserves the library's verification flags.

Mbed TLS 4.2.0 and its matching TF-PSA-Crypto 1.2.0 provide the shared native TLS
backend under Apache-2.0. Product configuration restricts it to TLS 1.3,
certificate authentication, P256 ECDHE/ECDSA, AES-128-GCM and SHA256/HKDF. Session
tickets, resumption, early data, PSK, older TLS and generic socket adapters are
disabled. Both X.509 and handshake signature policies apply. Native OS entropy
and exact peer pins are required. Transport keys are separate from Nostr keys;
software key material exists only in native memory and protected native storage,
not in guests or JavaScript. This is not a claim of hardware-contained TLS keys.

## Mutual pairing

A native user action creates a single-use 120-second invite. A QR carries the
protocol, invite ID and secret, selected public account, server SPKI pin and
bounded local rendezvous information. A pre-pair channel can carry only pairing
frames. Each participant approves the exact counterpart in native UI. A scanned
invite or a successful TLS handshake cannot authorize Mesh content.

Each participant signs SHA256 of one fixed native transcript with their selected
Nostr identity. Its exact byte order is:

1. ASCII `hypergolic.mesh.pairing.v1`, followed by NUL: 27 bytes.
2. Native signer role: one byte, 1 for inviter or 2 for joiner.
3. Invite ID: 16 bytes.
4. SHA256 of the invite secret: 32 bytes.
5. Inviter and joiner public keys: 32 bytes each.
6. Inviter and joiner SPKI pins: 32 bytes each.
7. Inviter and joiner fresh nonces: 32 bytes each.
8. Expiry in Unix seconds: unsigned 64-bit big-endian.

Each transcript is 276 bytes. The native invite/join action fixes the signer role;
the guest cannot choose it. Each signature is verified against its corresponding
role-specific transcript, so one signature cannot act as both sides when the
account public keys match. The native owner validates
keys, pins, nonce freshness, invite secret, account, original deadline and consent
before minting a one-use fixed-transcript permit. Identical device pins or nonces
are rejected. The encoder is not an authorization mechanism or generic signing
API. Both signatures and native approval are required before storing membership.
Later channels require an existing locally approved record as well as complete
mutual bindings; received signatures cannot create membership by themselves.

Completed pairings persist beyond the invite expiry. Unpairing revokes existing
channels and pending work immediately. A lost transport key requires pairing
again; replacement credentials do not inherit old trust.

## Napplet authority and lifecycle

A Mesh grant explains that the napplet can read this account's stored and future
circle events, and repeatedly sign and send events as the user without a prompt
for every event. Hops can reach members of members. A new semantic grant review
is required; historical reviews showing unavailable Mesh do not grant it.

Mesh imports Relay wire types but requires no guest Relay, Outbox, Identity or
Storage grant. The initial offline signing profile uses the explicitly selected
native local signing method. Other signing methods remain unavailable for this
profile unless their own repeated-signing route is implemented and accepted.
There is no fallback to a retained local key.

Native source authority binds account and vault revision, identity epoch, exact
verified publication and instance, registration generation, Mesh grant revision
and circle revision. Every publication gets a fresh one-use permit. Native code
captures kind/content/tags, owns author and timestamp, and constructs the final
event. A supplied valid `created_at` is accepted as template provenance and
overwritten. A supplied pubkey, id or signature is rejected.
Dedicated authentication event kinds 22242 and 24242 remain denied. Expiration
is checked before signing and enqueueing as well as on incoming events.

An open, granted napplet may retain Mesh while another card has focus and the app
remains foreground. Backgrounding, account or method change, source close or
replacement, grant revocation and unpairing retire relevant permits and delivery
leases. Resuming cannot revive them. Worker reservations remain occupied until
actual signing or IO drains, even after a logical cancellation.

## Complete API obligations

| Operation | Required behavior |
| --- | --- |
| `info` | Actual transport state, distinct reachable member count, user hop caps; no identities or addresses. |
| `publish` | Sign, durably keep non-ephemeral events, deliver locally even at ttl 0, then enqueue along paired edges. Ephemeral kinds 20000–29999 are never stored or backlogged. |
| `subscribe` | Register live delivery without a snapshot gap, deliver local backlog, emit one local EOSE without waiting for peers, and perform bounded remote backlog requests when ttl permits. |
| `blobs` | Ask the reachable paired members about explicitly shared verified bytes; return distinct-member counts with bounded concurrency and time. No download, redirect or internet request. |
| `close` | End the specified Mesh subscription and its remote interests without affecting a Relay subscription with the same ID. |

Requested ttl must be a whole number from 0 to 255. Omission uses the user cap;
a larger valid value is clamped and its effective value returned. A ttl 0
subscription skips remote backlog but receives subsequent matching peer events.
An incoming forwarding clamp is owned by the shell. Event bytes remain unchanged
across forwarding; hop metadata stays outside the signature. Forward each ID at
most once and deduplicate live delivery per subscription. Remote backlog may
still deliver a globally known event to a newly requesting subscription.

Persistence must be account-isolated and durable before non-ephemeral publication
succeeds. Expired events are rejected. An ID-only dedup ledger retains forwarding
decisions without storing ephemeral bodies, signatures or tags; quota exhaustion
fails explicitly rather than allowing an old ID to acquire forwarding authority
again. A missing blob-presence backend returns an error, not invented zero counts.
An empty functioning catalog is a valid empty result.

Initial bounds are publish ttl 2, subscribe ttl 1 and incoming-forward ttl 2;
16 member identities; 8 KiB signed events; two running publication jobs and four
waiting; an original 15-second publication deadline; 20 publications/second per
source with a burst of 40; four subscriptions/source and 16/account; four filters
per subscription; 64 MiB/20,000 durable events; and 64 MiB of explicitly shared
blobs. Blob requests accept at most 64 hashes as a whole, with two concurrent
calls/account, a three-second deadline and a two-second answer cache. Limits
bound work; they do not grant additional authority or turn incomplete work into
success.

## Acceptance

Controlled checks cover native authority, immutable event fields, actual TLS
authentication, storage failure/restart, ephemeral nonretention, three-node
forwarding/backlog, positive blob presence, cancellation and revocation. Full
support remains unproved until ordinary builds exercise all four methods.

WoTformer acceptance additionally requires two owned paired devices running the
unchanged verified publication: Display on one, Controller on the other, with
touch input visibly moving and jumping on the remote display. Test an unpaired
negative control and an internet-disabled usable LAN. Keyboard fallback, same-
process delivery, standalone components and successful compilation do not satisfy
that device requirement.
