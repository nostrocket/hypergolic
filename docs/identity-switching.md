# Identity import and whole-shell switching

Trusted Settings manages public accounts and native signing methods. Secret
import is entered in native UI and never appears in React snapshots or errors.
See [identity storage](identity-storage.md) and [external methods](external-signing.md).
Complete Phase 2/3 acceptance remains open in [testing](testing.md).

## Preparation and confirmation

Invalid/cancelled import leaves the current account and live napplets unchanged.
Native entry is masked and excluded from autofill/capture where supported; owned
buffers are cleared on cancellation, dismissal or lifetime loss. This does not
guarantee erasure of immutable strings or every OS/runtime copy.

Native preparation returns a public key and an opaque two-minute candidate bound
to vault ID/revision and owner. Importing an already selected local identity is a
no-op; selecting a saved account does not duplicate it. Importing for an account currently using an external method requires the native
import confirmation explicitly choosing its local key; successful import selects
local as part of that mutation. It does not require another method-picker action.
Linking the same public key preserves that account's data.

Confirmation names the destination account and warns that loaded napplets restart
and unsaved work is lost. Cancellation targets the exact pending request; stale
confirmations cannot accept a successor. Candidate ownership, native confirmation,
vault selection and workspace commit are independently checked.

Opening confirmation retains the existing native routing owner, revision and
registrations. Cancelling preserves configuration schemas, values and subscriptions
without guest re-registration. Trusted review focus is removed independently;
reviews cannot proceed while confirmation is open. Confirmed switching withdraws
the old routing owner before changing vault/workspace state. Deletion and recovery
cannot run concurrently.

## Commit and failure behavior

The process-owned transition controller serializes changes, freezes workspace
edits and waits for the latest descriptor save before native commit. Session
authority denies operations during switching. Accepted changes revoke the old
binding, advance epoch/revision as applicable and remount loaded sessions under
fresh authority. Data stays scoped to the selected account.

Account switching carries the currently loaded descriptors in opening order and
focus into that account's workspace; returning uses its own saved napplet data,
not a resurrected set of views previously closed elsewhere. Same-account method
changes also flush/restart sessions. Selection has no automatic signer fallback.

Known precommit denial preserves live state and re-enables edits. Uncertain native
writes, failed source saves or destination failures require recovery/restart;
the old account cannot remain exposed after durable selection may have changed.
Vault and workspace have separate commit boundaries, not a cross-store atomic
transaction. Preserve corrupt destination rows and stop entry; do not reset them
or generate a replacement identity.

Preparations carry a generation and the captured session. Fatal preparation
errors can revoke that session even after cancellation; a late failure cannot
overwrite a newer healthy session. Native callbacks, candidate cancellation and
workspace writes must never target a replacement operation. Public snapshots
validate inventory, exact selected account and accepted vault revision on use.

## Inactive identity deletion transition

Deletion requires the exact trusted confirmation/current session, an inactive
target and native authentication. Freeze/flush workspace before the native action.
Successful readback must remove only that account, retain current account/vault,
and advance inventory revision exactly once. Keep the workspace controller/epoch
and mounted data unchanged. A later account switch still revokes this authority.

Known authentication denial preserves unchanged state. Unknown writes or unexpected
inventory changes require recovery, even if a later read appears absent. A native
pending operation may be retried only under its exact recoverable state and fresh
authentication; never silently remove a key. Unaccepted revisions fail capability
and workspace checks. Local-key removal is a distinct operation retaining the
account, connections and data; neither deletion erases legacy namespaces.

## Native presentation and verification

Full-screen Settings/recovery modals own their safe-area context. Controls must
remain below system UI and reachable with large text. Cancellation is checked
during workspace flush, preparation, native review and authentication, not only
at the final button.

```sh
pnpm run test:storage
pnpm run test:security
pnpm run test:signer
pnpm run test:presentation
```

Regressions cover actual SQLite isolation, invalid/cancelled/duplicate import,
single-flight changes, late writes, stale epochs, deliberate-empty restoration,
destination corruption, lost acknowledgements and configuration/subscription
preservation. Native fixtures and physical account workflows have different
protection guarantees; their cases and remaining gates are in [testing](testing.md).
