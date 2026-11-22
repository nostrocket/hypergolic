# Discover

Discover is the packaged napplet catalog. Open it from the workspace overview or **Settings → Discover napplets**. Opening Discover again focuses its existing workspace card. The guest reads signed publications from the selected Network relays. Hypergolic resolves an Open request through the selected Lookup and Network relays and presents native review for the verified revision. [Published opening contract](published-open.md)

The feed opens with search and recent napplets. Each row shows the app, publisher and publication age. A community recommendation can appear when Discover verifies the app referenced by a signed public recommendation list. Select the recommendation to read the same details available from the recent feed. Recent napplets keep their publication order regardless of endorsements.

Discover samples up to 32 signed kind-30267 lists with the identifier `napplets` through the existing Relay read capability. It first matches named-app references against loaded entries. For up to eight distinct missing addresses per refresh, it queries the configured Network relays with the exact kind, publisher and identifier, in batches of up to four filters. A valid publisher-signed manifest can appear in Recommended even when Recent is empty. Opening it uses the same NAP-LINK review as a listing in Recent. Discover shows up to eight app and recommender pairs. Each pick identifies the person who signed the list, using a verified profile name when available or a shortened public key. The sample can use verified results from reachable Network relays while another relay is offline. Reading these public endorsements requires neither a follow list nor a signing identity. If there are no matches, the recent directory is available on its own.

The selected listing’s Open button shows a spinner until Hypergolic returns a result. Discover pauses other Open actions during that request and shows the outcome beside the selected action. A successful NAP-LINK result means that the shell accepted the handoff.

## Build and import

The portable guest is authored in the separate `napplets` repository. This
checkout includes its build source, tests and scoped lockfile in
[`napplets/discovery`](../napplets/discovery). The source corresponds to
`apps/discovery` at authoring commit `bcfc4f58a29f8d357fd01aab95d14d54af54853d`.
Use Node.js 24.20.0 and pnpm 10.34.5 to reproduce the shipped HTML.

```sh
pnpm --dir napplets/discovery install --frozen-lockfile
pnpm --dir napplets/discovery run build
cmp napplets/discovery/dist/index.html runtime/fixtures/napplet-discovery.html
```

For an intentional update, sync the reviewed authoring source and its exact
dependencies, run the guest tests, then import the new build and regenerate
the native runtime. The importer records the HTML SHA-256 and aggregate version.

```sh
pnpm --dir napplets/discovery run type-check
pnpm --dir napplets/discovery test
node scripts/import-discovery.mjs napplets/discovery/dist/index.html
pnpm run runtime:build
```

## Published catalog updates

`DISCOVERY_PUBLICATION_ADDRESS` in [discovery-publication.ts](../src/napplets/discovery-publication.ts) is unset. A future release can set it to the reviewed bare kind-35129 `naddr` without relay hints. That address fixes the publisher and exact app identifier across revisions.

With an address configured, Hypergolic checks for a release when the user opens or returns to Discover, and when the app returns to the foreground with Discover focused. The shell resolves the catalog through Lookup, verifies its signed event and HTML, and stages it before replacing the existing workspace card. A published catalog updates only to a newer verified revision of its configured coordinate.

An unchanged grant under the current support profile allows the verified update to proceed automatically. A new or changed grant opens trusted access review showing the publisher, exact release, and required and optional capabilities. Declining the review, losing focus during the check, or failing to reach a verified release leaves the current catalog in place. Other published napplets retain explicit version review. [Published admission and grants](published-network.md#published-admission-and-updates)

A retained published pin can reopen from its verified artifact cache. Directory
rows live in the current guest session. After a failed refresh, Discover
keeps the last results, shows when it checked them and pauses Open until a
refresh succeeds. Reloading starts a fresh directory. The bundled catalog has
no storage grant or portable account-and-relay key for a persistent directory.

## First page and relay coverage

Discover opens a short-lived standard Relay subscription for early signed
publications while a one-shot query checks the selected relays. Hypergolic's
stream previews its first two selected Network peers. The one-shot query covers
the full selection and determines ordering and pagination. Both paths verify
the event signature, filter and revision before displaying a listing.
[Relay subscriptions](relay-subscriptions.md)

Each page has one 5.5-second deadline. A measured response-size limit can
trigger a smaller page within that deadline. A timeout or transport failure
offers an explicit retry. If the one-shot read times out after a verified
preview arrived, Discover keeps the rows and marks coverage partial. An
optional Outbox query can also indicate incomplete coverage. A plain Relay
query cannot distinguish an empty response from a reachable subset, so the
empty state names reachable relays and offers Refresh. Search covers the
publications loaded so far. [Relay query](relay-query.md) · [Outbox routing](outbox-routing.md)

## Details and public recommendations

The list and details screen retrieve artwork by its signed hash. Discover can try up to four publisher-declared HTTPS mirrors through the Resource service, then the configured Blossom servers. It checks the image format, size, dimensions and hash before displaying it. Open passes the publication address to the shell with NAP-LINK. Native review names the verified app and publisher, the resolved revision, and requested access. After opening, use the shell menu to pin or unpin the napplet on Home. Pinning is local to the account.

Discover requests a public recommendation through the standard Lists API. Hypergolic offers the same operation to other napplets with Lists and Relay access. The selected profile adds one public named napplet address to the current account’s app curation set (kind 30267, identifier `napplets`). The shell can create a missing list when requested, skips existing members, and declines other operations, lists, private items, and custom metadata. [NAP-LISTS draft](https://github.com/napplet/naps/blob/7cf00cdb7bca6bb59dc5ef082e9fe8ac9278fa46/naps/NAP-LISTS.md)

The shell checks the signed list on the configured Network relays, preserves its content and other entries, and presents a native publication review. When only a verified subset of the configured relays is reachable, the review identifies the excluded relays and the risk of replacing a newer list. A change to the list or the relay set requires another check. The host rechecks before signing and before sending, and reports success after a positive relay acknowledgement. A lost acknowledgement leaves the result uncertain. Other clients can still update the same list after the final check.
