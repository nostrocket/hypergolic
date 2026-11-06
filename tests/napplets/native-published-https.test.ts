import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { MAX_HTML_BYTES } from '../../src/napplets/artifact-limits.ts';
import { createNativePublishedArtifactHttpsFetch, createNativePublishedHttpsFetch, type NativePublishedArtifactHttpsPort, decodeNativePublishedBody, type NativePublishedHttpsPort } from '../../src/napplets/native-published-https.ts';
import { createNativePublishedArtifactSource, type BoundedFetchInit } from '../../src/napplets/published-source.ts';

const ID = 'd2398c45-e6db-48a4-ab51-e83828f0eb91';
const init = (signal: AbortSignal): BoundedFetchInit => ({ method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store', signal });

test('accepts canonical binary Base64 and rejects malformed or oversized native results', () => {
  assert.deepEqual([...decodeNativePublishedBody('AAECA/7/')], [0, 1, 2, 3, 254, 255]);
  assert.deepEqual([...decodeNativePublishedBody('YQ==')], [97]);
  assert.deepEqual([...decodeNativePublishedBody('YWI=')], [97, 98]);
  for (const body of ['', 'YQ=', 'YR==', 'YWL=', 'YQ=A', 'YQ==\n', 'YQ==YQ==', '!!!!', 'A'.repeat(2_796_208), null]) {
    assert.throws(() => decodeNativePublishedBody(body));
  }
});

test('returns bounded native bytes to the published source as a 200 response', async () => {
  const calls: string[] = [];
  const port: NativePublishedHttpsPort = {
    newInstanceId: () => ID,
    async fetchPublishedHttps(operationId, url) {
      calls.push(`${operationId} ${url}`);
      return 'AAECA/7/';
    },
    cancelPublishedHttps() { assert.fail('unexpected cancellation'); },
    revokeAllPublishedHttps() {},
  };
  const response = await createNativePublishedHttpsFetch(port)('https://blossom.example.org/abc', init(new AbortController().signal));
  assert.deepEqual(calls, [`${ID} https://blossom.example.org/abc`]);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), '6');
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0, 1, 2, 3, 254, 255]);
});

test('native bounded bytes reach the shared hash reader without a streamed Response body', async () => {
  const html = new TextEncoder().encode('<!doctype html><title>Bounded native body</title>');
  const hash = createHash('sha256').update(html).digest('hex');
  const port: NativePublishedHttpsPort = {
    newInstanceId: () => ID,
    async fetchPublishedHttps() { return Buffer.from(html).toString('base64'); },
    cancelPublishedHttps() {}, revokeAllPublishedHttps() {},
  };
  const OriginalResponse = globalThis.Response;
  class NoStreamResponse extends OriginalResponse { override get body(): null { return null; } }
  globalThis.Response = NoStreamResponse;
  try {
    const source = createNativePublishedArtifactSource({
      relayLookup: { query: async () => [] }, fetchPublicHttps: createNativePublishedHttpsFetch(port),
    });
    const hints = ['https://blossom.example.org/'];
    assert.deepEqual(await source.readHtml(hash, hints, html.byteLength, new AbortController().signal), html);
    await assert.rejects(source.readHtml(hash, hints, html.byteLength - 1, new AbortController().signal));
  } finally { globalThis.Response = OriginalResponse; }
});

test('abort cancels the pending native request and a late result stays rejected', async () => {
  const controller = new AbortController();
  let resolveNative: ((value: string) => void) | undefined;
  const cancelled: string[] = [];
  const port: NativePublishedHttpsPort = {
    newInstanceId: () => ID,
    fetchPublishedHttps: () => new Promise(resolve => { resolveNative = resolve; }),
    cancelPublishedHttps: operationId => { cancelled.push(operationId); },
    revokeAllPublishedHttps() {},
  };
  const pending = createNativePublishedHttpsFetch(port)('https://blossom.example.org/a', init(controller.signal));
  controller.abort();
  assert.deepEqual(cancelled, [ID]);
  resolveNative!('YQ==');
  await assert.rejects(pending, { name: 'PublishedNativeHttpsError' });
  await assert.rejects(createNativePublishedHttpsFetch(port)('https://blossom.example.org/a', init(controller.signal)));
});

test('invalid operation identity and request semantics never call native fetch', async () => {
  let called = false;
  const port: NativePublishedHttpsPort = {
    newInstanceId: () => 'invalid',
    async fetchPublishedHttps() { called = true; return 'YQ=='; },
    cancelPublishedHttps() {}, revokeAllPublishedHttps() {},
  };
  await assert.rejects(createNativePublishedHttpsFetch(port)('https://blossom.example.org/a', init(new AbortController().signal)));
  assert.equal(called, false);
  await assert.rejects(createNativePublishedHttpsFetch({ ...port, newInstanceId: () => ID })('https://blossom.example.org/a', {
    ...init(new AbortController().signal), redirect: 'follow',
  } as unknown as BoundedFetchInit));
  assert.equal(called, false);
});

test('artifact chunk reader verifies and copies 20 MiB without widening avatar Base64', async () => {
  const chunkSize = 48 * 1024;
  const length = 20 * 1024 * 1024;
  assert.equal(MAX_HTML_BYTES, length);
  const url = 'https://blossom.example.org/' + 'a'.repeat(64);
  const expected = Buffer.alloc(length, 0x71);
  let nextOffset = 0;
  const port: NativePublishedArtifactHttpsPort = {
    newInstanceId: () => ID,
    async fetchPublishedArtifactHttps(id, target) {
      assert.equal(id, ID);
      assert.equal(target, url);
      return length;
    },
    readPublishedArtifactHttpsChunk(id, offset) {
      assert.equal(id, ID);
      assert.equal(offset, nextOffset);
      nextOffset += chunkSize;
      return expected.subarray(offset, offset + chunkSize).toString('base64');
    },
    cancelPublishedHttps() { assert.fail('unexpected cancellation'); },
  };
  const response = await createNativePublishedArtifactHttpsFetch(port)(url, init(new AbortController().signal));
  assert.equal(response.headers.get('content-length'), String(length));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
  assert.throws(() => decodeNativePublishedBody(expected.subarray(0, 2 * 1024 * 1024 + 1).toString('base64')));
});

test('artifact chunk read rejects invalid length, truncated chunk and revocation, releasing the lease', async () => {
  const url = 'https://blossom.example.org/' + 'a'.repeat(64);
  for (const mode of ['invalid-length', 'truncated', 'aborted']) {
    const controller = new AbortController();
    const cancelled: string[] = [];
    let reads = 0;
    const port: NativePublishedArtifactHttpsPort = {
      newInstanceId: () => ID,
      async fetchPublishedArtifactHttps() {
        return mode === 'invalid-length' ? MAX_HTML_BYTES + 1 : 48 * 1024;
      },
      readPublishedArtifactHttpsChunk() {
        reads++;
        if (mode === 'aborted') controller.abort();
        return mode === 'truncated' ? 'YQ==' : Buffer.alloc(48 * 1024).toString('base64');
      },
      cancelPublishedHttps(id) { cancelled.push(id); },
    };
    await assert.rejects(createNativePublishedArtifactHttpsFetch(port)(url, init(controller.signal)));
    assert.equal(reads, mode === 'invalid-length' ? 0 : 1);
    assert.ok(cancelled.length > 0 && cancelled.every(id => id === ID));
  }
});

const ARTIFACT_ORIGIN = 'https://blossom.example.org/';
const CHUNK_BYTES = 48 * 1024;
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

function artifactSource(port: NativePublishedArtifactHttpsPort) {
  return createNativePublishedArtifactSource({
    relayLookup: { query: async () => [] }, fetchPublicHttps: createNativePublishedArtifactHttpsFetch(port),
  });
}

test('native HTTPS completion near its network deadline leaves time to claim all artifact bytes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const bytes = Buffer.alloc(19_067_455, 0x61);
  const hash = createHash('sha256').update(bytes).digest('hex');
  let reads = 0;
  const source = artifactSource({
    newInstanceId: () => ID,
    fetchPublishedArtifactHttps(id, url) {
      assert.equal(id, ID);
      assert.equal(url, ARTIFACT_ORIGIN + hash);
      return new Promise(resolve => setTimeout(() => resolve(bytes.length), 14_999));
    },
    readPublishedArtifactHttpsChunk(id, offset) {
      assert.equal(id, ID);
      assert.equal(offset, reads++ * CHUNK_BYTES);
      return bytes.subarray(offset, offset + CHUNK_BYTES).toString('base64');
    },
    cancelPublishedHttps() { assert.fail('unexpected cancellation'); },
  });
  const pending = source.readHtml(hash, [ARTIFACT_ORIGIN], MAX_HTML_BYTES, new AbortController().signal);
  const outcome = pending.then(body => ({ body }), error => ({ error }));
  t.mock.timers.tick(14_999);
  await nextTurn();
  assert.equal(reads, 4);
  for (let i = 0; i < 97; i++) {
    t.mock.timers.tick(1);
    await nextTurn();
  }
  assert.equal(reads, 388);
  assert.deepEqual(await outcome, { body: new Uint8Array(bytes) });
});

test('parent cancellation between chunk batches stops transfer and does not try another origin', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  const cancelled: string[] = [];
  let attempts = 0;
  let reads = 0;
  const chunk = Buffer.alloc(CHUNK_BYTES).toString('base64');
  const source = artifactSource({
    newInstanceId: () => ID,
    async fetchPublishedArtifactHttps() { attempts++; return 5 * CHUNK_BYTES; },
    readPublishedArtifactHttpsChunk() { reads++; return chunk; },
    cancelPublishedHttps(id) { cancelled.push(id); },
  });
  const rejected = assert.rejects(source.readHtml('a'.repeat(64),
    [ARTIFACT_ORIGIN, 'https://another.example.org/'], MAX_HTML_BYTES, controller.signal));
  await nextTurn();
  assert.equal(reads, 4);
  controller.abort();
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(reads, 4);
  assert.equal(attempts, 1);
  assert.deepEqual(cancelled, [ID]);
});

test('native watchdog settles a stalled bridge and ignores its late completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cancelled: string[] = [];
  let resolveNative: (length: number) => void = () => assert.fail('native request did not start');
  let reads = 0;
  const source = artifactSource({
    newInstanceId: () => ID,
    fetchPublishedArtifactHttps() { return new Promise(resolve => { resolveNative = resolve; }); },
    readPublishedArtifactHttpsChunk() { reads++; return 'YQ=='; },
    cancelPublishedHttps(id) { cancelled.push(id); },
  });
  const rejected = assert.rejects(source.readHtml('a'.repeat(64),
    [ARTIFACT_ORIGIN], MAX_HTML_BYTES, new AbortController().signal));
  t.mock.timers.tick(29_999);
  assert.deepEqual(cancelled, []);
  t.mock.timers.tick(1);
  await rejected;
  assert.deepEqual(cancelled, [ID]);
  resolveNative(1);
  await nextTurn();
  assert.equal(reads, 0);
});
