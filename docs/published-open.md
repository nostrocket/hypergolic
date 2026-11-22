# Opening published napplets from a catalog

Discover and other napplets with Link access use NAP-LINK to open a named kind-35129 publication. The caller passes its Nostr address. The shell resolves the address and reviews the signed revision it actually found. See the [link contract](external-links.md) for URL handling, result codes and limits.

## Supported publication kinds

| Publication | Open from Settings | Find in Discover | Open through NAP-LINK |
| --- | --- | --- | --- |
| Named (35129) | Yes, by address | Yes | Yes, by address |
| Snapshot (5129) | Yes, by event link | No | No |
| Root (15129) | No | No | No |

The [pinned NIP-5D draft](https://github.com/dskvr/nips/blob/f60550c3409d6d81a875088ec83e660571e10504/5D.md) defines all three kinds. A root belongs to a publisher and has no named identifier.

## Review and launch

1. The shell checks the caller’s Link access, focused workspace session and selected account. It admits one launch at a time. Before contacting relays, it checks whether the named target can use a live view and, for a new target, whether there is room for another card.
2. The loader queries the owner’s selected Lookup relays. For a caller with Relay access, it also queries the selected Network relays. It verifies the publisher, identifier and signature, and rejects conflicting revisions at the newest eligible timestamp. It then looks for the exact signed event and HTML hash in a held artifact or the selected account’s verified cache. A cache miss downloads from the signed mirrors. Concurrent opens of that same revision can share the body read while each keeps its own review and cancellation.
3. Native review shows the requesting napplet, the verified target and publisher, and the required and optional capabilities. Technical details include the event ID and hashes. Approval authorizes the reviewed artifact. Settings uses the same first-open review.
4. The shell rechecks capacity after approval and at commit. It focuses a matching mounted napplet or stages the approved artifact and opens it in the workspace. When capacity prevents an open, the shell explains how to free room and returns the ordinary policy denial to the caller. A different saved revision goes through the normal update flow. Closing the caller, losing focus before commit or changing identity can cancel the request.

Use the open napplet’s workspace menu to pin it to Home. Shortcuts belong to the selected account. See [workspace storage](workspace-storage.md).

## Guest transport

Modern published releases outside the two reviewed read-only exceptions start with the [NIP-5D port handoff](https://github.com/dskvr/nips/blob/f60550c3409d6d81a875088ec83e660571e10504/5D.md#transport). Its injected bootstrap creates the channel before publisher scripts run. The shell accepts the port from the registered frame, binds the verified publication and grants, and answers requests there. The guest can ask for its theme before requesting Shell environment details. A granted Mesh service uses the same connection and keeps its native source checks. The two read-only compatibility releases, older-format releases and bundled guests retain their previous transports. [Migration issue](https://github.com/nostrocket/hypergolic/issues/98).

## Opening an older named release

A release that signs a file listing can still open through legacy compatibility. The shell verifies its signature and HTML hash, identifies the older format in the launch review, and asks before opening it from an address. A saved capability grant alone cannot approve that choice. Reopening an exact saved pin can reuse its existing grant. A manual update identifies the older format in the version review. Automatic catalog refresh keeps the current release when an update would require legacy compatibility.

## Opening a snapshot from Settings

Settings also accepts a lowercase NIP-19 `nevent` link for a kind-5129 snapshot. The shell queries the configured Lookup relays and verifies the exact signed event, including any publisher or kind supplied in the link. The snapshot’s signed hash and capabilities govern verification and access. Snapshots retain separate grants and data and reopen by exact event ID.
