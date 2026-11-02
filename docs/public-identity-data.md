# Public identity data

This selected read-only profile binds every request to the native-captured selected
identity. The guest cannot choose a user, relay, cache, signer or decryption key.
The selected profile implements public identity reads; full integration acceptance is tracked separately.

## Owning contracts

NAP-IDENTITY is selected at [napplet/naps 5ac0490](https://github.com/napplet/naps/blob/5ac0490461ca6fec2f0d2e45b4835cf9bc08de24/naps/NAP-IDENTITY.md).
Nostr source events follow [NIPs 0046368](https://github.com/nostr-protocol/nips/tree/0046368a747c5c25ae2bec28bae0e537744c8f10):
NIP-01 signatures and replaceable ordering, NIP-02 follows, NIP-24 profile fields,
NIP-51 public lists, NIP-58 accepted profile badges and NIP-65 relay metadata.
The selected installed SDK uses these canonical result fields:

| Read | Source | Result |
| --- | --- | --- |
| Public key | Native selected identity | `pubkey` string; unavailable is empty, without `error` |
| Profile | Latest signed kind 0 by selected user | `profile` object or null; `display_name` maps to `displayName` |
| Relay preferences | Latest signed kind 10002 | `relays` map with read/write directions |
| Follows | Latest signed kind 3, public p tags | `pubkeys` array |
| Mutes | Latest signed kind 10000, public p tags | `pubkeys` array; separate remembered permission |
| Bookmarks | Latest signed kind 10003, e/a tags | `entries` array; separate remembered permission |
| Pins | Latest signed kind 10001, e tags | `entries` array; separate remembered permission |
| Interests | Latest signed kind 10015, t/a tags | `entries` array; separate remembered permission |
| Accepted badges | User kind 10008 or legacy 30008 `profile_badges`, exact signed award/definition joins | `badges` array |
| Blocks | No selected source mapping | Empty `pubkeys` plus explicit unsupported error |
| Zaps | Deferred to Phase 4 | Empty `zaps` plus explicit deferred error |

Unknown list categories return empty entries plus an explicit unsupported error.
Other failed reads carry their canonical empty/null field and `error`, preserving
request type plus `.result` and correlation id. A verified empty EOSE with no
previous source returns the canonical empty/null result. An empty EOSE cannot erase
a previously observed signed replaceable event. A newer signed empty list can.
Newest creation time wins; timestamp ties use the lowest lexical event id.

Profile fields are allowlisted strings: name, displayName, about, picture, banner,
nip05, lud16 and website. Relay hints, URLs, badge images and metadata are returned
as literal data: they do not change routing, open sockets, load images, verify
NIP-05 or initiate payments. List order is retained with duplicate values removed.
Encrypted list content is never decrypted or exposed. Address references are
returned without expanding named collections.

## Permission and lifetime

Ordinary identity domain consent covers profile, relay preferences, follows and
accepted badges. Public mutes and the three supported list categories require a
separate trusted Allow/Decline review showing the selected identity, verified
publisher and stable app. Bundled fixtures explicitly show their reserved publisher
namespace. Allow persists the exact user/publisher/app tuple across verified app
versions. Existing identity grants never imply this permission. These lists are
already public on relays; this control governs the shell identity API.

Settings lists the selected user's remembered permissions and can revoke them.
Revocation immediately blocks cached reads and cancels pending reviews/reads,
then removes the native allowance before the durable SQL deletion. Native queued
replies capture a revocation epoch; reapproval cannot revive an older ticket.
A failed durable revocation stays denied in the current process and reports that
restart may restore the prior saved permission, with an explicit retry control.
Close, replacement, identity change and background revoke pending delivery.
Switching among loaded napplets retains their foreground lifetimes.

## Cache and bounds

The dedicated app-only `hypergolic-public-identity-v1.db` stores original signed
source bundles by selected user and data category, separate from guest storage.
Every disk read reconstructs and verifies signed event fields and exact filters.
The dedicated `hypergolic-identity-list-access-v1.db` stores remembered permissions;
prepared transactions, readback and strict schemas guard both stores.

Cache is fresh for five minutes. Older data attempts a bounded refresh, then may
return the older validated cache on relay availability failure. Invalid signatures,
malformed new data or invalid badge joins fail explicitly rather than returning an
older cache. No cache plus unavailable relays fails explicitly. Authority and list
permission are checked before cache access and again before delivery. The chosen
NAP result has no freshness field, so consumers cannot infer whether a result was
refreshed. A freshness extension is a recorded future gap.

| Bound | Selected limit |
| --- | --- |
| Identity reads | Two concurrent, one per user/category, 20 seconds each |
| Cache | 64 rows, 4 MiB total, 256 KiB per source bundle |
| Query | Four filters, 32 events, 64 KiB per event, 512 KiB result, 64 frames, 15 seconds |
| Event tags | 256 tags; 1024 UTF-8 bytes per tag field |
| Public list | 256 public tags before deduplication |
| Badges | 12 accepted pairs, four public sets, one expansion level, eight thumbnails |
| Remembered permission | 64 exact tuples; no automatic permission eviction |

Shared query/tag bounds apply before projection, including the effective 1024-byte
limit for badge metadata carried in tag fields. Oversized or incomplete selected
sources fail; results are never silently truncated.

Accepted badges preserve the user's selection order. Every award must match its
exact definition, issuer and selected recipient. Unsolicited awards are excluded.
Only public profile acceptance and one-level public set expansion are supported;
nested sets, missing evidence and invalid/partial pairs fail. This strict selected
profile differs from NIP-58's permissive guidance to ignore incomplete pairs.
Returning all awarded badges remains an explicit future gap.


## Trusted shell avatar

The ordinary identity owner shares this verified profile resolver with the header
through an app-only `readProfile` method. The guest wire and native registration,
list approval, cache signature checks and replacement ordering are unchanged;
the shell does not manufacture a napplet registration to read its own profile.

A process-owned store captures the selected public key and session epoch, starts
without blocking the workspace, and cancels pending work immediately on identity
transition or recovery. Background and unmount clear the in-memory image and abort
the request; foreground return reads the profile again under the existing five-minute
verified-cache policy. Only one selected image is retained, with a forty-second
outer lifetime limit in addition to the existing profile and native request limits.

Picture URLs must pass public HTTPS preflight and the existing app-only native
public-address, DNS pinning, TLS, foreground and deadline checks. That transport
requires a successful direct response; a redirect or denied destination produces
the local fallback. Its two-MiB body bound and canonical Base64 checks precede
existing PNG/JPEG/WebP/GIF admission, which caps canvas dimensions at4096 on each
axis. Raster admission checks headers; the platform codec still owns full decode
and its error also selects the fallback. SVG and other document/media types are
not avatar sources. A signed profile authenticates its picture URL, not the image
content served at that URL.

Expo Image receives a local data URI with disk/memory caching disabled and animation
autoplay disabled. The two-character npub fallback is deterministic. Image failure
tracks the failed source. The native operation UUID also keys the avatar component,
so a replacement remounts for the same identity and late codec errors from its
predecessor cannot hide it. This key never grants a guest native authority.
No profile URL or app-only native transport is granted to a WebView.

## Testing

Final Android/iOS acceptance remains open. See [testing](testing.md) for the unified requirement matrix, current quality gate, evidence limits and full standalone campaign.

Run `pnpm run test:identity` and [native identity-data journeys](../tests/native/identity-data/README.md). Keep controlled frames/clocks, public WSS reads, protected identity switching and physical avatar results distinct. Cover the full data/permission/cache/badge matrix, public-source verification, account/publisher isolation, native queued revocation and cold restart. Missing/broken avatar outcomes alone do not identify a particular transport/codec failure branch.
