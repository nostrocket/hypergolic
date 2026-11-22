import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode } from 'nostr-tools/nip19';
import { KIND, parsePublication, parseProfile, verifySignedEvent, matchesSearch, MAX_FUTURE_SKEW } from '../src/catalog.ts';
import { CatalogPager, RevisionHistory } from '../src/pager.ts';
import { clock, manifest, profile, artifactHash } from './fixtures.ts';

const window = { kinds: [KIND], until: clock };
const verified = (raw: unknown) => verifySignedEvent(raw, window, clock);
const decodeApp = (raw: unknown) => {
  const result = verified(raw);
  return result && parsePublication(result);
};
const asResults = (...events: unknown[]) => events.map(event => ({ event }));

test('verifies a fresh event hash and Schnorr signature, ignoring verification cache', () => {
  const event = manifest();
  assert.ok(verified(event));
  const changed = { ...event, content: 'fake' };
  assert.equal(verified(changed), undefined);
  const badSignature = { ...event, sig: '0'.repeat(128) };
  assert.equal(verified(badSignature), undefined);
  assert.equal(verified({ ...event, id: '9'.repeat(64) }), undefined);
  assert.equal(verifySignedEvent(event, { kinds: [0] }, clock), undefined);
  assert.equal(verifySignedEvent(event, { authors: ['0'.repeat(64)] }, clock), undefined);
  assert.equal(verified(manifest({ timestamp: clock + 1 })), undefined);
  assert.equal(verifySignedEvent(manifest({ timestamp: clock + MAX_FUTURE_SKEW + 1 }), {}, clock), undefined);
  assert.equal(verified(manifest({ description: 'λ'.repeat(34000) })), undefined);
});

test('recognizes distinct modern and legacy meanings and preserves exact UTF-8 addresses', () => {
  const modern = decodeApp(manifest({ d: 'Légo / Build', extra: [['R', 'relay'], ['O', 'unknown-domain'], ['t', 'Games']] }));
  const legacy = decodeApp(manifest({ format: 'legacy', extra: [['requires', 'storage'], ['i', 'legacy-intent']] }));
  assert.ok(modern && legacy);
  assert.equal(modern.format, 'nip-5d');
  assert.equal(modern.artifactHash, artifactHash);
  assert.deepEqual(modern.categories, ['Games']);
  assert.deepEqual(modern.required, ['relay']);
  assert.deepEqual(modern.optional, ['unknown-domain']);
  assert.deepEqual(legacy.required, ['storage']);
  assert.equal(legacy.artifactHash, artifactHash);
  assert.deepEqual(legacy.optional, []);
  assert.equal(legacy.format, 'legacy');
  assert.deepEqual(decode(modern.address), {
    type: 'naddr',
    data: { kind: KIND, identifier: 'Légo / Build', pubkey: modern.publisher, relays: [] },
  });
});

test('rejects ambiguous formats, broken hashes and malformed capability lists', () => {
  const cases = [
    manifest({ d: '' }),
    manifest({ d: ' trimmed ' }),
    manifest({ d: 'new\nline' }),
    manifest({ extra: [['server', 'http://blossom.example.org']] }),
    manifest({ extra: [['server', 'https://blossom.example.org'], ['server', 'https://blossom.example.org/']] }),
    manifest({ d: 'é'.repeat(128) }),
    manifest({ description: '  ' }),
    manifest({ extra: [['requires', 'relay']] }),
    manifest({ extra: [['R', 'relay'], ['O', 'relay']] }),
    manifest({ extra: [['R', 'relay'], ['R', 'relay']] }),
    manifest({ extra: [['O', 'Relay']] }),
    manifest({ extra: [['x', artifactHash]] }),
    manifest({ extra: [['a', 'forbidden-lineage-on-named']] }),
    manifest({ format: 'legacy', extra: [['O', 'theme']] }),
    manifest({ format: 'legacy', extra: [['path', '/extra.js', artifactHash]] }),
    manifest({ format: 'legacy', extra: [['x', artifactHash, 'aggregate']] }),
  ];
  for (const event of cases) assert.equal(decodeApp(event), undefined, event.id);
});

test('ignores optional malformed media while retaining independent valid signed screenshots', () => {
  const imageHash = 'b'.repeat(64);
  const app = decodeApp(manifest({ extra: [
    ['icon', imageHash, 'image/svg+xml'],
    ['screenshot', `x ${imageHash}`, `x ${imageHash}`],
    ['screenshot', 'alt Board <on the right>', 'm image/png', `x ${imageHash}`],
    ['screenshot', `x ${imageHash}`, 'm image/svg+xml'],
    ['screenshot', `x ${imageHash}`, 'm video/mp4'],
    ['screenshot', `x ${imageHash}`, 'm video/mp4; codecs="avc1"'],
  ] }));
  assert.equal(app?.icon, undefined);
  assert.deepEqual(app?.screenshots, [{ hash: imageHash, mime: 'image/png', alt: 'Board <on the right>' }]);
});

test('uses same-author verified profiles and searches literal names, exact keys and addresses', () => {
  const app = decodeApp(manifest({ title: 'Grid Game', extra: [['t', 'simulation']] }))!;
  const raw = profile(1, clock - 1, '{"display_name":"Delta Lab","about":"<script>ignored as markup</script>"}');
  const signed = verifySignedEvent(raw, { kinds: [0], authors: [app.publisher] }, clock);
  assert.ok(signed);
  const publisher = parseProfile(signed);
  assert.equal(publisher?.about, '<script>ignored as markup</script>');
  assert.equal(verifySignedEvent(profile(2, clock - 1, raw.content), { authors: [app.publisher] }, clock), undefined);
  for (const query of ['GRID', 'game board', 'simulation', 'DELTA LAB', app.npub, app.publisher, `nostr:${app.address}`]) {
    assert.ok(matchesSearch(app, query, publisher), query);
  }
  assert.equal(matchesSearch(app, app.publisher.slice(0, 9), publisher), false);
});

test('deduplicates relay copies and revisions while keeping publishers and exact d separate', async () => {
  const older = manifest({ format: 'legacy', timestamp: clock - 20 });
  const newest = manifest({ title: 'Revision', timestamp: clock - 3 });
  const tie = manifest({ title: 'Other revision', timestamp: clock - 3 });
  const another = manifest({ publisher: 2, timestamp: clock - 1 });
  const caseDiffers = manifest({ d: 'Shared', timestamp: clock - 2 });
  const pager = new CatalogPager(async () => asResults(older, newest, newest, tie, another, caseDiffers), () => clock);
  await pager.more();
  assert.deepEqual(pager.entries.map(({ publication }) => publication.signed.event.id),
    [another.id, caseDiffers.id, [newest.id, tie.id].sort()[0]]);
  assert.equal(pager.entries[2]?.conflict, true);
});

test('keeps a high-water mark across refresh and detects ties split across relay reads', async () => {
  const older = manifest({ format: 'legacy', timestamp: clock - 20 });
  const newest = manifest({ title: 'Revision', timestamp: clock - 3 });
  const tie = manifest({ title: 'Other revision', timestamp: clock - 3 });
  const history = new RevisionHistory();
  const load = async (...events: unknown[]) => {
    const pager = new CatalogPager(async () => asResults(...events), () => clock, history);
    await pager.more();
    return pager;
  };
  assert.equal((await load(newest)).entries[0]?.conflict, false);
  const refresh = await load(older);
  assert.equal(refresh.withheld, true);
  assert.equal(refresh.entries.length, 0);
  assert.equal((await load(tie)).entries[0]?.conflict, true);
  assert.equal((await load(newest)).entries[0]?.conflict, true);
});

test('uses an inclusive cursor, widens a saturated boundary, then exposes the history gap', async () => {
  const boundary = clock - 5;
  const tied = Array.from({ length: 34 }, (_, index) => manifest({ timestamp: boundary, d: `t-${index}` }))
    .sort((a, b) => a.id < b.id ? -1 : 1);
  const older = manifest({ timestamp: boundary - 2, d: 'older' });
  const requests: { until?: number; since?: number; limit?: number }[] = [];
  const pager = new CatalogPager(async ([filter]) => {
    requests.push({ until: filter?.until, since: filter?.since, limit: filter?.limit });
    return asResults(...[...tied, older]
      .filter(event => event.created_at <= filter!.until! && event.created_at >= (filter!.since ?? 0))
      .slice(0, filter!.limit));
  }, () => clock);
  await pager.more();
  assert.equal(pager.entries.length, 8);
  await pager.more();
  assert.equal(pager.entries.length, 32);
  assert.equal(pager.gap, true);
  await pager.more();
  assert.equal(pager.entries.length, 33);
  assert.equal(pager.done, true);
  assert.deepEqual(requests, [
    { until: clock, since: undefined, limit: 8 },
    { until: boundary, since: undefined, limit: 8 },
    { until: boundary, since: boundary, limit: 32 },
    { until: boundary - 1, since: undefined, limit: 8 },
  ]);
});

test('backs off bounded reads, retains entries when older history fails and distinguishes valid empty', async () => {
  let call = 0;
  const result = Array.from({ length: 4 }, (_, index) => manifest({ d: `e-${index}`, timestamp: clock - index - 1 }));
  const pager = new CatalogPager(async ([filter]) => {
    call++;
    if (call === 1) return Array.from({length: 33}, () => ({}));
    if (filter?.limit === 4 && call === 2) return asResults(...result);
    throw new Error('Relay timeout');
  }, () => clock);
  await pager.more();
  assert.equal(pager.reduced, true);
  assert.equal(pager.entries.length, 4);
  await assert.rejects(() => pager.more());
  assert.equal(pager.entries.length, 4);
  assert.equal(pager.done, false);
  assert.equal(call, 3); // A transport failure never triggers a smaller request.
  const empty = new CatalogPager(async () => [], () => clock);
  await empty.more();
  assert.equal(empty.entries.length, 0);
  assert.equal(empty.done, true);
});

test('retries partial Outbox coverage at the same cursor without losing verified rows', async () => {
  const first = manifest({d: 'first', timestamp: clock - 20});
  const recovered = manifest({d: 'recovered', timestamp: clock - 10});
  const windows: unknown[] = [];
  const pager = new CatalogPager(async filters => {
    windows.push(filters);
    return windows.length === 1
      ? {events: asResults(first), incomplete: true}
      : {events: asResults(recovered, first)};
  }, () => clock);
  await pager.more();
  assert.equal(pager.partial, true);
  assert.equal(pager.done, false);
  await pager.more();
  assert.deepEqual(windows[0], windows[1]);
  assert.equal(pager.partial, false);
  assert.equal(pager.done, true);
  assert.deepEqual(pager.entries.map(entry => entry.publication.identifier), ['recovered', 'first']);
});

test('repeated partial reads end with visible partial coverage instead of retrying forever', async () => {
  const pager = new CatalogPager(async () => ({events: [], incomplete: true}), () => clock);
  await pager.more();
  await pager.more();
  assert.equal(pager.partial, true);
  assert.equal(pager.done, true);
});

test('the first page previews verified matching rows and commits only the final ordered page', async () => {
  const early = manifest({d: 'early', timestamp: clock - 20});
  const newest = manifest({d: 'newest', timestamp: clock - 10});
  let resolve!: (rows: unknown) => void;
  const waiting = new Promise(settle => {resolve = settle;});
  let close = 0, updates = 0;
  let push!: (row: unknown) => void;
  const pager = new CatalogPager(() => waiting, () => clock, undefined, (_filter, receive) => {
    push = receive; return {close() {close++;}};
  });
  const pending = pager.more(() => {updates++;});
  push({event: {...early, content: 'altered'}});
  push({event: early}); push({event: early});
  assert.equal(updates, 1);
  assert.deepEqual(pager.entries.map(row => row.publication.signed.event.id), [early.id]);
  resolve(asResults(newest)); await pending;
  assert.deepEqual(pager.entries.map(row => row.publication.signed.event.id), [newest.id]);
  assert.equal(close, 1);
  push({event: early});
  assert.equal(updates, 1);
});

test('the deadline keeps signed preview rows partial and closes the stream exactly once', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const early = manifest({d: 'early', timestamp: clock - 20});
  let closes = 0, calls = 0;
  const pager = new CatalogPager(async () => {calls++; return new Promise(() => {});}, () => clock,
    undefined, (_filter, receive) => {receive({event: early}); return {close() {closes++;}};});
  const pending = pager.more(() => {});
  t.mock.timers.tick(5500);
  await pending;
  assert.equal(calls,1); assert.equal(closes,1); assert.equal(pager.partial,true);
  assert.equal(pager.entries[0]?.publication.signed.event.id,early.id);
});
