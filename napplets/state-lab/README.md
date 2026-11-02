# State Lab

A test napplet for public identity and saved strings. The same source builds
`state-lab` into `dist/` and `state-lab-peer` into `dist-peer/`, giving automated
harnesses two distinct app identities. Both use SDK0.27.2, require identity/storage,
and optionally adopt the host theme. They remain unsigned and unpublished.

Use the pinned Node24.20.0/pnpm10.34.5 toolchain from this directory:

```sh
pnpm install --frozen-lockfile
pnpm verify
pnpm audit --audit-level=high
```

`verify` typechecks source, builds both single-file artifacts, runs Chromium/WebKit
and checks each build with conformance-cli0.2.18. The separate pnpm lockfile keeps
fixture tooling out of the native application dependency graph. Builds reject
`VITE_DEV_PRIVKEY_HEX`; signing belongs to a separate trusted publication workflow.

The controls expose `identity`, `identity-status`, `scope`, `key`, `value`, `read`,
`write`, `remove`, `keys`, `status`, `result`, `key-list` and `requests` as stable
test IDs. `result[data-state]` distinguishes idle, missing, present and error.
Writes are acknowledged only after the SDK resolves. Empty strings remain saved
values; missing keys remain null. Inputs survive errors, literal strings are never
interpreted, and late responses from an earlier identity cannot repaint results.
Shared and instance scopes use their actual SDK methods. No custom handshake,
storage implementation, namespace selector, direct network or signing key enters
the artifact. The shell owns compatibility and native authority.

On 15 September 2026, 30 browser tests passed (15 per engine), covering every
operation/scope, unsigned hashes, empty/missing/error states, literal data, absent
domains, identity/theme races, subscription cleanup and 240/320/768-pixel layouts.
The first race run had three incorrect Playwright argument bindings; those test
callbacks were fixed without changing the fixture behavior. Light and dark
WebKit/Chromium captures are retained with the test evidence.

Each upstream conformance run reports 5 passed, 0 failed, 5 skipped. The runner did
not resolve a signed manifest, observe wire envelopes or measure lifecycle. Local
artifact checks independently verify required tags and hashes; local SDK mocks
prove UI behavior only. Genuine Kehto/native admission, durable restart, namespace
isolation, quotas and revocation still need Android and iOS integration tests.

See [design](docs/design.md), the [source registry](../../docs/test-napplets.md), and
the [selected owning protocol revisions](../../docs/capability-contract.md).


Public identity controls now use genuine SDK reads. State Lab covers public profile,
relay preferences, follows, separately approved mutes/bookmarks/pins/interests,
accepted badges and explicit unsupported/deferred results. Feed Lab offers an
explicit follows read without changing query routing. See the selected
[public identity contract](../../docs/public-identity-data.md) and
[native acceptance drivers](../../tests/native/identity-data/README.md).
