import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createNativePublishedHttpsFetch, decodeNativePublishedBody, type NativePublishedHttpsPort } from '../../src/napplets/native-published-https.ts';
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
