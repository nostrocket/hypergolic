# Reviewed publication presentation

Five exact ordinary publications receive fixed host CSS after artifact verification.
Their original signed HTML, script behavior, capability grants and CSP are unchanged.
The override requires `published: true` and the exact app ID and aggregate hash:

| Publication | Aggregate hash | Correction |
| --- | --- | --- |
| Emoji Browser (`emoji-browser`) | `24b16ab3eb550d50eff01a3c42c6e56c3a81da4cf6914b11dc766d8575767381` | Below 721px, wrap toolbar controls, constrain grid columns and keep controls at least 44px tall. |
| Creator Signals (`creator-signals`) | `a3320b9d78a3506bca07cb3ffcc09c2db3f36e5493574834c3cb14fc96ebac58` | Use the existing theme surface/text tokens for inputs and buttons. |
| Mapplets (`mapplets`) | `3a5eeb98b3251a48a3ff1e32cb92ce76b7488b721dd492ae1659e90eeffe76f5` | Below 721px, wrap the action bar and nested groups while preserving the flexible map row. |
| Feed Manager (`feed-builder`) | `a45d5c2ad7316386e9604f0502c7b053be7d2a0b2f1ca8a941e74a1dd72c7754` | Below 721px, stack the saved list and editor, preserve vertical scrolling, wrap tabs/actions and provide distinct 44px controls. |
| Emoji Pack Creator (`emoji-pack-creator`) | `1533e892517b313b316b6137759580cbae0a82ca1c9d1de23f6b2f0f2dea6dea` | Below 721px, stack title and identifier fields, wrap the full identifier and upload row, and keep staged items and Publish reachable by vertical scrolling. |

Other apps, unpublished fixtures and future versions receive no override. This is
presentation supplied by Hypergolic, separate from the legacy read-only adapter.
It does not change Resource timing, retries or publication authority.

The browser tests load unchanged external guest fixtures through the actual main
runtime and mocked native artifact/read transport. The portable preparer verifies
the pinned lengths, UTF-8 and SHA-256 values in
[`reviewed-presentation-manifest.json`](../runtime/fixtures/reviewed-presentation-manifest.json).
It reuses the ignored cache, copies from `HYPERGOLIC_PRESENTATION_FIXTURES` when
provided, or fetches the exact pinned HTTPS objects with bounded reads and deadlines.
Missing inputs fail; tests are not skipped. No publisher HTML is tracked here.

Run from `runtime/`:

```sh
pnpm exec playwright test tests/reviewed-presentation.spec.ts
```

The focused cases cover Chromium/WebKit at 320/360px in light/dark themes,
touch bounds, the original Resource retry and selection controls, text contrast,
and negative app/version/publication controls. Native transport and ordinary
installed-app touch journeys remain separate evidence.

Mapplets tests expose its selected-state Edit control only to check presentation
and hit bounds. They exercise the original Route and Reload handlers, but do not
claim map rendering, selection or editor handoff. The unchanged rectangular
selection implementation uses mouse events; this CSS does not add touch support.

Feed Manager tests use its unchanged New/JSON/name/relay fields and Save handler.
They capture and reject the native publication request through a test double;
no event is signed or published. Desktop retains the original two-column layout.

Emoji Pack Creator cases stage a neutral PNG through a mocked upload result and
reject the first publication request. They prove original control/layout behavior,
not native file preparation, upload or publication. Desktop styles remain unchanged.
