import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { verifyEvent, getEventHash } from 'nostr-tools/pure';
import {
  CHANGED_ACCESS_COORDINATE,
  CHANGED_ACCESS_IDENTIFIER,
  CHANGED_ACCESS_NADDR,
  CHANGED_ACCESS_PUBLISHER,
  CHANGED_ACCESS_V1_EVENT,
  CHANGED_ACCESS_V1_HTML,
  CHANGED_ACCESS_V2_EVENT,
  CHANGED_ACCESS_V2_HTML,
  getChangedAccessV1HtmlBytes,
  getChangedAccessV2HtmlBytes,
  loadChangedAccessFixtures,
} from './fixtures/changed-access-fixture.ts';
import { verifyManifest } from '../../src/napplets/verified-artifact.ts';

const sha256 = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex');

test('changed-access revisions are immutable signed updates on one coordinate', async () => {
  const events = [CHANGED_ACCESS_V1_EVENT, CHANGED_ACCESS_V2_EVENT];
  for (const event of events) {
    assert.equal(event.kind, 35129);
    assert.equal(event.pubkey, CHANGED_ACCESS_PUBLISHER);
    assert.equal(getEventHash({ ...event, tags: event.tags.map(tag => [...tag]) }), event.id);
    assert.equal(verifyEvent({ ...event, tags: event.tags.map(tag => [...tag]) }), true);
    assert.equal(event.tags.find(tag => tag[0] === 'd')?.[1], CHANGED_ACCESS_IDENTIFIER);
  }
  assert.ok(CHANGED_ACCESS_V1_EVENT.created_at < CHANGED_ACCESS_V2_EVENT.created_at);
  assert.ok(Object.isFrozen(CHANGED_ACCESS_V1_EVENT));
  assert.ok(Object.isFrozen(CHANGED_ACCESS_V2_EVENT.tags[0]));
  assert.equal(CHANGED_ACCESS_NADDR.startsWith('naddr1'), true);
  assert.deepEqual(CHANGED_ACCESS_COORDINATE.relayHints, []);

  const v1Tags = CHANGED_ACCESS_V1_EVENT.tags.filter(tag => tag[0] === 'requires').map(tag => tag[1]);
  const v2Tags = CHANGED_ACCESS_V2_EVENT.tags.filter(tag => tag[0] === 'requires').map(tag => tag[1]);
  assert.deepEqual(v1Tags, ['theme']);
  assert.deepEqual(v2Tags, ['theme', 'relay']);

  const loaded = await loadChangedAccessFixtures();
  assert.deepEqual(loaded.v1.manifest.requiredDomains, ['theme']);
  assert.deepEqual(loaded.v2.manifest.requiredDomains, ['theme', 'relay']);
  assert.equal(loaded.v1.manifest.eventId, CHANGED_ACCESS_V1_EVENT.id);
  assert.equal(loaded.v2.manifest.eventId, CHANGED_ACCESS_V2_EVENT.id);
  assert.equal(loaded.v1.manifest.created_at < loaded.v2.manifest.created_at, true);
  assert.equal(loaded.v1.manifest.expectedHtmlHash, sha256(CHANGED_ACCESS_V1_HTML));
  assert.equal(loaded.v2.manifest.expectedHtmlHash, sha256(CHANGED_ACCESS_V2_HTML));
  assert.equal(loaded.v1.manifest.aggregateHash, sha256(`${sha256(CHANGED_ACCESS_V1_HTML)} /index.html\n`));
  assert.equal(loaded.v2.manifest.aggregateHash, sha256(`${sha256(CHANGED_ACCESS_V2_HTML)} /index.html\n`));
  assert.equal(new TextDecoder().decode(loaded.v1.artifact.htmlBytes), CHANGED_ACCESS_V1_HTML);
  assert.equal(new TextDecoder().decode(loaded.v2.artifact.htmlBytes), CHANGED_ACCESS_V2_HTML);
  assert.deepEqual(getChangedAccessV1HtmlBytes(), new TextEncoder().encode(CHANGED_ACCESS_V1_HTML));
  assert.deepEqual(getChangedAccessV2HtmlBytes(), new TextEncoder().encode(CHANGED_ACCESS_V2_HTML));
  assert.match(CHANGED_ACCESS_V1_HTML, /window\.parent\.postMessage\(\{type:"shell\.ready"\},"\*"\)/);
  assert.match(CHANGED_ACCESS_V2_HTML, /window\.parent\.postMessage\(\{type:"shell\.ready"\},"\*"\)/);
  assert.match(CHANGED_ACCESS_V1_HTML, /background:#1b1612;color:#f8f5f2/);
  assert.match(CHANGED_ACCESS_V2_HTML, /background:#1b1612;color:#f8f5f2/);
  assert.notEqual(loaded.v1.artifact.htmlHash, loaded.v2.artifact.htmlHash);
});

test('tampered changed-access revision fails signature or content verification', async () => {
  const altered = { ...CHANGED_ACCESS_V2_EVENT, tags: CHANGED_ACCESS_V2_EVENT.tags.map(tag => [...tag]) };
  altered.tags[4]![1] = 'storage';
  assert.equal(verifyEvent(altered), false);
  await assert.rejects(() => verifyManifest(CHANGED_ACCESS_COORDINATE, altered));
});
