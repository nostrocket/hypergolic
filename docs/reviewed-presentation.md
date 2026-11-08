# Reviewed publication presentation

Two exact ordinary publications receive fixed host CSS after artifact verification.
Their original signed HTML, script behavior, capability grants and CSP are unchanged.
The override requires `published: true` and the exact app ID and aggregate hash:

| Publication | Aggregate hash | Correction |
| --- | --- | --- |
| Emoji Browser (`emoji-browser`) | `24b16ab3eb550d50eff01a3c42c6e56c3a81da4cf6914b11dc766d8575767381` | Below 721px, wrap toolbar controls, constrain grid columns and keep controls at least 44px tall. |
| Creator Signals (`creator-signals`) | `a3320b9d78a3506bca07cb3ffcc09c2db3f36e5493574834c3cb14fc96ebac58` | Use the existing theme surface/text tokens for inputs and buttons. |

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
