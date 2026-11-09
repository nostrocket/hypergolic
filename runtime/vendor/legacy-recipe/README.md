# Host-supplied Recipe compatibility modules

These four self-contained ESM modules satisfy only the four exact historical
Recipe Cards import specifiers listed in `manifest.json`. The host maps those
specifiers to local Blob URLs. Original signed guest HTML remains unchanged and
is verified before this separate compatibility projection. No CDN executable
access is enabled.

The graph starts with the official npm releases `zod@3.23.8`,
`@noble/hashes@1.4.0` and `@noble/curves@1.4.0`. The manifest records their tarball
SHA-512 integrity, each source file's SHA-256, the pinned builder and each output's
SHA-256. `LICENSES.txt` preserves the original license texts and labels the local
Zod adaptation. Package versions identify the base releases; the Zod output is
explicitly modified as `hypergolic-size-gate-1`.

The [GitHub advisory GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)
lists Zod versions below 4.6.6 as affected. Its description broadly mentions
unconstrained arrays. The linked [upstream fix](https://github.com/colinhacks/zod/commit/a0ebf970f2d752e5f58527cd2942ff48be4f46bd)
and [PR #6652](https://github.com/colinhacks/zod/pull/6652) specifically reject
oversized constrained collections before parsing children; the PR states:
“Unbounded containers are unchanged.” The local backport has that same scope.
It does not impose new global collection limits or claim to prevent every form
of resource exhaustion.

In Zod 3.23.8, array and set upper-bound checks already precede child traversal,
but mark the parse dirty and continue walking. `zod-size-gate.patch` returns the
existing invalid sentinel immediately after an oversized array `.max()` or
`.length()`, or set `.max()`/`.size()`. This also stops later refinements from
reading unparsed children, matching the upstream change. Lower-bound failures,
valid input and preprocessing remain unchanged. Zod 3 maps have no built-in
size-bound API, so no map API is added. Original versions remain listed in the
registry; local remediation rests on the pinned patch and regression evidence,
not on changing a version label or suppressing an advisory.

Run from the repository root:

```sh
node runtime/tools/legacy-dependencies.mjs
node --test runtime/tools/legacy-dependencies.test.mjs
```

To reproduce the graph from the original official tarballs, use
`node runtime/tools/legacy-dependencies.mjs --regenerate`. It checks base source
integrity, applies the exact patch without fuzz and verifies the patched source
and all output hashes. It requires network access, the existing pinned runtime
build dependencies, `tar` and `patch`. A changed source graph or output fails;
updating pins requires explicit source review.
