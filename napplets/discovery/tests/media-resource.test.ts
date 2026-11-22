import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePublication, verifySignedEvent, type Media } from '../src/catalog.ts';
import { loadVerifiedImage } from '../src/media-resource.ts';

const event = JSON.parse(readFileSync(new URL('./media-fixtures/battleship.json', import.meta.url), 'utf8'));
const bytes = readFileSync(new URL('./media-fixtures/battleship.png', import.meta.url));
const signed = verifySignedEvent(event, { kinds: [35129] }, event.created_at + 1)!;
const app = parsePublication(signed)!;
const icon = app.icon!;
const blob = () => new Blob([bytes], { type: 'text/plain' });

test('real signed Battleship media retains its verified publisher mirrors', () => {
  assert.ok(signed);
  assert.equal(app.title, 'Battleship');
  assert.equal(icon.hash, '3c9c0025a017b30af0f0be952c5dec1c9b2584fea65cbbcdcb0b2d5e31befb58');
  assert.deepEqual(icon.servers, ['https://cdn.hzrd149.com', 'https://blossom.ditto.pub']);
  assert.deepEqual(app.screenshots[0]?.servers, icon.servers);
});

test('reads actual Battleship PNG through the Resource proxy and verifies bytes rather than transport MIME', async () => {
  const calls: string[] = [];
  const image = await loadVerifiedImage(icon, new AbortController().signal, async url => {
    calls.push(url);
    assert.equal(url, `https://cdn.hzrd149.com/${icon.hash}`);
    return blob();
  });
  assert.equal(image?.type, 'image/png');
  assert.deepEqual(new Uint8Array(await image!.arrayBuffer()), new Uint8Array(bytes));
  assert.equal(calls.length, 1);
});

test('rejects altered bytes and unavailable mirrors before using the configured Blossom fallback', async () => {
  const calls: string[] = [];
  const image = await loadVerifiedImage(icon, new AbortController().signal, async url => {
    calls.push(url);
    if (url.startsWith('https://cdn.')) {
      const altered = new Uint8Array(bytes); altered[altered.length - 1] ^= 1;
      return new Blob([altered]);
    }
    if (url.startsWith('https:')) throw new Error('Unavailable');
    return blob();
  });
  assert.equal(image?.type, 'image/png');
  assert.deepEqual(calls, [...icon.servers!.map(origin => `${origin}/${icon.hash}`), `blossom:sha256:${icon.hash}`]);
});

test('does not decode wrong MIME, oversized media or untrusted non-image bytes', async () => {
  for (const [media, bad] of [
    [{ ...icon, mime: 'image/jpeg' }, blob()],
    [icon, new Blob([new Uint8Array(768 * 1024 + 1)])],
    [icon, new Blob(['<svg onload="alert(1)"></svg>'])],
  ] as [Media, Blob][]) {
    assert.equal(await loadVerifiedImage(media, new AbortController().signal, async () => bad), undefined);
  }
});

test('cancellation prevents later mirror attempts and late successful results', async () => {
  const control = new AbortController();
  let calls = 0;
  const image = await loadVerifiedImage(icon, control.signal, async (_url, options) => {
    assert.equal(options.signal, control.signal);
    calls++;
    control.abort();
    return blob();
  });
  assert.equal(image, undefined);
  assert.equal(calls, 1);
  assert.equal(await loadVerifiedImage(icon, control.signal, async () => { throw new Error('Must not run'); }), undefined);
});

test('bounds signed-mirror attempts while preserving configured-only listings', async () => {
  const calls: string[] = [];
  await loadVerifiedImage({ ...icon, servers: Array.from({ length: 16 }, (_, i) => `https://mirror${i}.org`) },
    new AbortController().signal, async url => { calls.push(url); throw new Error('Unavailable'); });
  assert.equal(calls.length, 5);
  assert.equal(calls.at(-1), `blossom:sha256:${icon.hash}`);
  const image = await loadVerifiedImage({ ...icon, servers: [] }, new AbortController().signal, async url => {
    assert.equal(url, `blossom:sha256:${icon.hash}`);
    return blob();
  });
  assert.equal(image?.type, 'image/png');
});
