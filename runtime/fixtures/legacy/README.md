# Historical guest test inputs

The exact Recipe Cards and Longform publications are external test inputs.
`../legacy-manifest.json` pins their event IDs, HTML SHA-256 hashes, lengths and
content-addressed download URLs. Downloaded publisher HTML stays in the ignored
`runtime/.test-fixtures/legacy/` cache.

Run `node runtime/tools/prepare-legacy-fixtures.mjs` from the repository root.
The standard runtime test command and the two guest test suites prepare and
verify these inputs automatically. Missing inputs fail the tests; no cases are
skipped.

To reuse an existing verified archive, set `HYPERGOLIC_LEGACY_FIXTURES` to its
directory. Files there must use `<eventId>.html` names. The preparer copies only
bytes matching the committed hash and length. With no archive configured, it
fetches the exact pinned HTTPS URLs with a 15-second deadline, no redirects and
the reviewed byte ceiling. Cached bytes are reverified before every test run.
