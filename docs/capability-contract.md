# Selected native capability contract

This reference defines Hypergolic's selected NAP/native profile. Implemented
operations remain bounded by their grants, owners and lifetime checks. Full
Phase 2/3 Android/iOS acceptance remains open; see [testing](testing.md).
MVP scope extends through Outbox. Value transfers and zaps are post-MVP work.

## Owning specifications and supported profile

Package types are implementation evidence, not protocol authority. Pin the owning
revision before changing wire behavior:

| Surface | Selected authority | Profile |
| --- | --- | --- |
| SHELL, THEME, IDENTITY | [NAPs 5ac0490](https://github.com/napplet/naps/tree/5ac0490461ca6fec2f0d2e45b4835cf9bc08de24/naps) | Handshake/theme and read-only identity |
| STORAGE | [f71e84e](https://github.com/napplet/naps/blob/f71e84ebca7474db260346cbfc2d88f41b4e421e/naps/NAP-STORAGE.md) | get/set/remove/keys |
| RELAY | [0be8abc](https://github.com/napplet/naps/blob/0be8abce18beb46ca37bd4ddd042f58d30b4eedc/naps/NAP-RELAY.md) | Bounded query/subscribe/close and individually approved publish |
| RESOURCE | [8c0645d](https://github.com/napplet/naps/blob/8c0645d32ceb159bc3e8bcec1107a92862b7e86a/naps/NAP-RESOURCE.md) | Bounded info/bytes/bytesMany/cancel; [limits](resource-access.md) |
| UPLOAD | [a7cc174](https://github.com/napplet/naps/blob/a7cc17463cbf5d9cb87884b31071bc4fc826034c/naps/NAP-UPLOAD.md), [Blossom b5bd280](https://github.com/hzrd149/blossom/tree/b5bd2801d1763aa635fc8fea7a76597e0eb18990) | Per-file approval and metadata-only recovery; [profile](upload-access.md) |
| OUTBOX | [4589a8f](https://github.com/napplet/naps/blob/4589a8f9a16d8aa29b3740e2b3b0cdca11e0976e/naps/NAP-OUTBOX.md) | Selected reads, subscriptions and approved publication; [routing](outbox-routing.md) |
| Relay authentication | [NIP-42 a2494f4](https://github.com/nostr-protocol/nips/blob/a2494f4f81d46684e5814a9bf35e2b1df978f955/42.md) | Separate exact approval or auth-required denial |

Other selected capabilities have their own references: [links](external-links.md),
[intent/INC](intent-inc.md) and [notifications/configuration](notifications-configuration.md).
NAP-IDENTITY is read-only; NAP-KEYS concerns keyboard bindings. There is no
`identity.signEvent` or `keys.sign`. Required domain tags are bare names, not ACL
strings. Supported published domains are identity, storage, theme, relay,
resource, upload, link, intent, inc, notify, config and outbox. Outbox operations
also require Relay access. [Tolerant admission](nap-support.md) never grants an
unavailable domain.

The selected SDK/core exports accept an unsigned `EventTemplate`. The NAP 0.31.1
`RelayPublishMessage` signed-event type disagrees with that owning draft/API;
never add a dummy signature to satisfy the type.

## Message shapes

Requests flow guest → host; results return to the original live source. A nonempty
correlation ID of at most 128 UTF-8 bytes is not authority. Reject unregistered senders, forged results or
pushes, malformed envelopes and ungranted domains before dispatch. Identity,
storage and relay use canonical operation result/closed shapes; resource uses its
selected `.error` shape, not Kehto's nonstandard `operation.error` substitute.

Identity results retain the request type plus `.result` and original ID.
`getPublicKey` returns `pubkey:string` (empty when unavailable), never an error
field. `identity.changed` is `{type,pubkey}` without ID. Other reads return
`relays`, `profile|null`, `pubkeys[]`, `entries[]`, `zaps[]` or `badges[]` as
specified. Unsupported reads retain the canonical empty field plus explicit
error. Do not present bootstrap relays as discovered NIP-65 metadata. The
[public identity profile](public-identity-data.md) governs sensitive-list consent.

| Storage request | Additional fields | Success fields after type/ID |
| --- | --- | --- |
| `storage.get` | `key,scope?` | `value:string|null` |
| `storage.set` | `key,value:string,scope?` | None |
| `storage.remove` | `key,scope?` | None |
| `storage.keys` | `scope?` | `keys:string[]` |

Scope is absent/`shared` or `instance`. Native registration supplies ownership.
Errors use the same request type plus `.result`, `error:string` and no primary
result fields. Missing is `null`; failed read is an error. Writes succeed only
after commit. No clear, dirty-state, transaction or migration wire API exists.

| Relay request | Canonical behavior |
| --- | --- |
| `relay.publish` | Unsigned `event:{kind,content,tags,created_at}`; result `ok,event?,eventId?,error?` |
| `relay.query` | `filters[]`; success `events:RelayEventResult[]`, failure `error` without events |
| `relay.subscribe` | `subId,filters[],relay?`; source-bound event/EOSE/closed pushes |
| `relay.close` | Revoke this session's `subId` only |
| `relay.publishEncrypted` | Recognize canonical request; return `ok:false,error:"publish denied"` |

`RelayEventResult` wraps the signed event and optional sidecar; never modify the
event to add metadata. This profile disables encrypted/resource sidecars. Validate
the optional subscribe relay URL or deny it explicitly. No private-network relay
selection or undocumented SDK convenience-field reinterpretation is allowed.
EOSE is nonterminal; explicit close/revocation is terminal. [Subscriptions](relay-subscriptions.md)
and [Outbox](outbox-routing.md) own their routing/lifecycle extensions.

## Native ownership and storage continuity

Bind each view to immutable session ID, fresh native generation, identity epoch,
selected public key, verified publisher, stable app/d-tag, aggregate version,
persisted instance ID and grants. Guest JSON cannot choose those values. Correlate
by generation, operation and ID; changed-payload reuse is denied. Replies cannot
target replaced content.

SQLite namespaces use user, publisher, stable app, version, scope, persisted
instance (or empty) and opaque key as composite columns. Keys are data, not path
delimiters. Prepared queries and serialized transactions enforce 1 KiB keys,
256 keys, 256 KiB values and a 512 KiB UTF-8 namespace quota including keys and values.
Private keys and signer secrets do not enter this database.

An explicitly accepted update revokes/freezes old generations and atomically
copies saved strings into an empty same-owner version namespace with a receipt
and selected version. Retain old data. Never overwrite retained target data
blindly or copy across accounts, publishers or apps. Failure preserves the old
selection. Native authority never runs guest migration code; byte continuity does
not promise schema compatibility. Persisted instance IDs survive restart;
renderer generations do not. See [workspace storage](workspace-storage.md).

## Real Kehto admission and native operations

Keep genuine source-window registration, namespace injection, session/domain/ACL
and firewall checks. The host-only whole-operation override follows those checks
and precedes builtin persistence/signing. Preserve original window/message/reply
ownership. Native storage must not fall through to browser `localStorage`;
publication must not fall through to a browser signer. Kehto `auth.getSigner`
stays null. A relay service that receives an already-signed event cannot provide
the required approval boundary.

Before/after awaits and immediately before cryptographic/network effects, recheck
registration, owner/epoch, expiry, cancellation and focused review. Native
navigation revokes before replacement content inherits its WindowProxy; later
iframe-load detection is a backstop. Close, account change, accepted update,
renderer/navigation failure and process death invalidate old authority.

## Exact approval, lifetime and outcomes

Freeze a deep-cloned NIP-01 snapshot with selected public key, finalized timestamp
and normalized destinations before review. Validate exact unsigned fields, safe
integers, kind bounds, dense string tags and byte limits. No approved field or
destination may change. Reparse, hash and verify each signed result without
cached verification flags, then recheck authority before sending.

Native approval limits are four/session, sixteen/global and at most 600 seconds
from monotonic receipt. Only focused requests can be reviewed. Dismiss rejects
one and pauses review; Resume is explicit. Background/inactive pauses pending
review and revokes approved work, with bounded native handoff/authentication
exceptions defined by their owners. Process death never persists approvals.
Signing-publication client/SDK deadlines are 660 seconds; ordinary read deadlines
remain short. Do not refresh the reviewed timestamp or invent caller-cancel wire
messages. See [signing approval](signing-approval.md).

Success requires explicit relay acceptance. Connected sockets and queued bytes
are insufficient. Preserve per-relay accepted/rejected/unknown receipts. Missing
acknowledgement after send is unknown, not cancellation-before-send; revocation
cannot recall bytes. Never silently retry or resign. Keep richer native outcomes
without inventing extra wire fields. NIP-42 approval is separately bound to the
exact relay/challenge/socket generation/account; ordinary kind 22242 publication
is denied and cannot authorize AUTH.

## Required evidence

Use `pnpm run test:capabilities`, `pnpm run test:storage`, `pnpm run test:security`
and the focused native harnesses described in [testing](testing.md). Required
cases include real SDK errors, wrong owners/generations, quota/commit faults,
accepted-update rollback, mutation/replay, queue focus/expiry, cancellation,
independent signatures/receipts and navigation revocation. Browser or adapter
tests do not establish complete native security or final Phase 2/3 acceptance.
