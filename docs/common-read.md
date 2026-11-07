# Selected Common reads

The owning draft is [NAP-COMMON at `8cd0eae`](https://github.com/napplet/naps/blob/8cd0eae8550575771bb616a384e2dfbcade31673/naps/NAP-COMMON.md).
Hypergolic offers a partial read-only profile. The domain report describes the
method restrictions, and runtime availability follows the exact reviewed grant.

| Method | Required granted capability | Selected behavior |
| --- | --- | --- |
| `encodeNip19` and `decodeNip19` | Common | Public `npub`, `note`, `nprofile`, `nevent`, `naddr` and `nrelay` helpers. Secret-key types are refused. |
| `getProfile` | Common and Relay or Outbox | A bounded verified kind-0 lookup for one normalized public key. |
| `follows` | Common and Identity | The selected account's existing public kind-3 projection and cache policy. |
| `follow`, `unfollow`, `react` and `report` | Common | An immediate correlated `unsupported` result. |

No dependency grant is inferred from the Common declaration. A profile lookup
uses the granted Relay path when available, otherwise the granted Outbox path.
The latter borrows the original Common request's native lease and requires both
Common and Outbox in its captured registration. The app derives the exact author
and kind-0 filter. It retains the existing relay settings, native connection
policy, cancellation, result verification and read budgets. Nprofile hints stay
metadata and introduce no destinations. Returned picture and website strings are
metadata too. This service fetches no image or other resource.

The public profile and follows operations use the existing bounded safe-read
queue. Native and app read caps, waiting bytes and original deadlines remain
in force. Queue admission still reaches the app when only Common is granted,
so missing per-method grants return an explicit `unsupported` result without
making a read. Codec operations and refused social writes acquire no review or
publication lane.

Profiles use the existing latest-event selection and bounded profile projection,
including the `display_name` to `displayName` mapping. A found profile includes
its verified raw event. A completed empty lookup returns `profile: null`.
Transport failure has an explicit failure result. Foreign profiles never enter
the selected account's identity cache. Invalid targets return
`invalid-profile-target` without inventing a public key.

Public identifiers are bounded at 5000 UTF-8 bytes, relay hints at 16 entries and
individual TLV text at 255 UTF-8 bytes. Unknown TLVs are ignored. Malformed TLVs,
invalid UTF-8 and private-key types are rejected. Relay identifiers are encoded
data and do not perform network access. The codecs reuse pinned nostr-tools and
its existing `@scure/base` dependency.

Relay hints use ASCII `ws` or `wss` URLs without credentials or fragments, as
selected by this profile. The deprecated `nrelay` helper uses the single type-0
relay URL TLV from the historical NIP-19 definition, with Bech32 checksum
validation. It does not interpret raw URL bytes as a TLV stream. The Common draft
still lists this public type. [Current NIP-19](https://github.com/nostr-protocol/nips/blob/0046368a747c5c25ae2bec28bae0e537744c8f10/19.md),
[historical `nrelay` definition](https://github.com/nostr-protocol/nips/blob/524ff9b8052d7e8c0515f63baae218dc40c6f696/19.md).

The public `follows()` helper returns an array on success, matching the draft's
API table. Its canonical wire result retains `ok` and `pubkeys`. A failed wire
result rejects the public Promise. This avoids changing the wire into an array.

Previously saved exact pins can retain their pre-Common profile. A fresh open
must renew access before Common becomes available. Declining renewal preserves
the old grant. Unrelated declaration sets retain their prior review identity.

The controlled tests exercise permission combinations, exact signed profile
verification, codecs, cancellation and the packaged opaque-frame API. Live
publisher enrichment and ordinary standalone platform journeys are separate
acceptance checks. This profile does not establish the social-write contract.
