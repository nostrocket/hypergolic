# Testing Hypergolic

The [acceptance matrix](../tests/acceptance-matrix.json) is the whole-app test plan.
It covers the native shell and identities, every MVP capability through Outbox,
local signing, NIP-46 on Android/iOS, and Android NIP-55. Value transfers, zaps,
Value Lab and incoming signer-provider services are outside this campaign.

The 2 November 2026 source audit finds the selected Phase 3 integrations present;
that is a code checkpoint. Phase 2.11 and Phase 3 final acceptance remain open.
The matrix preserves all 61 original requirement IDs and their exact historical
platform statuses: eight rows passed on both platforms; 53 remain open. It adds
EXT-01–09 without adding passing claims. EXT-09 is complete for the outgoing-only
architecture boundary; it does not mean incoming signing services are delivered.
Historical passes need an applicability review against the final candidate.

## Run the plan

1. Read [architecture](architecture.md), [development](development.md),
   [signing core](signing-core.md) and [external signing](external-signing.md).
   Resolve the actual checkout/branch and preserve its existing changes. Select
   pinned protocol/spec revisions, fixture versions and final source/artifact
   digests before collecting results.
2. During development, use shared/native suites and emulator/Simulator input
   wherever faithful. Before a physical check, name the missing simulator
   capability: protected storage, actual authentication/capture protection or a
   demonstrated picker/external-app limitation. A harness failure does not prove
   a product failure; retain it and stop repeated speculative tooling repair.
3. After code and dependency/quality closeout, run the matrix's `testCases` on
   ordinary standalone Android and iOS without Metro. Each case gives steps,
   expected results and required evidence. Each row's `requiredEvidence` also
   applies; one shared-case pass never automatically closes every mapped row.
4. Start with T01–T08 (workspace, identity, isolation and review), then T10–T20
   (published loading, capabilities and hostile callers), T21–T24 (methods and
   external signers), and T25–T26 (full published journey and release checks).
   Apply T09's lifecycle/race variants to every signing route. Reuse a valid
   unaffected result only with an explicit source/artifact applicability record.
5. Run applicable capability groups embedded and verified-published using the
   same reviewed bytes. Exercise publication, Outbox and Blossom with local and
   NIP-46 on both platforms, and NIP-55 on Android. Test real NIP-46 and Amber
   interoperability separately from controlled-peer faults. iOS NIP-55 is not
   applicable, never a pass.

Use disposable run accounts separate from the fixture publisher; retain accounts
across the restart under test. Use controlled relays/resource/upload/signing peers
for deterministic faults and independent event/byte/count observations. Keep a
positive control beside hostile tests. Public network ACK, exact-ID retrieval,
new forwarding, durable file storage and controlled receiver consumption are
separate facts. A bounded absence observation cannot prove zero native signing
or emission.

## Automated checks

Use the pinned Node/pnpm toolchains and frozen lockfiles. From the repository root:

```sh
pnpm run check
pnpm run runtime:test
pnpm run test:shell
pnpm run test:security
pnpm run test:storage
pnpm run test:capabilities
pnpm run test:relay
pnpm run test:query
pnpm run test:subscriptions
pnpm run test:resources
pnpm run test:uploads
pnpm run test:identity
pnpm run test:links
pnpm run test:routing
pnpm run test:presentation
pnpm run test:outbox
pnpm run test:signer
pnpm run test:quality
pnpm run test:tester
```

Use the applicable owning native runners described in [development](development.md),
[signing core](signing-core.md#reproducing-checks) and the READMEs under `tests/native/`.
For example, `pnpm run test:signer:native -- --platform <android|ios> --suite <suite>`
also needs an explicitly selected disposable target and, for Android NIP-55, a
reviewed provider build. Follow the runner's documented arguments; unavailable
environments and zero executed cases must fail. These commands are a plan, not a
record that this draft ran them.

Final package work uses `pnpm run export:android`, `pnpm run export:ios`, the
relevant prebuild/native builds in [development](development.md), and the tester
preflight `pnpm run build:tester --check` before its documented signed Android
build. Keep signing secrets outside the repository. Build success, static package
inspection and simulator success each establish only their tested scope.

Both final React Doctor and aislop reports must reach **100/100**, with findings
fixed and no suppression. Keep blocked scans, dependency/audit findings and
historical exceptions visible; an old exception is not a fresh waiver. Verify
actual delivered native/JS/transitive dependency attribution and original
license/NOTICE bytes on both packages using
[native dependency notices](native-dependency-notices.md).

## Record results

For each platform and case, record the matrix's `evidenceRecord.requiredFields`,
including source tree/artifact/fixture/spec digests, actual input, expected/actual
results, independent observations, limitations and cleanup. Use neutral target
aliases and repository-relative evidence links. Publish reviewed summaries and
digests, without device IDs, personal paths, private-vault links, secrets, callback
tokens or raw operational logs.

Preserve `inheritedStatus` as the historical snapshot; append new run results and
reviewed evidence rather than editing old failed receipts into passes. `status`
is a coverage summary; a final pass requires the complete row evidence on the
current artifact and every applicable platform/method/fixture variant. The
`requirementStatus` of EXT rows describes the source requirements ledger, not a
new campaign result. Keep partial coverage and uncertainty explicit.

Cancel/reject/expiry after possible signing or network dispatch can remain
uncertain. Never auto-resend, silently switch methods, extend the original
absolute deadline or replay approval. Reconcile pending jobs and side effects
before retry/cleanup. Remove exact test-owned apps/runners and scratch; compare
before/after inventories and verify retained app/account/data remain intact.
Uninstall alone does not establish Keychain erasure. Final acceptance is a
separate decision after all required evidence and open gaps are reconciled.
