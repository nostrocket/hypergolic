# Discover

Discover is the packaged napplet catalog. Open it from the workspace overview or **Settings → Discover napplets**. Opening Discover again focuses its existing workspace card. The guest reads signed publications from the selected Network relays. Hypergolic resolves an Open request separately across the selected Lookup and Network relays and presents native review for the exact target. [Published opening contract](published-open.md)

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


Hypergolic's bundled Discover uses a private page projection over its existing
Relay grant. The shell keeps a separate cursor for each configured Network
relay. It retries a failed relay from the same cursor while other relays can
continue, and commits a cursor only after matched EOSE, event verification
and acknowledgement of the page by its original guest. Failed or truncated
coverage remains visible. Refresh starts a fresh bounded pass. Other shells
can use the portable guest with standard NAP Relay queries. Search covers the
publications loaded so far.
