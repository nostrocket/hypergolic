# Discover

Discover is the packaged napplet catalog. Open it from the workspace overview or **Settings → Discover napplets**. Opening Discover again focuses its existing workspace card. The guest reads signed publications from the selected Network relays. Hypergolic resolves an Open request through the selected Lookup and Network relays and presents native review for the verified revision. [Published opening contract](published-open.md)

The feed opens with search and recent napplets. Each row shows the app, publisher and publication age. A community recommendation can appear when a public recommendation list references a loaded app. Select the recommendation to read the same details available from the recent feed. Recent napplets keep their publication order regardless of endorsements.

Discover samples up to 32 signed kind-30267 lists with the identifier `napplets` through the existing Relay read capability. It matches their exact named-app references to verified catalog entries and shows up to eight app and recommender pairs. Each pick identifies the person who signed the list, using a verified profile name when available or a shortened public key. The sample can use verified results from reachable Network relays while another relay is offline. Reading these public endorsements requires neither a follow list nor a signing identity. If there are no matches, the recent directory is available on its own.

The selected Open button shows **Opening…** until Hypergolic returns a result. Discover pauses other Open actions during that request and shows the outcome beside the selected action. A successful NAP-LINK result means that the shell accepted the handoff.

## Build and import

The portable guest lives in `apps/discovery` in the separate `napplets` monorepo. Build it with Node.js 24.20.0 and pnpm 10.34.5. From the Hypergolic checkout, set `NAPPLETS_CHECKOUT` to the guest monorepo checkout.

```sh
export NAPPLETS_CHECKOUT=../napplets
pnpm --dir "$NAPPLETS_CHECKOUT" install --frozen-lockfile
pnpm --dir "$NAPPLETS_CHECKOUT" --filter @napplets/discovery build
node scripts/import-discovery.mjs "$NAPPLETS_CHECKOUT/apps/discovery/dist/index.html"
pnpm run runtime:build
```

The guest build produces one self-contained HTML file. The import records its SHA-256 and derived runtime version, then the runtime build packages the verified bundle for both native hosts. Review the imported bytes and digests together.

## Published catalog updates

`DISCOVERY_PUBLICATION_ADDRESS` in [discovery-publication.ts](../src/napplets/discovery-publication.ts) is unset. A future release can set it to the reviewed bare kind-35129 `naddr` without relay hints. That address fixes the publisher and exact app identifier across revisions.

With an address configured, Hypergolic checks for a release when the user opens or returns to Discover, and when the app returns to the foreground with Discover focused. The shell resolves the catalog through Lookup, verifies its signed event and HTML, and stages it before replacing the existing workspace card. A published catalog updates only to a newer verified revision of its configured coordinate.

An unchanged grant under the current support profile allows the verified update to proceed automatically. A new or changed grant opens trusted access review showing the publisher, exact release, and required and optional capabilities. Declining the review, losing focus during the check, or failing to reach a verified release leaves the current catalog in place. Other published napplets retain explicit version review. [Published admission and grants](published-network.md#published-admission-and-updates)

A retained published pin can reopen from its verified artifact cache. The guest keeps the last verified listing in memory during a failed refresh and pauses opening while the listing is stale. The directory starts a fresh listing session when the guest reloads.


Discover uses public relay queries. When the shell offers Outbox query, the catalog can retry a partially covered page. With ordinary Relay queries, individual peer failures may be indistinguishable from an empty result. Search covers the publications loaded so far.

## Details and public recommendations

The list and details screen retrieve artwork by its signed hash. Discover can try up to four publisher-declared HTTPS mirrors through the Resource service, then the configured Blossom servers. It checks the image format, size, dimensions and hash before displaying it. Open passes the publication address to the shell with NAP-LINK. Native review names the verified app and publisher, the resolved revision, and requested access. After opening, use the shell menu to pin or unpin the napplet on Home. Pinning is local to the account.

Discover requests a public recommendation through the standard Lists API. Hypergolic offers the same operation to other napplets with Lists and Relay access. The selected profile adds one public named napplet address to the current account’s app curation set (kind 30267, identifier `napplets`). The shell can create a missing list when requested, skips existing members, and declines other operations, lists, private items, and custom metadata. [NAP-LISTS draft](https://github.com/napplet/naps/blob/7cf00cdb7bca6bb59dc5ef082e9fe8ac9278fa46/naps/NAP-LISTS.md)

The shell checks the signed list on the configured Network relays, preserves its content and other entries, and presents a native publication review. When only a verified subset of the configured relays is reachable, the review identifies the excluded relays and the risk of replacing a newer list. A change to the list or the relay set requires another check. The host rechecks before signing and before sending, and reports success after a positive relay acknowledgement. A lost acknowledgement leaves the result uncertain. Other clients can still update the same list after the final check.
