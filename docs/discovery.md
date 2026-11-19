# Discover

Discover is the packaged napplet catalog. Open it from the workspace overview or **Settings → Discover napplets**. Opening Discover again focuses its existing workspace card. The guest reads signed publications from the selected Network relays. Hypergolic resolves an Open request separately across the selected Lookup and Network relays and presents native review for the exact target. [Published opening contract](published-open.md)

The feed opens with search and recent napplets. Each row shows the app, publisher and publication age. A community recommendation can appear when a public recommendation list references a loaded app. Select the recommendation to read the same details available from the recent feed. Recent napplets keep their publication order regardless of endorsements.

Discover samples up to 32 signed kind-30267 lists with the identifier `napplets` through the existing Relay read capability. It matches their exact named-app references to verified catalog entries and shows up to eight app and recommender pairs. Each pick identifies the person who signed the list, using a verified profile name when available or a shortened public key. The sample can use verified results from reachable Network relays while another relay is offline. Reading these public endorsements requires neither a follow list nor a signing identity. If there are no matches, the recent directory is available on its own.

The selected Open button shows **Opening…** until Hypergolic returns a result. Discover pauses other Open actions during that request and shows the outcome beside the selected action. The bridge reports the final outcome, so the spinner stays indeterminate through lookup, download and verification.

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

## Details and public recommendations

The list and details screen retrieve artwork by its signed hash. Discover can try up to four publisher-declared HTTPS mirrors through the Resource service, then the configured Blossom servers. It checks the image format, size, dimensions and hash before displaying it. Open requests the displayed revision. Tap **Pin** to save a private Home shortcut. A saved napplet shows a filled bookmark and **Unpin**. Either action takes one tap. Opening the saved napplet for the first time still requires its usual access review. Native launch review identifies the verified app and discloses required access. Each access type has its own icon. Muted green indicates support, red marks an unavailable requirement and orange marks an unavailable optional capability. Discover uses neutral icons when support is unknown. The text also explains unavailable access. The optional section lists the additional capabilities granted on opening. The launch review also identifies legacy read-only mode when selected.

Bundled Discover can also add a named kind-35129 app to the selected account’s public kind-30267 list with identifier `napplets`. The host reads the signed list across the configured Network relays, preserves its other entries and content, and presents a separate native publication review. It checks the list revision again before signing and before sending. The recommendation read can wait for a busy catalog, checks up to two relays concurrently and retries a transport failure once within the read deadline. If some relays complete the read and others are unreachable, Discover offers **Retry all relays** and **Use reachable relays this time**. The native publication review names the included and excluded relays and warns that an excluded relay could hold a newer list. Choosing a subset applies only to this recommendation. A changed list or relay set requires a fresh check. Invalid or truncated results cannot authorize a partial write. A positive relay acknowledgement confirms publication. An uncertain result offers an explicit check. Recommendations use the address of the app across releases.

These reads cover the configured Network relays. A newer copy held only elsewhere is outside that scope, and Nostr relays cannot atomically compare revisions across clients. The recommendation action is available in the packaged catalog. Opening and private pinning remain independent of publication.
