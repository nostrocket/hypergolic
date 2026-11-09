# Opening published napplets from Discover

The packaged Discover napplet can ask Hypergolic to open a verified named publication in
the current workspace. The host injects `window.hypergolic.publishedOpen` into the
packaged Discover document and into verified revisions of the explicitly configured
Discover publication, when that configuration is present. The packaged build initially
ships with no remote Discover address configured.

```ts
const opener = window.hypergolic?.publishedOpen;
if (opener?.version === 1) {
  const { status, reason } = await opener.open(address, expectedEventId);
}
```

Pass a canonical bare lowercase kind-35129 `naddr` without relay hints and the 64-digit
lowercase ID of the signed event displayed in Discover. If the projection is absent,
show the address for **Settings → Open a napplet**. Settings resolves the coordinate
using the latest eligible publication available from Lookup relays.

Settings also accepts a lowercase NIP-19 `nevent` link for a kind 5129
snapshot. A supplied kind or publisher must match the exact signed event.
Lookup uses only the configured Lookup relays. The snapshot's own signed
hash and capabilities govern verification and access. Lineage can describe
where a snapshot came from and supplies no identity or permission.

Snapshots reopen by exact event ID and retain separate grants and data, even
when a named publication or another snapshot shares the HTML. They have no
update action. Discover's published Open contract remains for named addresses.

This Hypergolic extension has its own version and operation. NAP-INTENT dispatches
conventions to handlers. NAP-CATALOG describes available napplets. NAP-LINK hands an
external URL to the shell. The owning refs reviewed for this contract were
[NAP-INTENT](https://github.com/napplet/naps/blob/43cb3a4e855570ec4b90b9cc05f0c721e5ad0aab/naps/NAP-INTENT.md),
[NAP-CATALOG](https://github.com/napplet/naps/blob/1020ae53884a177b7ffc58a679126bc8800d0c6d/naps/NAP-CATALOG.md)
and [NAP-LINK](https://github.com/napplet/naps/blob/100e5c939ae6b1ea82cc58587c6da45a1cf8a760/naps/NAP-LINK.md).

## Review and launch

1. The runtime binds the request to its registered opaque iframe and per-document
   token. Native admission requires the eligible caller's live, ready, focused
   generation, selected account, owner revision and a fresh request sequence. The
   process admits one launch at a time.
2. The published loader resolves the publisher and exact `d` across the shell's
   selected Lookup and Network relays. Shared endpoints receive one query. If the
   first round yields no candidates and a relay failed, the shell retries failed
   peers once within the same deadline. It selects the newest eligible verified
   event and checks the caller's expected ID before fetching the HTML. The loader
   refuses same-time conflicts and checks the original bytes against the signed
   manifest.
3. The shell presents the actual caller, target publisher and `d`, signed event ID,
   verified artifact version, and required and optional capabilities, including
   unavailable ones. The same review obtains first-open or changed access consent
   when needed. Hypergolic saves approved access under the usual identity, publisher
   and app scope. A later launch failure may leave that approved access in place.
4. Approval permits the exact reviewed artifact. The host reuses a matching mounted
   view or stages the verified artifact through the ordinary one-use native transfer.
   A different saved revision of the same publication coordinate yields a conflict
   and can be handled through the ordinary update review. Relay coverage bounds
   knowledge of revisions for coordinates with no saved pin.
5. The source must keep focus through commit. The committed target then takes focus
   and supplies the native ready generation. Discover stays mounted and receives
   the result on its captured endpoint. Leaving the workspace target before
   readiness cancels the attempt. The host revokes abandoned staging and removes a
   newly created workspace entry when the original workspace is still writable.

Backgrounding, identity changes, closing the caller and renderer teardown revoke
pending authority. A still-live caller may receive `cancelled` when it loses focus.
Revocation suppresses the result when the native recipient is gone or the owner
revision has changed. The API times out locally so Discover can recover after resuming.

## Results

| Status | Meaning |
| --- | --- |
| `opened` | The reviewed target mounted and received native focus. |
| `busy` | An open request is already pending. |
| `cancelled` | The request lost its focus or lifetime before completion. |
| `rejected` | Review declined the open or its access. |
| `not-found` | Every selected relay completed without returning a publication for the coordinate. |
| `unsupported` | The signed publication uses an unsupported manifest format. |
| `conflict` | The relay query found distinct same-time revisions or the workspace holds a different saved revision. |
| `refresh-required` | The latest eligible event differs from the event displayed in Discover. Refresh the listing before requesting another open. |
| `failed` | The release could not be verified, prepared or mounted. |
| `unavailable` | The request was invalid, the workspace was full, or the projection could not get a receipt. |

The version-one result can include a bounded `reason` with `failed` or `unavailable`.

| Reason | Meaning |
| --- | --- |
| `lookup-unavailable` | The bounded trusted relay lookup could not complete. |
| `download-unavailable` | The published servers did not supply an artifact through the bounded download path. |
| `hash-mismatch` | A downloaded file did not match the signed hash and no mirror supplied the matching artifact. |
| `invalid-html` | The signed bytes failed UTF-8 or napplet HTML validation. |
| `stage-unavailable` | The verified artifact could not be handed to the native renderer after approval. |
| `workspace-full` | The workspace had reached its session limit. |

Discover selects its own static message from these reasons. Older Discover versions can use the base status.

Run the focused broker cases with `pnpm run test:capabilities` and the Java and Swift
endpoint tests with `pnpm run test:routing:native`. The browser projection check is
`pnpm --dir runtime exec playwright test tests/discovery-open.spec.ts` after building the
runtime. Release acceptance requires tapping Open from the packaged Discover napplet on
ordinary standalone Android and iOS with Metro stopped.
