import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { naddrEncode } from 'nostr-tools/nip19';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { loadPublishedArtifact, PublishedLoadError, type PublishedArtifactSource } from '../../src/napplets/loader.ts';
import { createNativePublishedRelayLookup } from '../../src/napplets/native-published-relay.ts';

const secret = Uint8Array.from([...new Uint8Array(31), 2]);
const pubkey = getPublicKey(secret);
const link = naddrEncode({ kind: 35129, pubkey, identifier: 'loader-test' });
const html = new TextEncoder().encode('<!doctype html><html lang="en"><head><title>Loader</title></head><body>loader</body></html>');
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const htmlHash = sha(html);
const aggregateHash = sha(`${htmlHash} /index.html\n`);
const manifest = (created_at: number, tags: string[][] = []) => {
  const signed = finalizeEvent({
  kind: 35129, created_at, content: '', tags: [
    ['d', 'loader-test'], ['path', '/index.html', htmlHash], ['x', aggregateHash, 'aggregate'],
    ['server', 'https://blossom.example.org/'], ...tags,
  ],
  }, secret);
  // Relay wire values have exactly seven data fields; signer verification caches are not wire authority.
  return { id: signed.id, pubkey: signed.pubkey, created_at: signed.created_at, kind: signed.kind,
    tags: signed.tags.map(tag => [...tag]), content: signed.content, sig: signed.sig };
};
const lookupRelays = ['wss://relay.example.org'];
function options(events: readonly unknown[], blob: Uint8Array = html, signal = new AbortController().signal,
  calls: string[] = [], pinnedEventId?: string) {
  const source: PublishedArtifactSource = {
    async query(coordinate, relays, pinned) {
      assert.equal(Object.hasOwn(coordinate, 'relayHints'), false);
      calls.push(`query:${coordinate.identifier}:${relays[0]}:${pinned ?? 'latest'}`);
      return events;
    },
    async readHtml(hash, servers, maxBytes) {
      calls.push(`blob:${hash}:${servers[0]}:${maxBytes}`);
      return blob;
    },
  };
  return { source, lookupRelays, signal, assertActive: () => undefined, ...(pinnedEventId ? { pinnedEventId } : {}) };
}

test('selects newest verified replaceable manifest and pins its exact signed event', async () => {
  const earlier = manifest(1_700_000_001);
  const later = manifest(1_700_000_002);
  const calls: string[] = [];
  const artifact = await loadPublishedArtifact(link, options([earlier, later], html, undefined, calls));
  assert.equal(artifact.manifest.id, later.id);
  assert.equal(artifact.htmlHash, htmlHash);
  assert.equal(artifact.manifest.pubkey, pubkey);
  assert.equal(calls.length, 2);
  const pinned = await loadPublishedArtifact(`nostr:${link}`, options([earlier, later], html, undefined, [], earlier.id));
  assert.equal(pinned.manifest.id, earlier.id);
});

test('a bad selected blob never falls back to an older event', async () => {
  const events = [manifest(1_700_000_001), manifest(1_700_000_002)];
  const calls: string[] = [];
  await assert.rejects(loadPublishedArtifact(link, options(events, new TextEncoder().encode('tampered'), undefined, calls)),
    {code: 'PUBLISHED_HASH_MISMATCH'});
  assert.equal(calls.filter(call => call.startsWith('blob:')).length, 1);
});

test('a pinned event cannot be silently replaced by another valid revision', async () => {
  const pinned = manifest(1_700_000_001);
  const calls: string[] = [];
  await assert.rejects(loadPublishedArtifact(link, options([manifest(1_700_000_002)], html, undefined, calls, pinned.id)), PublishedLoadError);
  assert.equal(calls.filter(call => call.startsWith('blob:')).length, 0);
});

test('revocation after relay response prevents even starting a blob request', async () => {
  const controller = new AbortController();
  let blobRead = false;
  const source: PublishedArtifactSource = {
    async query() { controller.abort(); return [manifest(1_700_000_001)]; },
    async readHtml() { blobRead = true; return html; },
  };
  await assert.rejects(loadPublishedArtifact(link, { source, lookupRelays, signal: controller.signal, assertActive: () => undefined }), PublishedLoadError);
  assert.equal(blobRead, false);
});

test('conflicting signed versions at the same timestamp require an exact pin', async () => {
  const first = manifest(1_700_000_001, [['title', 'First']]);
  const second = manifest(1_700_000_001, [['title', 'Second']]);
  const calls: string[] = [];
  await assert.rejects(loadPublishedArtifact(link, options([first, second], html, undefined, calls)), PublishedLoadError);
  assert.equal(calls.filter(call => call.startsWith('blob:')).length, 0);
});

test('lookup destinations are selected and bounded, never inherited from the link', async () => {
  const source: PublishedArtifactSource = { async query() { throw new Error('should not query'); }, async readHtml() { return html; } };
  await assert.rejects(loadPublishedArtifact(link, { source, lookupRelays: ['ws://relay.example.org'], signal: new AbortController().signal,
    assertActive: () => undefined }), PublishedLoadError);
  await assert.rejects(loadPublishedArtifact(link, { source, lookupRelays: ['wss://localhost'], signal: new AbortController().signal,
    assertActive: () => undefined }), PublishedLoadError);
});

const modern = (created_at: number, tags: string[][] = []) => finalizeEvent({
  kind: 35129, created_at, content: 'Modern named publication',
  tags: [['d', 'loader-test'], ['x', htmlHash], ['server', 'https://blossom.example.org/'], ...tags],
}, secret);

test('discovery binds the latest eligible event across formats before fetching a blob', async () => {
  const old = manifest(1_700_000_001);
  const current = modern(1_700_000_002);
  const calls: string[] = [];
  const input = options([old, current], html, undefined, calls);
  await assert.rejects(loadPublishedArtifact(link, {...input, expectedEventId: old.id}), {code: 'PUBLISHED_REVISION_CHANGED'});
  assert.deepEqual(calls, ['query:loader-test:wss://relay.example.org:latest']);
  const artifact = await loadPublishedArtifact(link, {...input, expectedEventId: current.id});
  assert.equal(artifact.manifest.id, current.id);
  assert.equal(artifact.manifest.format, 'nip-5d');
  assert.equal(artifact.htmlHash, htmlHash);
  assert.match(calls.at(-1)!, new RegExp('^blob:' + htmlHash));
  assert.equal((await loadPublishedArtifact(link, options([old, current], html, undefined, [], old.id))).manifest.id, old.id);
});

test('only exact Discover requests use the normalized union of selected relay roles', async () => {
  const displayed = modern(1_700_000_001);
  const latest = modern(1_700_000_002);
  const shared = 'wss://relay.example.org';
  const networkOnly = 'wss://directory.example.org';
  let blobReads = 0;
  const queries: Array<{ relays: readonly string[]; discovery?: true }> = [];
  const source: PublishedArtifactSource = {
    async query(coordinate, relays, pinned, _signal, discovery) {
      assert.deepEqual(coordinate, { kind: 35129, pubkey, identifier: 'loader-test' });
      assert.equal(pinned, null);
      queries.push({ relays, discovery });
      return relays.includes(networkOnly) ? [displayed, latest] : [];
    },
    async readHtml() { blobReads++; return html; },
  };
  const options = { source, lookupRelays: [shared], signal: new AbortController().signal,
    assertActive: () => undefined };
  const discover = { ...options, networkRelays: ['wss://relay.example.org:443/', networkOnly] };
  await assert.rejects(loadPublishedArtifact(link, options), { code: 'PUBLISHED_NOT_FOUND' });
  await assert.rejects(loadPublishedArtifact(link, discover), { code: 'PUBLISHED_LOAD_FAILED' });
  await assert.rejects(loadPublishedArtifact(link, { ...discover, expectedEventId: displayed.id }),
    { code: 'PUBLISHED_REVISION_CHANGED' });
  assert.equal(blobReads, 0);
  const artifact = await loadPublishedArtifact(link, { ...discover, expectedEventId: latest.id });
  assert.equal(artifact.manifest.id, latest.id);
  assert.equal(blobReads, 1);
  assert.deepEqual(queries, [
    { relays: [shared], discovery: undefined },
    { relays: [shared, networkOnly], discovery: true },
    { relays: [shared, networkOnly], discovery: true },
  ]);
});

test('Discover deadline candidates still need valid signatures and the exact newest event before HTML', async () => {
  const displayed = manifest(1_700_000_001), latest = modern(1_700_000_002);
  const network = 'wss://network.example.org';
  for (const {events, code} of [
    {events: [displayed], code: null},
    {events: [{...displayed, sig: '0'.repeat(128)}], code: 'PUBLISHED_LOAD_FAILED'},
    {events: [displayed, latest], code: 'PUBLISHED_REVISION_CHANGED'},
    {events: [displayed, modern(displayed.created_at)], code: 'PUBLISHED_REVISION_CONFLICT'},
  ]) {
    let blobReads = 0;
    const lookup = createNativePublishedRelayLookup({
      newInstanceId: randomUUID,
      queryPublishedRelay(_id, relay, _wire, sub) {
        return relay === network ? Promise.resolve([
          ...events.map(event => JSON.stringify(['EVENT', sub, event])), JSON.stringify(['EOSE', sub]),
        ]) : new Promise(() => {});
      },
      cancelPublishedRelay() {},
      revokeAllPublishedRelay() {},
    }, 5);
    const operation = loadPublishedArtifact(link, {
      source: {query: lookup.query, async readHtml() {blobReads++; return html;}},
      lookupRelays, networkRelays: [network], signal: new AbortController().signal,
      expectedEventId: displayed.id, assertActive() {},
    });
    if (code) await assert.rejects(operation, {code});
    else assert.equal((await operation).manifest.id, displayed.id);
    assert.equal(blobReads, code ? 0 : 1);
  }
});

test('Discover verifies a revision conflict across an early retry and a late initial reply', async () => {
  const displayed = manifest(1_700_000_001), conflict = modern(displayed.created_at);
  const emptyRelay = 'wss://empty.example.org', retryRelay = 'wss://retry.example.org';
  const frames = (sub: string, event: unknown) => [JSON.stringify(['EVENT', sub, event]), JSON.stringify(['EOSE', sub])];
  let completeInitial: (() => void) | undefined, retryAttempts = 0, blobReads = 0;
  const lookup = createNativePublishedRelayLookup({
    newInstanceId: randomUUID,
    queryPublishedRelay(_id, relay, _wire, sub) {
      if (relay === lookupRelays[0]) return new Promise(resolve => {completeInitial = () => resolve(frames(sub, displayed));});
      if (relay === emptyRelay) return Promise.resolve([JSON.stringify(['EOSE', sub])]);
      if (++retryAttempts === 1) return Promise.reject(Error('busy'));
      completeInitial!();
      return Promise.resolve(frames(sub, conflict));
    },
    cancelPublishedRelay() {},
    revokeAllPublishedRelay() {},
  }, 100);
  await assert.rejects(loadPublishedArtifact(link, {
    source: {query: lookup.query, async readHtml() {blobReads++; return html;}},
    lookupRelays, networkRelays: [emptyRelay, retryRelay], signal: new AbortController().signal,
    expectedEventId: displayed.id, assertActive() {},
  }), {code: 'PUBLISHED_REVISION_CONFLICT'});
  assert.equal(retryAttempts, 2);
  assert.equal(blobReads, 0);
});

test('discovery separates empty results, authentic unsupported manifests and same-time conflicts', async () => {
  const current = modern(1_700_000_001);
  const conflicting = manifest(1_700_000_001);
  const unsupported = modern(1_700_000_002, [['path', '/index.html', htmlHash]]);
  for (const {events, code} of [
    {events: [], code: 'PUBLISHED_NOT_FOUND'},
    {events: [unsupported], code: 'PUBLISHED_UNSUPPORTED_MANIFEST'},
    {events: [{...unsupported, sig: '0'.repeat(128)}], code: 'PUBLISHED_LOAD_FAILED'},
    {events: [current, conflicting], code: 'PUBLISHED_REVISION_CONFLICT'},
  ]) {
    const calls: string[] = [];
    await assert.rejects(loadPublishedArtifact(link, {...options(events, html, undefined, calls), expectedEventId: current.id}), {code});
    assert.equal(calls.length, 1);
  }
});


test('exact opening distinguishes relay failure, download failure and signed invalid HTML', async () => {
  const badHtml = new TextEncoder().encode('<body>Missing the required HTML document envelope</body>');
  const event = finalizeEvent({kind: 35129, created_at: 1_700_000_002, content: 'Invalid HTML',
    tags: [['d', 'loader-test'], ['x', sha(badHtml)], ['server', 'https://blossom.example.org/']]}, secret);
  const input = {...options([event], badHtml), expectedEventId: event.id};
  await assert.rejects(loadPublishedArtifact(link, {...input, source: {
    async query() {throw new Error('a configured relay did not finish');},
    async readHtml() {assert.fail('failed lookup cannot start a download');},
  }}), {code: 'PUBLISHED_LOOKUP_UNAVAILABLE'});
  await assert.rejects(loadPublishedArtifact(link, {...input, source: {...input.source,
    async readHtml() {throw new Error('the published server could not be reached');},
  }}), {code: 'PUBLISHED_DOWNLOAD_UNAVAILABLE'});
  await assert.rejects(loadPublishedArtifact(link, input), {code: 'PUBLISHED_INVALID_HTML'});
});
