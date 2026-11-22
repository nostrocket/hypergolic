# Opening published napplets from a catalog

Discover and other napplets with Link access use NAP-LINK to open a named kind-35129 publication. The caller passes its Nostr address. The shell resolves the address and reviews the signed revision it actually found. See the [link contract](external-links.md) for URL handling, result codes and limits.

## Review and launch

1. The shell checks the caller’s Link access, focused workspace session and selected account. It admits one launch at a time. Before contacting relays, it checks whether the named target can use a live view and, for a new target, whether there is room for another card.
2. The loader queries the owner’s selected Lookup relays. For a caller with Relay access, it also queries the selected Network relays. It verifies the publisher, identifier, signature and downloaded artifact. It rejects conflicting revisions at the newest eligible timestamp.
3. Native review shows the requesting napplet, the verified target and publisher, and the required and optional capabilities. Technical details include the event ID and hashes. Approval authorizes the reviewed artifact. Settings uses the same first-open review.
4. The shell rechecks capacity after approval and at commit. It focuses a matching mounted napplet or stages the approved artifact and opens it in the workspace. When capacity prevents an open, the shell explains how to free room and returns the ordinary policy denial to the caller. A different saved revision goes through the normal update flow. Closing the caller, losing focus before commit or changing identity can cancel the request.

Use the open napplet’s workspace menu to pin it to Home. Shortcuts belong to the selected account. See [workspace storage](workspace-storage.md).

## Opening a snapshot from Settings

Settings also accepts a lowercase NIP-19 `nevent` link for a kind-5129 snapshot. The shell queries the configured Lookup relays and verifies the exact signed event, including any publisher or kind supplied in the link. The snapshot’s signed hash and capabilities govern verification and access. Snapshots retain separate grants and data and reopen by exact event ID.
