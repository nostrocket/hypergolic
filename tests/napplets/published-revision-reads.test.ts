import assert from 'node:assert/strict';
import test from 'node:test';
import { naddrEncode } from 'nostr-tools/nip19';
import { createPublishedRevisionReads } from '../../src/napplets/published-revision-reads.ts';
import { EMBEDDED_TEST_COORDINATE, EMBEDDED_TEST_EVENT, getEmbeddedTestHtmlBytes } from '../../src/napplets/embedded-test-fixture.ts';

const link = naddrEncode(EMBEDDED_TEST_COORDINATE);
const owner = {user: '1'.repeat(64), epoch: 2, assertActive() {}};

test('concurrent resolved revisions share one cache lookup and body, and cancellation belongs to each caller', async t => {
  let cached = 0, downloads = 0, queries = 0;
  const started = Promise.withResolvers<void>(), joined = Promise.withResolvers<void>(), body = Promise.withResolvers<Uint8Array>();
  let transport: AbortSignal | undefined;
  const reader = createPublishedRevisionReads(async () => {cached++; return null;});
  const source = {async query() {queries++; return [EMBEDDED_TEST_EVENT];},
    async readHtml(_hash: string, _origins: readonly string[], _max: number, signal: AbortSignal) {
      downloads++; transport = signal; started.resolve(); return body.promise;
    }};
  const first = new AbortController(), second = new AbortController();
  const load = (signal: AbortSignal, assertActive = () => {}) => reader.load(link,
    {source, signal, assertActive, lookupRelays: ['wss://relay.example.org']}, owner);
  const one = load(first.signal);
  await started.promise;
  // The second caller independently verifies the selected manifest before joining its body read.
  const listen = second.signal.addEventListener.bind(second.signal);
  t.mock.method(second.signal, 'addEventListener', (...args: Parameters<AbortSignal['addEventListener']>) => {
    listen(...args); joined.resolve();
  });
  const two = load(second.signal);
  await joined.promise;
  first.abort();
  await assert.rejects(one);
  assert.equal(transport?.aborted, false);
  body.resolve(getEmbeddedTestHtmlBytes());
  assert.equal((await two).manifest.eventId, EMBEDDED_TEST_EVENT.id);
  assert.deepEqual([queries, cached, downloads], [2, 1, 1]);
});

test('abandoning every consumer cancels the shared transport; another open starts independently', async () => {
  const started = Promise.withResolvers<void>();
  const reader = createPublishedRevisionReads(async () => null);
  let downloads = 0, cancelled = false;
  const source = {async query() {return [EMBEDDED_TEST_EVENT];},
    async readHtml(_hash: string, _origins: readonly string[], _max: number, signal: AbortSignal) {
      if (++downloads > 1) return getEmbeddedTestHtmlBytes();
      started.resolve();
      return new Promise<Uint8Array>((_resolve, reject) => signal.addEventListener('abort', () => {
        cancelled = true; reject(Error('abandoned'));
      }));
    }};
  const load = (signal: AbortSignal) => reader.load(link, {source, signal, assertActive() {}, lookupRelays: ['wss://relay.example.org']}, owner);
  const controller = new AbortController(), abandoned = load(controller.signal);
  await started.promise;
  controller.abort();
  await assert.rejects(abandoned);
  assert.equal(cancelled, true);
  assert.equal((await load(new AbortController().signal)).manifest.eventId, EMBEDDED_TEST_EVENT.id);
  assert.equal(downloads, 2);
});
