# NAP Support

A bundled diagnostic napplet showing the reviewed NAP catalogue and Hypergolic's configured availability for published napplets. Open it under **Settings → Open NAP Support**. See the [host support contract](../../docs/nap-support.md) for admission and reporting semantics.

Rows use outline icons, independent upstream status and ✓ Available / ✕ Unavailable / ? Unknown. A tick means offered by this shell's published-admission profile, not full conformance or a grant to this diagnostic napplet. Expand a row for specific limits, reporting scope/source and the exact proposal reference. These are reviewed shell claims, not live operation tests. Search and filters work offline. `Active` is the owning registry's label; it is not renamed to `Approved`. New contracts found only in an open proposal are labelled `Proposed`. The registry sometimes says Active while a document header still says draft; the catalogue reports registry status, not inferred ratification.

Build with the repository's pinned tools:

```sh
pnpm --dir napplets/nap-support run type-check
pnpm --dir napplets/nap-support run build
```

This uses the existing locked runtime Vite/compiler, without another dependency installation. `dist/index.html` and `dist/manifest.json` are unsigned fixture artifacts. They are not the separate cross-shell product release. The fixture's manifest requests `link`; shells that reject unavailable required domains may refuse it. Without link permission, the rendered catalogue still offers selectable source addresses.

## Updating the living catalogue

1. Review the owning registry and new contract proposals. Update `src/runtime/nap-catalogue.ts`, its review date and exact revisions. Preserve upstream status wording; distinguish proposals from amendments and subtracks.
2. Review actual implementation and evidence. Update `src/runtime/support-report.ts` and bump `SUPPORT_PROFILE` when availability, operations or limits change. Do not derive a conformance grade from a domain allowlist. Keep concrete limits separate from availability. This label correction preserves the existing admission profile and does not trigger fresh consent for cosmetic changes.
3. Build and inspect the portable output. Stage reviewed bytes with `node runtime/tools/build-support-napplet.mjs --stage-reviewed`, then explicitly repin its HTML/aggregate hashes in `src/runtime/bundled-catalog.ts`.
4. Run admission, storage, broker, browser and native checks. Rebuild the host/app so catalogue and host report revisions travel together. A published copy is separately versioned and needs a reviewed release.

## Discovery and host report

NAP-SHELL's `shell.supports()` is scoped to what this napplet may use. False cannot distinguish an absent implementation from a missing grant. The napplet therefore never turns that boolean into a global Unsupported claim.

Hypergolic injects `window.hypergolicSupportReport`: a frozen, public, read-only advisory snapshot built by the running trusted host. Report schema v2 explicitly names its `published-napplets` scope. This local diagnostic extension is not a new NAP operation or permission. It contains only public availability/limits and report metadata; no identity, grants, files, keys or native bridge. Its availability follows the native published allowlist, including the selected Outbox profile. Availability is separate from final acceptance.

Without a compatible report, a completed standard handshake supplies Available/Not offered for this napplet. False does not establish global absence. Missing, failed and late discovery show Unknown, with late success updating the display. Foundational SHELL follows handshake success. No live probes, broad permission requests or automatic network updates run.
