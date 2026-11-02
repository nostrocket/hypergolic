import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublishedUpdateFixtureSource } from '../native/published-update-fixtures/source.ts';
import { EMBEDDED_UPDATE_NADDR, EMBEDDED_UPDATE_V1_EVENT, EMBEDDED_UPDATE_V2_EVENT } from '../../src/napplets/embedded-update-fixture.ts';
import { CHANGED_ACCESS_NADDR, CHANGED_ACCESS_V1_EVENT, CHANGED_ACCESS_V2_EVENT } from './fixtures/changed-access-fixture.ts';
import { loadPublishedArtifact } from '../../src/napplets/loader.ts';

const lookupRelays = ['wss://purplepag.es', 'wss://relay.damus.io', 'wss://nos.lol'];
const load = (source: ReturnType<typeof createPublishedUpdateFixtureSource>, address: string) =>
  loadPublishedArtifact(address, { source, lookupRelays, signal: new AbortController().signal, assertActive: () => undefined });

test('both fixture coordinates start at v1 and release v2 independently', async () => {
  const source = createPublishedUpdateFixtureSource(lookupRelays);
  const originalV1 = await load(source, EMBEDDED_UPDATE_NADDR);
  const changedV1 = await load(source, CHANGED_ACCESS_NADDR);
  assert.equal(originalV1.manifest.eventId, EMBEDDED_UPDATE_V1_EVENT.id);
  assert.equal(changedV1.manifest.eventId, CHANGED_ACCESS_V1_EVENT.id);
  assert.deepEqual(originalV1.manifest.requiredDomains, ['theme']);
  assert.deepEqual(changedV1.manifest.requiredDomains, ['theme']);

  source.releaseChangedAccess();
  const changedV2 = await load(source, CHANGED_ACCESS_NADDR);
  const originalStillV1 = await load(source, EMBEDDED_UPDATE_NADDR);
  assert.equal(changedV2.manifest.eventId, CHANGED_ACCESS_V2_EVENT.id);
  assert.deepEqual(changedV2.manifest.requiredDomains, ['theme', 'relay']);
  assert.equal(originalStillV1.manifest.eventId, EMBEDDED_UPDATE_V1_EVENT.id);

  source.releaseUpdate();
  const originalV2 = await load(source, EMBEDDED_UPDATE_NADDR);
  const changedStillV2 = await load(source, CHANGED_ACCESS_NADDR);
  assert.equal(originalV2.manifest.eventId, EMBEDDED_UPDATE_V2_EVENT.id);
  assert.deepEqual(originalV2.manifest.requiredDomains, ['theme']);
  assert.equal(changedStillV2.manifest.eventId, CHANGED_ACCESS_V2_EVENT.id);
});
