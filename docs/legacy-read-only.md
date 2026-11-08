# Legacy read-only compatibility

This optional execution profile opens the reviewed Recipe Cards and Longform
publications through Discover. Its native review checkbox starts unchecked.
Consent is saved for the exact publisher, identifier, signed event, artifact
version and selected account public key. A new version needs a new review;
carrying a workspace across accounts does not transfer consent. Manual address
opening retains ordinary napplet execution in this initial release.

## Boundary

Original signed HTML is verified before any host projection. Both reviewed
manifests declare no NAP domains, and that empty grant set stays intact. A
separate native context attests the selected profile and immutable source. Guest
messages cannot create the context or request generic Relay/Identity authority.

The guest remains in an opaque `allow-scripts` iframe. A compatibility WebSocket
facade accepts bounded NIP-01 REQ/CLOSE messages through the native owner and
configured public WSS relays. Peers outside the captured Network list are rejected
immediately with a configuration message. Direct network access, remote executable imports,
workers and nested frames remain blocked. EVENT, AUTH, signing, uploads and
private-key access are unavailable; `window.nostr` is not installed. A host
status line identifies the mode and limited reads.

Native token, account, generation, foreground, source, destination, filter and
lifetime checks still apply. There are at most three active subscriptions, four
logical sockets, four filters per request and 64 entries in bounded filter
lists. Initial stored history is limited to 32 events; partial limits are
reported, and a rejected or failed request never receives a false EOSE. Closing,
account switching, stale replies and document replacement revoke delivery.
Same-document hash navigation must answer a fresh challenge over a private
document-bound port before queued reads or deliveries resume. The probe has a
one-second deadline and a queue limit of 32 messages/256 KiB; failure clears it.

Recipe Cards' four original module specifiers resolve to reviewed local bundles,
not a general CDN allowlist. The parent runtime permits local blob scripts; the
ordinary guest CSP still does not. The legacy guest separately permits the local
module blobs while explicitly forbidding workers and connections. Dependencies,
original licenses and the Zod constrained-collection backport are recorded in
[the vendor record](../runtime/vendor/legacy-recipe/README.md). The runtime build
verifies the graph, patch and security regressions and includes their notices.

The trusted address control accepts bounded `naddr` or `nostr:naddr` article
addresses (kind 30023). It drops relay hints and uses only the captured Network
list. Longform opens its existing same-document reader route through the private
port. Recipe Cards has no address route: an explicit address selection narrows
only its reviewed broad article-feed request to that author and identifier with
limit 1, then refreshes the original Feed control. The guest renders the real
returned recipe card; the user opens it. Clear selection restores its normal
feed query. This is host projection, not a change to signed guest bytes.
Malformed addresses, other event kinds, external URLs and stale controls cannot
start reads or navigate a replacement document. No signer is introduced.

## Scope and checks

The immutable source allowlist lives in
[the profile validator](../src/napplets/legacy-read-only.ts) and both native
parsers. This is bounded read compatibility for those reviewed releases, not
full browser or NIP-07 compatibility. Public content can be absent or partial;
unsupported editing/publishing controls in the original guests remain disabled
by the host boundary.

Focused checks cover consent defaults, account/pin persistence, native admission
and effect binding, denied writes, signature validation, limits, stale replies,
frame binding and unchanged published guests. Browser/native component checks
and ordinary emulator journeys establish distinct scopes; see the test plan.
