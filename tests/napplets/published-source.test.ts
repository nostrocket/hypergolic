import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { Subject } from 'rxjs';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import type { Event as NostrEvent } from 'nostr-tools/core';
import type { Filter } from 'applesauce-core/helpers/filter';
import type { GroupRequestOptions } from 'applesauce-relay';
import { MAX_MANIFEST_BYTES } from '../../src/napplets/verified-artifact.ts';
import {
  createPublishedArtifactSource, MAX_BLOSSOM_SERVERS, MAX_MANIFESTS_PER_QUERY, MAX_RELAY_FRAME_BYTES,
  type BoundedFetchInit, type PublishedRelayPool, type PublishedSourceOptions,
} from '../../src/napplets/published-source.ts';

const SECRET = new Uint8Array(32); SECRET[31] = 2;
const PUBKEY = getPublicKey(SECRET);
const RELAYS = ['wss://relay.example.org/', 'wss://lookup.example.net'];
const BODY = new TextEncoder().encode('controlled blossom bytes');
const HASH = createHash('sha256').update(BODY).digest('hex');
const EVENT = JSON.parse(JSON.stringify(finalizeEvent({
  kind: 35129, created_at: 1_800_000_000, content: '',
  tags: [['d', 'published-test'], ['path', '/index.html', HASH]],
}, SECRET))) as NostrEvent;

type CapturedRequest = { relays: string[]; filter: Filter; options: GroupRequestOptions };

function unusedPool(): PublishedRelayPool {
  return {
    safeguards: { maxFrameBytes: MAX_RELAY_FRAME_BYTES, pinsPublicAddresses: true },
    request() { throw new Error('unexpected relay query'); }, close() {},
  } as unknown as PublishedRelayPool;
}

function controlledPool() {
  const stream = new Subject<NostrEvent>();
  let request: CapturedRequest | null = null;
  let closed = false;
  const pool = {
    safeguards: { maxFrameBytes: MAX_RELAY_FRAME_BYTES, pinsPublicAddresses: true },
    request(relays: string[], filter: Filter, options: GroupRequestOptions) {
      request = { relays, filter, options };
      return stream;
    },
    close() { closed = true; },
  } as unknown as PublishedRelayPool;
  return { stream, pool, get request() { return request; }, get closed() { return closed; } };
}

test('queries only selected lookup relays with an exact kind, author and d filter', async () => {
  const harness = controlledPool();
  const source = createPublishedArtifactSource({ fetchPublicHttps: async () => new Response(), createRelayPool: () => harness.pool });
  const pending = source.query({ kind: 35129, pubkey: PUBKEY, identifier: 'published-test' }, RELAYS, null, new AbortController().signal);
  assert.deepEqual(harness.request?.relays, ['wss://relay.example.org', 'wss://lookup.example.net']);
  assert.deepEqual(harness.request?.filter, {
    kinds: [35129], authors: [PUBKEY], '#d': ['published-test'], limit: MAX_MANIFESTS_PER_QUERY,
  });
  assert.equal(harness.request?.options.timeout, 10_000);
  assert.equal(harness.request?.options.reconnect, false);
  assert.equal(harness.request?.options.waitForAuth, false);
  assert.equal(harness.request?.options.eventStore, null);
  harness.stream.next(EVENT);
  harness.stream.complete();
  const events = await pending;
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], EVENT);
  assert.equal(harness.closed, true);
});

test('pins exact event id in the relay filter and rejects unselected or duplicate destinations', async () => {
  const harness = controlledPool();
  const source = createPublishedArtifactSource({ fetchPublicHttps: async () => new Response(), createRelayPool: () => harness.pool });
  const pending = source.query({ kind: 35129, pubkey: PUBKEY, identifier: 'published-test' }, RELAYS, EVENT.id, new AbortController().signal);
  assert.deepEqual(harness.request?.filter, {
    kinds: [35129], authors: [PUBKEY], '#d': ['published-test'], limit: MAX_MANIFESTS_PER_QUERY, ids: [EVENT.id],
  });
  assert.equal(typeof harness.request?.options.complete, 'function');
  harness.stream.complete(); await pending;
  await assert.rejects(async () => source.query({ kind: 35129, pubkey: PUBKEY, identifier: 'published-test' }, ['wss://evil.example', 'wss://evil.example'], null, new AbortController().signal));
  await assert.rejects(async () => source.query({ kind: 35129, pubkey: PUBKEY, identifier: 'published-test' }, ['wss://localhost'], null, new AbortController().signal));
});

test('bounds relay result count, event bytes, and tears down subscriptions on abort or timeout', async () => {
  const oversizedHarness = controlledPool();
  const source = createPublishedArtifactSource({ fetchPublicHttps: async () => new Response(), createRelayPool: () => oversizedHarness.pool });
  const tooLarge = JSON.parse(JSON.stringify(finalizeEvent({
    kind: EVENT.kind, created_at: EVENT.created_at, content: 'x'.repeat(MAX_MANIFEST_BYTES), tags: EVENT.tags,
  }, SECRET))) as NostrEvent;
  const oversized = source.query({ kind: 35129, pubkey: PUBKEY, identifier: 'published-test' }, RELAYS, null, new AbortController().signal);
  oversizedHarness.stream.next(JSON.parse(JSON.stringify(tooLarge)));
  await assert.rejects(oversized);
  assert.equal(oversizedHarness.closed, true);

  let hugeTagVisited = 0;
  const hostileTags = new Proxy([] as string[][], { ownKeys() { hugeTagVisited++; throw new Error('oversized tags should not be inspected'); } });
  const hostile = { ...EVENT, content: 'x'.repeat(MAX_MANIFEST_BYTES), tags: hostileTags } as unknown as NostrEvent;
  const earlyHarness = controlledPool();
  const earlySource = createPublishedArtifactSource({ fetchPublicHttps: async () => new Response(), createRelayPool: () => earlyHarness.pool });
  const early = earlySource.query({ kind: 35129, pubkey: PUBKEY, identifier: 'published-test' }, RELAYS, null, new AbortController().signal);
  earlyHarness.stream.next(hostile);
  await assert.rejects(early); assert.equal(hugeTagVisited, 0);

  const giantTag = { ...EVENT, tags: [['d', 'x'.repeat(MAX_MANIFEST_BYTES)]] } as NostrEvent;
  const giantHarness = controlledPool();
  const giantSource = createPublishedArtifactSource({ fetchPublicHttps: async () => new Response(), createRelayPool: () => giantHarness.pool });
  const giant = giantSource.query({ kind: 35129, pubkey: PUBKEY, identifier: 'published-test' }, RELAYS, null, new AbortController().signal);
  giantHarness.stream.next(giantTag);
  await assert.rejects(giant);

  const countHarness = controlledPool();
  const countSource = createPublishedArtifactSource({ fetchPublicHttps: async () => new Response(), createRelayPool: () => countHarness.pool });
  const many = countSource.query({ kind: 35129, pubkey: PUBKEY, identifier: 'published-test' }, RELAYS, null, new AbortController().signal);
  for (let index = 0; index <= MAX_MANIFESTS_PER_QUERY; index++) countHarness.stream.next(EVENT);
  await assert.rejects(many); assert.equal(countHarness.closed, true);

  const abortHarness = controlledPool();
  const abortSource = createPublishedArtifactSource({ fetchPublicHttps: async () => new Response(), createRelayPool: () => abortHarness.pool });
  const controller = new AbortController();
  const aborted = abortSource.query({ kind: 35129, pubkey: PUBKEY, identifier: 'published-test' }, RELAYS, null, controller.signal);
  controller.abort(); await assert.rejects(aborted); assert.equal(abortHarness.closed, true);

  const timeoutHarness = controlledPool();
  const timeoutSource = createPublishedArtifactSource({ fetchPublicHttps: async () => new Response(), createRelayPool: () => timeoutHarness.pool, relayTimeoutMs: 5 });
  await assert.rejects(timeoutSource.query({ kind: 35129, pubkey: PUBKEY, identifier: 'published-test' }, RELAYS, null, new AbortController().signal));
  assert.equal(timeoutHarness.closed, true);
});

test('counts the exact UTF-8 event size with empty tags at the manifest boundary', async () => {
  const base = { ...EVENT, tags: [], content: '' };
  const baseBytes = new TextEncoder().encode(JSON.stringify(base)).byteLength;
  const boundary = { ...base, content: 'x'.repeat(MAX_MANIFEST_BYTES - baseBytes) } as NostrEvent;
  assert.equal(new TextEncoder().encode(JSON.stringify(boundary)).byteLength, MAX_MANIFEST_BYTES);

  const acceptedHarness = controlledPool();
  const acceptedSource = createPublishedArtifactSource({ fetchPublicHttps: async () => new Response(), createRelayPool: () => acceptedHarness.pool });
  const accepted = acceptedSource.query({ kind: 35129, pubkey: PUBKEY, identifier: 'published-test' }, RELAYS, null, new AbortController().signal);
  acceptedHarness.stream.next(boundary);
  acceptedHarness.stream.complete();
  assert.equal((await accepted).length, 1);

  const rejectedHarness = controlledPool();
  const rejectedSource = createPublishedArtifactSource({ fetchPublicHttps: async () => new Response(), createRelayPool: () => rejectedHarness.pool });
  const rejected = rejectedSource.query({ kind: 35129, pubkey: PUBKEY, identifier: 'published-test' }, RELAYS, null, new AbortController().signal);
  rejectedHarness.stream.next({ ...boundary, content: `${boundary.content}x` });
  await assert.rejects(rejected);
});

test('reads exactly the signed SHA-256 path over manual-redirect HTTPS with streamed size limits', async () => {
  const body = BODY;
  let request: { url: string; init: BoundedFetchInit } | null = null;
  const source = createPublishedArtifactSource({
    fetchPublicHttps: async (url, init) => { request = { url, init }; return new Response(body, { status: 200 }); },
    createRelayPool: unusedPool,
  });
  const bytes = await source.readHtml(HASH, ['https://blossom.example.org/'], 128, new AbortController().signal);
  assert.deepEqual(bytes, body);
  assert.equal(request?.url, `https://blossom.example.org/${HASH}`);
  assert.deepEqual({ method: request?.init.method, redirect: request?.init.redirect, credentials: request?.init.credentials, cache: request?.init.cache }, {
    method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store',
  });

  await assert.rejects(source.readHtml('AB'.repeat(32), ['https://blossom.example.org/'], 128, new AbortController().signal));
  await assert.rejects(source.readHtml(HASH, [], 128, new AbortController().signal));
  await assert.rejects(source.readHtml(HASH, Array(MAX_BLOSSOM_SERVERS + 1).fill('https://blossom.example.org/'), 128, new AbortController().signal));
  await assert.rejects(source.readHtml(HASH, ['http://blossom.example.org/'], 128, new AbortController().signal));
});

test('rejects redirects, oversized declared or streamed bodies, and bodies with no enforceable bound', async () => {
  const redirect = createPublishedArtifactSource({ fetchPublicHttps: async () => new Response(null, { status: 302, headers: { location: 'https://other.example.net/' } }), createRelayPool: unusedPool });
  await assert.rejects(redirect.readHtml(HASH, ['https://blossom.example.org/'], 128, new AbortController().signal));

  const declared = createPublishedArtifactSource({ fetchPublicHttps: async () => new Response(new Uint8Array(20), { status: 200, headers: { 'content-length': '20' } }), createRelayPool: unusedPool });
  await assert.rejects(declared.readHtml(HASH, ['https://blossom.example.org/'], 10, new AbortController().signal));

  const streamed = createPublishedArtifactSource({ fetchPublicHttps: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(8)); controller.enqueue(new Uint8Array(8)); controller.close(); },
  }), { status: 200 }), createRelayPool: unusedPool });
  await assert.rejects(streamed.readHtml(HASH, ['https://blossom.example.org/'], 10, new AbortController().signal));

  const unbounded = createPublishedArtifactSource({ fetchPublicHttps: async () => ({
    status: 200, redirected: false, type: 'basic', url: '', headers: new Headers(), body: null,
    async arrayBuffer() { return new ArrayBuffer(1); },
  } as Response), createRelayPool: unusedPool });
  await assert.rejects(unbounded.readHtml(HASH, ['https://blossom.example.org/'], 10, new AbortController().signal));
});

test('tries the next signed server hint after an HTTP failure or content-address mismatch', async () => {
  const attempts: string[] = [];
  const source = createPublishedArtifactSource({ fetchPublicHttps: async url => {
    attempts.push(url);
    if (attempts.length === 1) return new Response('wrong bytes', { status: 200 });
    return new Response(BODY, { status: 200 });
  }, createRelayPool: unusedPool });
  const bytes = await source.readHtml(HASH, ['not a URL', 'https://first.example.org/', 'https://second.example.net/'], 128, new AbortController().signal);
  assert.deepEqual(bytes, BODY);
  assert.deepEqual(attempts, [`https://first.example.org/${HASH}`, `https://second.example.net/${HASH}`]);
});

test('passes cancellation and enforces the Blossom request timeout', async () => {
  let capturedSignal: AbortSignal | undefined;
  const neverFetch = createPublishedArtifactSource({
    blossomTimeoutMs: 5,
    createRelayPool: unusedPool,
    fetchPublicHttps: (_url, init) => new Promise((_resolve, reject) => {
      capturedSignal = init.signal;
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });
  await assert.rejects(neverFetch.readHtml(HASH, ['https://blossom.example.org/'], 10, new AbortController().signal));
  assert.equal(capturedSignal?.aborted, true);

  const controller = new AbortController();
  const aborting = createPublishedArtifactSource({ fetchPublicHttps: (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }), createRelayPool: unusedPool });
  const pending = aborting.readHtml(HASH, ['https://blossom.example.org/'], 10, controller.signal);
  controller.abort();
  await assert.rejects(pending);
});

test('requires a relay port that declares raw-frame bounds and public-IP pinning', async () => {
  const invalidPool = {
    request() { return new Subject<NostrEvent>(); }, close() {},
    safeguards: { maxFrameBytes: Number.POSITIVE_INFINITY, pinsPublicAddresses: true as const },
  } as unknown as PublishedRelayPool;
  const source = createPublishedArtifactSource({ fetchPublicHttps: async () => new Response(), createRelayPool: () => invalidPool });
  await assert.rejects(source.query({ kind: 35129, pubkey: PUBKEY, identifier: 'published-test' }, RELAYS, null, new AbortController().signal));
  assert.throws(() => createPublishedArtifactSource({ fetchPublicHttps: async () => new Response() } as unknown as PublishedSourceOptions));
});
