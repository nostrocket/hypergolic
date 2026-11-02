# NAP support and tolerant admission

A signed, hash-verified published napplet may open after warning review even when
it requests unavailable domains. A napplet may degrade, but the shell does not
promise it can function without a declared dependency. The owning discovery
reference is [NAP-SHELL a040914](https://github.com/napplet/naps/blob/a040914b4bbd3a5cd8a14b0f316a723c968ebfb2/naps/NAP-SHELL.md)
and its [registry](https://github.com/napplet/naps/blob/a040914b4bbd3a5cd8a14b0f316a723c968ebfb2/README.md).
This policy changes neither manifest tags nor the pinned verification contract.

## Authority boundary

Signature, coordinate/publisher, aggregate/HTML hashes, trusted consent, version
pinning, update review, one-use native claim, identity epoch and session revocation
remain mandatory. Review lists every requested domain and unavailable feature.
Only the requested/supported intersection is granted and sent to native
configuration. Native parsers still reject unsupported domains. Outbox admission
uses [its selected profile](outbox-routing.md) and also requires Relay access.

SQLite schema v4 stores bounded trusted `support_review` metadata beside the
grant: requested set, allowed intersection and support-profile revision. The v3
migration preserves owners, revisions and domain sets. Grant and metadata use
the same transaction/revision compare-and-swap. Legacy grants without metadata
require one fresh review. An unchanged requested set/profile can reopen without
review; either changing requires review even if the allowed intersection is
unchanged. Denial retains the old grant and cannot stage a replacement session.
This account/publisher/app-scoped metadata is not writable through guest storage.

Settings exposes requested/unavailable capabilities for loaded published sessions.
Warnings also apply to updates and restoration. Their acknowledgement does not
approve signing, upload, external links or sensitive identity reads.

## Support napplet

The [bundled support napplet](../napplets/nap-support/README.md) reports reviewed
metadata using Available/Unavailable/Unknown. A tick describes the shell's
configured published-napplet profile, not full conformance or the current guest's
grant. Expanded details state concrete limits. FS/media remain unavailable;
selected Outbox operations are available subject to both grants and their bounds.

The advisory schema-v2 report names its scope and is separate from standard
permission discovery and native enforcement. Without that report, standard
discovery means Available/Not offered **for this napplet**. Incomplete or failed
discovery remains Unknown; late readiness refreshes the display. A timeout or
withheld permission is not proof that the shell lacks an implementation.

The catalogue is a reviewed snapshot of registry entries and open proposals, not
an exhaustive protocol registry or approval to implement a draft. Availability
metadata is not a live operation test. Change the support-profile revision when
availability, supported operations or limits change; display-only corrections
that preserve authority do not require a new fingerprint.

## Verification

Run `pnpm run test:capabilities` and the support napplet's documented checks.
Exercise first review, denial preservation, legacy grants, unchanged reopen and
changed-profile review. Browser discovery does not prove native execution or
complete conformance. Full Phase 2/3 acceptance remains open; see [testing](testing.md).
