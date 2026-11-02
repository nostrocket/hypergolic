# UX Lab

The first Hypergolic test napplet. It exposes temporary input, a counter, ten
horizontal markers and six vertical markers with edge buttons. Stable labels and
`data-testid` values let a driver inspect real UI state without a privileged test API.

Normal hide/show keeps each loaded instance's state. Destroying the document and
creating another starts fresh. Reset clears this instance's input, counter,
selection, edge result and both scroll axes, then returns keyboard focus to Add one.
No saved data or signing operations are involved.

## Run

Use Node 24.20.0 and pnpm 10.34.5, matching the native project's pinned toolchain.
From the repository root:

```sh
cd napplets/ux-lab
pnpm install --frozen-lockfile
pnpm exec playwright install chromium webkit
pnpm verify
pnpm preview --port 4176
```

On Linux CI, install browser system dependencies with
`pnpm exec playwright install --with-deps chromium webkit`.
Use `pnpm dev` while editing. This directory has its own pnpm workspace and lockfile;
it does not add fixture tooling to the native app's dependency graph. Dependency
age and trust checks match the root policy. The `ux-lab` CI job runs independently
of the existing native checks.

`pnpm verify` typechecks fixture source, builds, runs both browser projects, and
runs upstream conformance. `pnpm audit --audit-level=high` audits this package.
`pnpm test` requires a current build; use `verify` after changing source.

## Artifact and host contract

The build produces `dist/index.html` and `dist/.nip5a-manifest.json`. Despite the
sidecar filename, plugin 0.14.1 emits a **NIP-5D named napplet, kind 35129**, with
`d=ux-lab`, the HTML path hash and aggregate hash. It is an unsigned development
manifest template, not a published event. Builds reject a configured
`VITE_DEV_PRIVKEY_HEX`; release signing belongs to the separate trusted workflow.

There are no hard `requires` domains. Optional theme uses SDK `themeGet` and
`themeOnChanged`; the runtime must inject available domains before fixture code
runs. Missing/rejected/malformed theme falls back to local colors. Fonts and
background media are deliberately unused, so themes cannot add resource requests.
A later pushed theme wins over a delayed initial response. The SDK's callback
subscription is an implementation binding, not a new NAP wire subscription.

The fixture does not install a shim, announce a private handshake, access host DOM,
use browser persistence, call a network API or hold keys. Its visible Ready status
means its own controls initialized; it does not prove the host protocol is ready.
The SDK currently imports a theme-domain registration internally; it adds no
requesting authority. Vite's module-preload polyfill is disabled to keep direct
`fetch` out of the single-file artifact.

A native host must apply its selected verification, injection, isolation, CSP and
navigation rules. Embedding changes delivery only. An unsigned test fixture must
not appear as author-verified or silently become trusted native code.

## Automation observations

| Observation | Stable identifiers |
| --- | --- |
| Fixture initialization | `lab[data-ready="true"]`, `ready` |
| Counter and entry | `counter`, `increment`, `draft`, `draft-count`, `draft-mirror` |
| Horizontal content | `rail`, `marker-1` … `marker-10`, `selected`, `scroll-x` |
| Vertical content | `vertical-1` … `vertical-6`, `edge-left-1` … `edge-right-6`, `edge` |
| Reset and optional theme | `reset`, `theme-status` |

Read vertical scroll through the document's scroll position. No dirty-state
message is emitted; until that contract is selected, the shell should treat this
fixture's close status as unknown and use its agreed warning.

Tests mount the exact built HTML in `sandbox="allow-scripts"` iframes with a
restrictive test-host CSP. They exercise three separate instances, hide/show,
remove/recreate, reset, actual wheel and keyboard input, literal text handling,
optional theme/error/race cases, and 240/320/768-pixel widths. Theme-only adapters
exist in the tests, outside the artifact; they are not a Hypergolic host or proof
of NAP wire/native correctness. Screenshots and failure traces go to ignored
`test-results/`.

On 14 September 2026: **24/24 browser tests passed** in Chromium and WebKit.
Upstream conformance: **5 passed, 0 failed, 5 skipped**. The skipped checks cover
three unresolved manifest-event checks, no emitted wire envelopes, and unmeasured
lifecycle teardown. Local artifact tests separately check unsigned metadata and
both hashes. Signed resolution, native touch gestures, zoom, keyboard occlusion,
close approval and phone isolation still need actual Hypergolic tests.

See [the fixture plan and source registry](../../docs/test-napplets.md) for the
suite, pinned references and remaining integration decisions.
