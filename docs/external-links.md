# External links

The selected native HTTPS-opening profile implements CAP-07.
The selected [NAP-LINK proposal 53](https://github.com/napplet/naps/blob/e25143355f6d416bfce73b12ec814f1c795ec16a/naps/NAP-LINK.md)
is open and unmerged, checked 3 October 2026. Draft bytes SHA-256:
`e65cb78b0d30aff82c370a3b21840282649dec16ed984d99dc10e1b800d9ba1d`.

## Selected contract

HTTPS requests need trusted native approval for every opening. Review shows the
native-captured napplet/publisher and complete actual destination. The device’s
normal handler may open a browser or associated installed app. The guest label
cannot choose the destination, review buttons or policy. No remembered link
allowance, guest opener, shell fetch or returned bytes is granted. `opened` means
accepted OS handoff, not successful page loading. HTTP, mailto, tel, nostr and
custom schemes remain gaps without a promised delivery phase.

The conservative URI profile accepts absolute ASCII HTTPS URLs up to 4096 bytes,
DNS/punycode hosts, canonical dotted IPv4, bracketed IPv6, ports 1–65535 and
encoded paths/query/fragment. It rejects credentials, raw whitespace, controls,
backslash, Unicode, malformed hosts/ports and invalid escapes. Callers must encode
international names and paths; the shell does not silently normalize an approved
destination. A reviewed HTTPS localhost/private address does not grant guest
local-network fetching. No DNS or fetch preflight occurs.

The wire envelope is bounded to 16 KiB, IDs to 1–128 bytes and an optional label to
256 bytes without controls. One review/dispatch is permitted globally, with three
admitted reviews per generation and twelve globally per minute, at most 64
registered generations and a 25-second review expiry. There is no automatic retry.

## Ownership and revocation

Focus and foreground are required for review and dispatch. Blur/background cancels
undispatched review. A claimed one-shot OS receipt may complete across the background
it caused; close, replacement and identity revocation still suppress delivery.
That receipt cannot dispatch another opening or revive ordinary work.

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
