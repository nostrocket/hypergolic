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
UUID, surviving restart; a new opening after close receives another ID. Closing
retains shared data. Already-saved legacy numeric UX Lab descriptors remain
compatible.

The native [broker](native-capabilities.md) binds operations to current epoch,
immutable descriptor, generation and live membership. Get/set/remove/keys use
prepared SQL and transactional quotas: 256 keys, 1 KiB/key, 256 KiB/value and
512 KiB/namespace including keys/values. Internal storage work is also bounded
to 16 requests/binding and 128 total; workspace encoding is at most 512 KiB.
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

Restore initially mounts only the last focused napplet. Other entries show Open
to load until selected. Visited views remain mounted through focus, Settings and
overview changes; closing, accepted replacement or account epoch change tears
down the applicable generation. Opening order and persisted instance IDs do not
change merely on focus.

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
