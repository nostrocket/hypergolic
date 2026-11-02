# Test napplets

Start with UX Lab → State Lab → Approval Lab, then exercise every MVP capability through Outbox. Value Lab, transfers and zaps are Phase4 and excluded. The profile napplet screenshot is an example, not a required product. Tests use genuine public SDK calls and trusted shell controls, without approval/storage/signing bypasses.

## Fixture coverage

| Fixture | Purpose |
| --- | --- |
| [NAP Support](../napplets/nap-support/README.md) | Reviewed proposal catalogue, reported operation support, search/filter and truthful fallback discovery; separate publication project |
| [UX Lab](../napplets/ux-lab/README.md) | Multiple temporary input/counter/scroll instances, gestures, overview and close lifecycle |
| [State Lab](../napplets/state-lab/README.md) | Saved/unsaved data; user/publisher/stable app scope; public profile/relay/follows/mutes/lists/badges |
| [Approval Lab](../napplets/approval-lab/README.md) | Individually reviewed note/update/list publication, delayed requests, deny/cancel and exact independent signed results |
| [Feed Lab](../napplets/feed-lab/README.md) | Query/EOSE/failure, streams/teardown/bounds, public follows and Outbox read/route/publication |
| [Resource Lab](../napplets/resource-lab/README.md) | Complete image/audio/video Blobs, scheme/bulk/cache/handle lifetime and external-link review |
| [Upload Lab](../napplets/upload-lab/README.md) / Upload Queue Lab | Prepared photos/unchanged attachments, exact preview/hash/destination, picker revocation, signing/PUT faults, queues and durable uncertainty |
| [Routing Lab](../napplets/routing-lab/README.md) and Peer | Handler intent/INC, sender/recipient correlation, denial/replay, foreground notify and config persistence |
| Signed host/local-update fixtures | Fixed locally signed artifacts exercise signature/hash/native transfer, update consent and exact pinned restart; not remote publication |
| [Live published fixture](../tests/native/live-published-fixture/README.md) / [live updates](../tests/native/live-update-publication/README.md) | Real Nostr/Blossom retrieval and v1/v2 update harness; preparation alone is not native/public acceptance |

The reviewed catalogue is `src/runtime/bundled-catalog.ts`; artifacts are staged in `runtime/fixtures`. Existing versioned Feed/Approval bytes remain pinned for saved sessions. `runtime:build` verifies staged bytes/hashes, never silently rebuilds napplet sources. [The fixture publisher](fixture-publisher.md) publishes only sealed acceptance artifacts and keeps its publisher separate from disposable run accounts. Run accounts survive the restart being tested; reset only between independent runs. Publish the same reviewed bytes and repeat native journeys after normal verification/consent. Embedded/local-signed/published routes are distinct evidence.

Approval Lab captures original content/timestamp/sequence, supports one note, three separate notes or a five-second delayed note, bounds active requests to four and never retries. Unsubmitted timers cancel on identity/pagehide; issued stale completions are ignored. Its kind10002 editor freezes exact read/write tags and empty content, disables batching and permits one pending list. This is explicit list publication, never automatic list creation or routing authority.

Routing Peer has distinct `routing-lab-peer` dTag/session with matching HTML. The bundled caller can use that field for a channel pair; this alone registers no verified intent handler. Signed auto-peer/storage/theme-only/publisher-collision variants exercise readiness, required grants and ambiguity through ordinary admission. Upload photo recipes use generated public metadata, never personal originals. Native byte seals and independent receiver/event checks remain required.

## Tooling and reference provenance

Use each fixture's pinned package/lockfile and [README](../napplets/ux-lab/README.md). UX and Approval currently pin SDK0.27.2, Vite plugin0.14.1, conformance CLI0.2.18, Playwright1.63.0, Vite7.3.7 and TypeScript6.0.3. SDK/core runtime behavior and conformance skips need separate review; a Ready/conformance label is not native boundary proof.

| Reference | Role and pinned revision |
| --- | --- |
| [Kehto web](https://github.com/kehto/web/tree/a7e0d12f6a6bd4c6d8f90a2b884febf7a2e08bfd) | Intended host toolkit and playground integration examples |
| [NIP-5A](https://github.com/nostr-protocol/nips/blob/a2494f4f81d46684e5814a9bf35e2b1df978f955/5A.md) | Draft nsite manifest/hash substrate; named nsite kind 35128 |
| [NAP registry](https://github.com/napplet/naps/tree/a040914b4bbd3a5cd8a14b0f316a723c968ebfb2) | Capability ownership/status and proposal links |
| [RocketShell napplet skills](https://github.com/nostrocket/rocketshell/tree/0b46d9cf8369576f11d87b92aa5436920fdfcd87/napplets/.codex/skills) | Reviewed design-napplet, build-napplet and test-napplet guidance |
| [Proposed NIP-5D](https://github.com/dskvr/nips/blob/24711d9c47bbdd07908bf1d52bf677d9cbc530f0/5D.md) | PR 2303; single-file sandboxed napplets and distinct manifest kinds; named kind 35129 |
| [NAP-THEME proposal](https://github.com/napplet/naps/blob/acac69d90811d1891db5faa33d64716be97d0a76/naps/NAP-THEME.md) | PR 8 head; color payload, get/result/change and failure semantics; document still says draft |

Inspected on 14 September 2026. The registry labels theme active while the proposal
text says draft. Its change notifications are automatic wire messages; the SDK
provides a local callback adapter. Optional theme recipients are at host discretion.
The fixture can continue without it.

The registry snapshot still describes kind 35128, whereas the pinned NIP-5D proposal
and selected plugin use 35129. Keep this distinction explicit in native loader
selection. Kehto's playground also documents host-owned shell bootstrap missing
from parts of the published shim. UX Lab does not supply a replacement handshake;
its Ready label is only a UI observation.


## Verification commands

From the repository root:

```sh
pnpm --dir napplets/approval-lab install --frozen-lockfile
pnpm --dir napplets/approval-lab verify
pnpm --dir napplets/approval-lab audit --audit-level=high
pnpm run runtime:test
pnpm run test:relay
```

Apply the documented `verify` script in each fixture package and preserve genuine SDK conformance omissions. `tests/native/upload/stage-lab.py` explicitly rebuilds/repins unsigned uploads; `stage-published-lab.mjs` signs already reviewed bytes. No test fixture may add unreviewed native authority. Public third-party compatibility claims name only actual granted/exercised operations; a theme-only file browser does not prove filesystem support.

Android requires a WebView bridge with message-listener support: the older unsupported path reports `webview-update-required` before guest execution. Compatibility shims for secure-random UUID and Object.hasOwn do not replace native isolation. Browser opaque-frame results do not prove Android WebView or WKWebView safety.

## Testing

Final Android/iOS acceptance remains open. See [testing](testing.md) for the unified requirement matrix, current quality gate, evidence limits and full standalone campaign.

Use disposable controlled peers for success/reject/delay/disconnect, then real published retrieval and standalone Android/iOS journeys. Record expected/actual observations and exact fixture/spec/source/artifact hashes per capability. Full published parity, update/restart/isolation, protected storage/authentication/capture, external-signer interoperability and final quality are campaign obligations, not inferred from fixture builds.
