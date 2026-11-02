# Hypergolic engineering

## Orient and preserve work

Before editing, inspect Git status, the current branch, remotes, recent commits
and relevant diffs. Preserve concurrent work and intentional removals. Stage only
the agreed changes. Do not rewrite existing history or push without authorization.

Read [architecture](docs/architecture.md), [development](docs/development.md) and
the [test plan](docs/testing.md). Keep current contracts beside the code. Store
working plans, raw evidence and chronological investigation notes outside the
public source tree; publish concise reviewed results with their limitations.

## Publication privacy

Before publishing, inspect source, Git metadata and artifacts for credentials,
personal identifiers, private repository references and machine-specific paths.
Use portable paths and neutral test target aliases. Preserve intentional public
attribution, the configured public Git identity and required third-party notices.
Do not change that identity without a request.

## Stack and scope

Use Expo/React Native for the Android and iOS shell, Kehto for the web runtime and
Applesauce for selected Nostr integration. Follow existing strict TypeScript and
native module conventions. Keep the code simple and changes focused.

The MVP extends through Outbox. Phase 3 includes native local signing, outgoing
NIP-46 and Android NIP-55 clients. Value/zaps and incoming signer services are
outside this scope. Signing-method selection is explicit and has no automatic
fallback. A verified napplet remains untrusted web content.

## Checks and evidence

Use pnpm and the pinned lockfiles. Do not fall back to npm, regenerate lockfiles
casually, weaken resolution policy or suppress findings. Use the actual scripts
in package.json and the commands in the development guide.

Add meaningful regressions for changed behavior. Run focused shared/native checks
and regenerate/compile each platform affected by native or config-plugin changes.
Documentation-only changes need link, command, whitespace and privacy checks.
Final React Doctor and aislop reports must both reach 100/100 with findings fixed.
Report blocked, skipped and unrun checks explicitly.

Builds, browser fixtures, simulators and physical tests establish different scopes.
Use emulator/Simulator testing where faithful; identify the missing capability
before a targeted physical test. Final acceptance requires ordinary standalone
Android and iOS journeys on the final artifacts. Keep Phase 2/3 acceptance open
until the matrix's evidence requirements are met. Never relabel an old failed
receipt or uncertain outcome as a new pass.

## Device test cleanup

Preserve the retained app's identity and data. Use explicit disposable targets,
accounts and fixture packages. After each physical batch, reconcile jobs and
uncertain side effects, remove the exact temporary apps/runners and scratch, and
verify before/after inventories. Removing a retained app requires explicit owner
approval because it erases app data. Do not leave test launchers for the owner to
remove.

## Protocol and security changes

Check the owning NAP/NIP specification and immutable revision before changing its
surface. Compare fields, direction, errors, lifecycle and caller trust; library
exports and tests are implementation evidence, not protocol authority. Resolve
product and draft-contract decisions before widening capabilities.

Carry accepted fields through every shell/host adapter and permission check.
Test denial, cancellation, stale replies, sender binding, payload integrity,
restart and revocation at the native boundary. Preserve unknown outcomes after
possible dispatch. Document unsupported operations and remaining conformance
gaps; never infer native security from upstream browser behavior.

Adapted from [Kehto's engineering guidance](https://github.com/kehto/web/blob/8ccc4f44b0a2bff3f16d1a4165d35b9c801b8634/AGENTS.md).
