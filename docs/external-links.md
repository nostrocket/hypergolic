# External links

Hypergolic supports reviewed HTTPS links and in-shell links to named napplet publications.
The HTTPS projection follows the selected [NAP-LINK revision](https://github.com/napplet/naps/blob/e25143355f6d416bfce73b12ec814f1c795ec16a/naps/NAP-LINK.md)
reviewed 3 October 2026. Draft bytes SHA-256:
`e65cb78b0d30aff82c370a3b21840282649dec16ed984d99dc10e1b800d9ba1d`.

For named napplet links the host implements the optional Nostr scheme and passes
through a denial reason as described in the [updated NAP-LINK draft](https://github.com/napplet/naps/blob/100e5c939ae6b1ea82cc58587c6da45a1cf8a760/naps/NAP-LINK.md).
The existing HTTPS projection returns its original status-only result.

## Selected contract

HTTPS requests need trusted native approval for every opening. Review shows the
native-captured napplet/publisher and complete actual destination. The device’s
normal handler may open a browser or associated installed app. The guest label
cannot choose the destination, review buttons or policy. No remembered link
allowance, guest opener, shell fetch or returned bytes is granted. `opened` means
accepted OS handoff for HTTPS.

Any foreground caller with the link grant can request `link.open("nostr:" + naddr)`.
Hypergolic resolves the supported kind-35129 coordinate on the account's
configured Lookup relays. Relay hints cannot add destinations. The selected
revision may have changed since a catalog displayed it. The shell checks the
signed manifest and artifact bytes and presents its own review with the verified
target, publisher, revision and requested access. Approval is required even for
an already-running target. A conflicting saved revision uses the ordinary update
flow. The caller gets a correlated NAP-LINK result. `opened` follows successful
workspace navigation. Denials do not reveal whether the target is installed.
Other Nostr references, HTTP, mailto and tel are unsupported.

The conservative URI profile accepts absolute ASCII HTTPS URLs up to 4096 bytes,
DNS/punycode hosts, canonical dotted IPv4, bracketed IPv6, ports 1–65535 and
encoded paths/query/fragment. It rejects credentials, raw whitespace, controls,
backslash, Unicode, malformed hosts/ports and invalid escapes. Callers must encode
international names and paths; the shell does not silently normalize an approved
destination. A reviewed HTTPS localhost/private address does not grant guest
local-network fetching. No DNS or fetch preflight occurs.

The wire envelope is bounded to 16 KiB, IDs to 1–128 bytes and an optional label to
256 bytes without controls. For HTTPS, one review/dispatch is permitted globally, with three
admitted reviews per generation and twelve globally per minute, at most 64
registered generations and a 25-second review expiry. Napplet handoffs have one shared pending launch, a two-minute native lease and the same per-minute source and global request limits. There is no automatic retry.

## Ownership and revocation

Focus and foreground are required for review and dispatch. Blur/background cancels
undispatched review. A claimed one-shot OS receipt may complete across the background
it caused; close, replacement and identity revocation still suppress delivery.
On iOS a claim near review expiry has up to 1.5 seconds for the OS callback. A missing callback returns the error `handoff-result-unknown` on the original request. That receipt cannot dispatch another opening or revive ordinary work.

The trusted identity owner synchronizes user/epoch/availability before vault work
or React teardown. A newer epoch invalidates old native generations. The app-only
synchronization method exposes no URL opener. Native null revocation clears runtime
transport bookkeeping without becoming a guest denial; browser coverage advances
beyond the transport timeout to verify no late result. A current owner still gets
canonical denial for policy failure or expiry.

Native review escapes control, bidi and paragraph characters in signed identifiers
literally while preserving ordinary Unicode and the original captured identity.


## Testing

Final Android/iOS acceptance remains open. See [testing](testing.md) for the unified requirement matrix, current quality gate, evidence limits and full standalone campaign.

Run `pnpm run test:links`, `pnpm run test:links:native` and the input-driven journeys in `tests/native/links`. Cover per-opening consent, complete destination review, handler return/missing handler, expiry, rate limits, cancelled/stale owners and verified-published parity. `opened` proves OS handoff only.
