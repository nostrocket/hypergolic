import assert from 'node:assert/strict';
import test from 'node:test';
import { createEmbeddedUpdateSource, EMBEDDED_UPDATE_ADDRESS } from '../../src/napplets/embedded-update-source.ts';
import { EMBEDDED_UPDATE_COORDINATE, EMBEDDED_UPDATE_V1_EVENT, EMBEDDED_UPDATE_V2_EVENT,
  getEmbeddedUpdateV1HtmlBytes } from '../../src/napplets/embedded-update-fixture.ts';
import { loadPublishedArtifact, MAX_NAPPLET_HTML_BYTES } from '../../src/napplets/loader.ts';

const lookupRelays = ['wss://purplepag.es', 'wss://relay.damus.io', 'wss://nos.lol'];
const options = (source: ReturnType<typeof createEmbeddedUpdateSource>) => ({ source,
  lookupRelays, signal: new AbortController().signal, assertActive: () => undefined });

test('isolated source keeps the old signed revision until explicitly released', async () => {
  const source = createEmbeddedUpdateSource(lookupRelays);
  const first = await loadPublishedArtifact(EMBEDDED_UPDATE_ADDRESS, options(source));
  assert.equal(first.manifest.eventId, EMBEDDED_UPDATE_V1_EVENT.id);
  const oldHash = EMBEDDED_UPDATE_V1_EVENT.tags.find(tag => tag[0] === 'path')![2]!;
  assert.deepEqual(await source.readHtml(oldHash, [], MAX_NAPPLET_HTML_BYTES, new AbortController().signal), getEmbeddedUpdateV1HtmlBytes());
  const pinned = await loadPublishedArtifact(EMBEDDED_UPDATE_ADDRESS, { ...options(source), pinnedEventId: EMBEDDED_UPDATE_V1_EVENT.id });
  assert.equal(pinned.manifest.eventId, first.manifest.eventId);
  source.release();
  const update = await loadPublishedArtifact(EMBEDDED_UPDATE_ADDRESS, options(source));
  assert.equal(update.manifest.eventId, EMBEDDED_UPDATE_V2_EVENT.id);
  assert.equal(update.manifest.created_at > first.manifest.created_at, true);
  const stillPinned = await loadPublishedArtifact(EMBEDDED_UPDATE_ADDRESS, { ...options(source), pinnedEventId: EMBEDDED_UPDATE_V1_EVENT.id });
  assert.equal(stillPinned.manifest.eventId, EMBEDDED_UPDATE_V1_EVENT.id);
});

test('isolated source rejects other coordinates, unknown pins, and invalid blobs', async () => {
  const source = createEmbeddedUpdateSource(lookupRelays);
  const signal = new AbortController().signal;
  await assert.rejects(source.query({ ...EMBEDDED_UPDATE_COORDINATE, identifier: 'other' }, lookupRelays, null, signal));
  await assert.rejects(source.query(EMBEDDED_UPDATE_COORDINATE, lookupRelays, '0'.repeat(64), signal));
  await assert.rejects(source.readHtml('0'.repeat(64), [], MAX_NAPPLET_HTML_BYTES, signal));
  const oldHash = EMBEDDED_UPDATE_V1_EVENT.tags.find(tag => tag[0] === 'path')![2]!;
  await assert.rejects(source.readHtml(oldHash, ['https://example.com/'], MAX_NAPPLET_HTML_BYTES, signal));
  await assert.rejects(source.readHtml(oldHash, [], 1, signal));
});
