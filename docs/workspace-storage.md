# Workspace persistence

The shell persists opening order, selected napplet and explicit empty state per
public account. A missing workspace uses approved initial fixtures; an existing
empty row remains empty. Corrupt/unavailable descriptors stop startup without
replacement. Stored state consists of descriptors and saved strings, not live
WebView memory, unsaved drafts or approval requests.

## Ownership and commits

The process owner opens dedicated `hypergolic-shell-v1.db` after the native vault
is ready. Workspace storage is separate from account/key commits. Each binding
captures public account, vault selection/revision and epoch, checking them around
asynchronous work. A competing React runtime cannot reopen owners in the same
process.

The controller publishes immutable cached snapshots. Only one save runs at once;
coalescing retains the latest subsequent snapshot. Revision checks prevent stale
writes from overwriting new state. Failure revokes the binding, preserves the
mounted shell and displays recovery. A lost commit acknowledgement stays uncertain
until persisted state is read after restart; do not retry it as a fresh write or
turn it into an empty workspace.

SQLite transactions use the dedicated connection, WAL, FULL synchronization,
verified foreign keys and required iOS full-fsync settings. These checks do not
prove physical power-loss durability. No key/signer secret enters this database;
ordinary napplet strings are stored as text.

## Prepared storage capabilities

Namespaces use account, verified publisher, stable app, aggregate version and
shared/instance scope. Instance scope additionally includes a persisted native
UUID that survives restart. Reopening a saved Home pin restores its instance
ID. A fresh opening gets a new ID. Closing retains shared data. Already-saved legacy numeric UX Lab descriptors remain
compatible.

The native [broker](native-capabilities.md) binds operations to current epoch,
immutable descriptor, generation and live membership. Get/set/remove/keys use
prepared SQL and transactional quotas: 256 keys, 1 KiB/key, 256 KiB/value and
512 KiB/namespace including keys/values. Internal storage work is also bounded
to 16 requests/binding and 128 total; workspace encoding is at most 512 KiB.
Separate guest requests can reuse a completed namespace validation on the same SQLite connection.
The cache stores only namespace identifiers and SQLite change counters. Writes on the connection
or commits by another connection invalidate a hit. The host checks the counters on both sides
of an indexed read, captures a fresh transaction on a change and clears the cache on account
workspace binding or database close. Each request still has its own revocable authority.
Delimiter-like keys are data and cannot choose another namespace. Missing is
null; empty strings are preserved; write success follows commit.

Accepted verified updates revoke/freeze old generations and atomically copy
strings into an empty same-owner version namespace with selection and receipt.
Keep old state. Never overwrite retained target data blindly or copy between
accounts/publishers/apps. Failures preserve old selection; native authority runs
no guest migration code. Copied bytes do not guarantee schema compatibility.

## Published descriptors and grants

A published descriptor retains coordinate owner, content version and exact signed
manifest event ID. Restore rejects absent/malformed pins and revalidates exact
cached bytes or fetches only that event. Accepted updates save content version
and event pin together. Older descriptors without valid pins fail closed.
Migrated update receipts with unknown event pins cannot be replayed as verified
success.

Revisioned grants are scoped to account, publisher and stable app. Trusted writes
use compare-and-swap, snapshot inputs before awaits and reject malformed domain
sets. Migrations preserve existing workspace/app data. Schema-v4 support metadata
records requested set, supported intersection and profile in the same transaction;
see [admission](nap-support.md). A persisted grant alone does not authorize a live
generation or approve an operation.

## Lazy restoration and transitions

Restore initially mounts the focused napplet when its card is open. Other cards
load on selection. Switching to Home, Settings or All napplets normally keeps
visited views mounted. Closing a card, accepting a replacement or changing the
account epoch tears down the applicable generation.

Foreground Android views can remain resumed for live overview previews; focus
separately gates media and privileged work. Activity background pauses rendering
and playback. Account changes flush/revoke/remount; cancelled confirmation
preserves the existing routing/configuration registrations. See
[identity transitions](identity-switching.md) and [close checks](close-check.md).

## Verification

```sh
pnpm run test:storage
pnpm run test:capabilities
```

Tests cover namespaces, quotas, SQL parameters, corruption, cancellation,
copy/rollback, lost acknowledgements, real process restarts and explicit-empty
restoration. [Workspace restart](../tests/native/workspace-restart.md) and
co-located native drivers describe installed-app scenarios. Native fixtures
establish only their own storage/UI scope, not physical key protection. Full
ordinary-app and Phase 2/3 acceptance remain open in [testing](testing.md).

## Home shortcuts

Home is separate from the overview of open sessions. The header logo returns to
Home without closing live views; All napplets opens the existing switcher. There
is no bottom navigation bar. The shell removes focus/input authority while Home
is visible and keeps already-loaded views mounted.

Workspace snapshot version 2 stores an ordered `pins` array and a `home` flag in
the existing per-account row. Version 1 snapshots remain readable and receive
Discover as their initial shortcut. An explicitly empty version 2 pins array is
preserved, so unpinning Discover survives restart. The SQLite schema is unchanged.

Pin from an open napplet's workspace menu. Each publication has one shortcut,
keyed by source, publisher and app identifier (snapshot identifiers remain exact).
Shortcuts retain the selected signed revision. Opening focuses an existing session
for that publication or reopens the saved descriptor through ordinary artifact
verification and access review. An accepted update refreshes an existing shortcut
in place. Unpinning changes neither open sessions, grants nor application data.
The first version supports up to 64 shortcuts in pinning order.

Signed content-addressed artwork uses the existing bounded native image loader;
missing or unavailable artwork uses a title monogram. Discover uses bundled brand
artwork. No arbitrary remote image URL is passed to the native image component.

### Game controls

The napplet menu offers a Game controls switch below Pin to Home. Each identity
remembers the enabled games by source, publisher and app identifier in its
workspace snapshot. Missing preferences default to off. Changing the switch
updates the running game immediately. The preference survives closing the game,
reopening it and accepting a new revision of the same publication.

The runtime suppresses text selection and touch callouts on HTML buttons, button
inputs and elements with a button role. It disables browser double-tap zoom on
these controls while respecting the game's explicit touch-action styles.
Custom unmarked controls need markup from the game author.

### Follow-up

- Long-press actions to rearrange and unpin Home shortcuts. The first version uses
  Edit on Home and Unpin from Home in the napplet menu.

A focused napplet uses the landscape viewport. **All napplets** stays available in the upper corner and returns to the overview without closing the napplet. Android Back also opens the overview after dismissing any open keyboard or shell surface.

### Reclaiming background views

Hypergolic keeps up to eight native WebViews loaded. Opening a ninth can release
the least recently focused background view with a confirmed checkpoint. The card
keeps its position, instance ID and exact signed revision. Returning to the card
opens the verified version and restores the checkpoint. The same policy can
release eligible background views when the shell receives a system memory warning.

The shell also checks for pending host work. A fresh guest request, an incoming
delivery or renewed focus invalidates the native checkpoint. Views with unknown
state stay loaded. When every view needs to stay open, opening a new published
link offers **All napplets** immediately. An already loaded target remains
available through the ordinary launch review.

The first supported guest is Workspace Journal at signed event
`54ae23083f1dccfaecf88e0df7281d6c9f1502dc31f288c127379169a36f53e2`.
Its new-entry editor saves the unfinished title, body, links, active field and
selection to private instance storage. **Save entry** stays under the user's
control. An edit to an existing entry, an active input-method composition or a
failed checkpoint keeps the editor in memory. Other releases stay loaded until
their restoration behavior is supported.

The shell tracks which checkpoint belongs to a suspended card for the current
account session. Process termination and account switching end that association.
Use **Save entry** for journal entries you want to keep across those transitions.
