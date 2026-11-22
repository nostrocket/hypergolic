# Napplet discovery catalog

Browse, search and inspect signed named Napplet publications. The guest reads the shell’s relays and can ask the shell to open the selected publication.

## Build and verify

From the workspace root, use Node.js 24.20.0 and pnpm 10.34.5.

```sh
pnpm install --frozen-lockfile
pnpm --filter @napplets/discovery exec playwright install chromium webkit
pnpm --filter @napplets/discovery verify
```

The build writes one unsigned `dist/index.html` and prints its size and SHA-256. The artifact includes its runtime license notices. The browser tests inject a test shell and signed fixtures. The shipped directory reads from the active shell.

## Guest contracts

- The pinned `@napplet/sdk` 0.27.2 uses `relay.query` for kind 35129 and matching kind-0 profiles. Link, resource, theme, lists and outbox access are optional. Publishers and app identifiers remain separate, even when names match.
- The catalog reads the [named NIP-5D draft](https://github.com/dskvr/nips/blob/c041f84667c1781c3c1d5bfbd970943131b38cc9/5D.md) and the [legacy single-file format](https://github.com/napplet/web/blob/54a1fe6a3dd050e06c4a6081cda9091ea0a23ae7/apps/docs/guide/event-migration.md). Legacy aggregate and HTML hashes keep their distinct meanings. The current admission profile requires a nonempty exact identifier of at most 255 UTF-8 bytes.
- Open uses NAP-LINK with the exact signed publication’s `nostr:naddr` address. The shell chooses how to present the publication. An accepted handoff does not confirm installation, execution, or the revision opened. A listing remains browsable if the shell lacks Link or denies Nostr links.
- Access details show publisher declarations. Capability and format checks for another napplet belong to the shell. Home pinning also belongs to the shell.
- Community recommendations come from verified public lists. For referenced publications outside the loaded feed, Discover checks up to eight distinct addresses per refresh using standard Relay. Each filter names one publisher and exact app identifier. Verified results appear in Recommended while Recent keeps its own paging order. When NAP-LISTS supports address items in kind 30267 sets, the user can ask their shell to add a public recommendation to the `napplets` set. The shell owns the account, preservation of existing entries and publication.
- Media tries up to four validated HTTPS server origins from the signed publication through the host’s existing Resource proxy, then its configured Blossom download origins. Publisher hints do not change the host’s Blossom settings or destination policy. The guest checks SHA-256, byte size, static image format and dimensions before decoding and displaying a Blob image. Unavailable media leaves the listing intact.

## Coverage

The first page opens one standard Relay subscription for early signed rows and a one-shot query for the full selected relay set. It verifies each preview against the same filter, signature and revision rules as a completed page. The one-shot query determines ordering and the paging cursor. Each page shares a 5.5-second deadline across calls. Only a demonstrated response-size limit retries a smaller page. The preview closes when the read settles or its deadline expires. A signed preview that outlasts the query remains visible with partial coverage.

The initial window starts at refresh time. Load more queries progressively older publications, with up to 20 successful queries per window and bounds of 250 signed events and 4 MiB of verified metadata. The catalog reports a gap if a timestamp boundary saturates the relay limit. When offered, standard Outbox queries report incomplete coverage. Load more retries an incomplete window once before continuing with reachable results. Standard Relay queries can omit unreachable relays without reporting which relays responded. Neither path provides independent cursors for each configured relay.

Search covers loaded titles, descriptions, topics, identifiers and fetched publisher names. It accepts exact signing keys, npubs, named addresses and event IDs. Profile reads prioritize the first 12 matching rows and the detail selection. Search also looks up publisher names for up to 24 loaded rows, within a session-wide limit of 48 publishers. Games, Tools and Creative use signed `t` tags. All also includes publications with unrecognized or missing topics.

Verified results stay in memory for this guest session. A failed refresh marks the last results stale and pauses Open until refresh succeeds. A bounded revision record prevents older versions seen on partial relays from replacing versions already observed in this session. The directory does not track NIP-09 deletions, so it has no durable offline index. Release acceptance on Android and iOS requires a separate Hypergolic run.
