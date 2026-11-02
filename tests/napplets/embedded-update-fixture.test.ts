import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyEvent } from 'nostr-tools/pure';
import {
  EMBEDDED_UPDATE_COORDINATE,
  EMBEDDED_UPDATE_IDENTIFIER,
  EMBEDDED_UPDATE_PUBLISHER,
  EMBEDDED_UPDATE_V1_EVENT,
  EMBEDDED_UPDATE_V1_HTML,
  EMBEDDED_UPDATE_V2_EVENT,
  EMBEDDED_UPDATE_V2_HTML,
  getEmbeddedUpdateV1HtmlBytes,
  getEmbeddedUpdateV2HtmlBytes,
  loadEmbeddedUpdateFixtures,
} from '../../src/napplets/embedded-update-fixture.ts';
import { verifyArtifact, verifyManifest } from '../../src/napplets/verified-artifact.ts';

test('signed update fixtures verify as two ordered versions for one public coordinate', async () => {
  assert.equal(EMBEDDED_UPDATE_V1_EVENT.pubkey, EMBEDDED_UPDATE_PUBLISHER);
  assert.equal(EMBEDDED_UPDATE_V2_EVENT.pubkey, EMBEDDED_UPDATE_PUBLISHER);
  assert.equal(EMBEDDED_UPDATE_V1_EVENT.kind, 35129);
  assert.equal(EMBEDDED_UPDATE_V2_EVENT.kind, 35129);
  assert.equal(EMBEDDED_UPDATE_V1_EVENT.created_at < EMBEDDED_UPDATE_V2_EVENT.created_at, true);
  assert.equal(EMBEDDED_UPDATE_V1_EVENT.tags.find(tag => tag[0] === 'd')?.[1], EMBEDDED_UPDATE_IDENTIFIER);
  assert.equal(EMBEDDED_UPDATE_V2_EVENT.tags.find(tag => tag[0] === 'd')?.[1], EMBEDDED_UPDATE_IDENTIFIER);
  assert.equal(verifyEvent({ ...EMBEDDED_UPDATE_V1_EVENT, tags: EMBEDDED_UPDATE_V1_EVENT.tags.map(tag => [...tag]) }), true);
  assert.equal(verifyEvent({ ...EMBEDDED_UPDATE_V2_EVENT, tags: EMBEDDED_UPDATE_V2_EVENT.tags.map(tag => [...tag]) }), true);

  const loaded = await loadEmbeddedUpdateFixtures();
  assert.equal(loaded.v1.manifest.pubkey, EMBEDDED_UPDATE_PUBLISHER);
  assert.equal(loaded.v1.manifest.created_at, EMBEDDED_UPDATE_V1_EVENT.created_at);
  assert.equal(loaded.v2.manifest.created_at, EMBEDDED_UPDATE_V2_EVENT.created_at);
  assert.deepEqual(loaded.v1.manifest.requiredDomains, ['theme']);
  assert.deepEqual(loaded.v2.manifest.requiredDomains, ['theme']);
  assert.equal(loaded.v1.manifest.expectedHtmlHash === loaded.v2.manifest.expectedHtmlHash, false);
  assert.equal(loaded.v1.artifact.htmlHash === loaded.v2.artifact.htmlHash, false);
  assert.equal(new TextDecoder().decode(loaded.v1.artifact.htmlBytes), EMBEDDED_UPDATE_V1_HTML);
  assert.equal(new TextDecoder().decode(loaded.v2.artifact.htmlBytes), EMBEDDED_UPDATE_V2_HTML);
  assert.match(EMBEDDED_UPDATE_V1_HTML, /window\.parent\.postMessage\(\{type:"shell\.ready"\},"\*"\)/);
  assert.match(EMBEDDED_UPDATE_V2_HTML, /window\.parent\.postMessage\(\{type:"shell\.ready"\},"\*"\)/);
  assert.match(EMBEDDED_UPDATE_V1_HTML, /id="update-marker">update-v1</);
  assert.match(EMBEDDED_UPDATE_V2_HTML, /id="update-marker">update-v2</);
  assert.equal(Object.isFrozen(EMBEDDED_UPDATE_V1_EVENT), true);
  assert.equal(Object.isFrozen(EMBEDDED_UPDATE_V2_EVENT.tags[0]), true);
  assert.equal(JSON.stringify([EMBEDDED_UPDATE_V1_EVENT, EMBEDDED_UPDATE_V2_EVENT]).includes('secret'), false);
  assert.deepEqual(EMBEDDED_UPDATE_COORDINATE.relayHints, []);
});

test('signature, manifest tags and artifact bytes reject tampering', async () => {
  const alteredEvent = { ...EMBEDDED_UPDATE_V2_EVENT, tags: EMBEDDED_UPDATE_V2_EVENT.tags.map(tag => [...tag]) };
  alteredEvent.tags[0]![1] = 'another-identifier';
  await assert.rejects(verifyManifest(EMBEDDED_UPDATE_COORDINATE, alteredEvent));

  const unsignedAltered = { ...EMBEDDED_UPDATE_V2_EVENT, content: 'tampered', tags: EMBEDDED_UPDATE_V2_EVENT.tags.map(tag => [...tag]) };
  await assert.rejects(verifyManifest(EMBEDDED_UPDATE_COORDINATE, unsignedAltered));

  const manifest = await verifyManifest(EMBEDDED_UPDATE_COORDINATE, EMBEDDED_UPDATE_V1_EVENT);
  const modifiedBytes = getEmbeddedUpdateV1HtmlBytes();
  modifiedBytes[modifiedBytes.length - 1] ^= 1;
  await assert.rejects(verifyArtifact(manifest, modifiedBytes));
  const copied = getEmbeddedUpdateV2HtmlBytes();
  copied.fill(0);
  assert.equal(new TextDecoder().decode(getEmbeddedUpdateV2HtmlBytes()), EMBEDDED_UPDATE_V2_HTML);
});
