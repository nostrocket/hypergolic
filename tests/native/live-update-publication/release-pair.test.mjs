import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveNappletLink } from '../../../src/napplets/resolve-link.ts';
import { verifyArtifact, verifyManifest } from '../../../src/napplets/verified-artifact.ts';
import { makeReleasePair, validateReleasePair } from './release-pair.mjs';

const secret = new Uint8Array(32).fill(4);
const options = {
  identifier: 'hg-update-qa', server: 'https://blossom.ditto.pub/',
  relays: ['wss://relay.damus.io', 'wss://relay.ditto.pub'], createdAt: 1_790_600_000,
};

function clone(value) { return JSON.parse(JSON.stringify(value)); }

test('two signed revisions pass the application verifier and expose only public handoff data', async () => {
  const pair = validateReleasePair(makeReleasePair(secret, options));
  assert.equal(pair.revisions.length, 2);
  assert.equal(pair.revisions[1].event.created_at, pair.revisions[0].event.created_at + 1);
  assert.equal(JSON.stringify(pair).includes(Buffer.from(secret).toString('hex')), false);
  const coordinate = resolveNappletLink(pair.naddr);
  for (const revision of pair.revisions) {
    const manifest = await verifyManifest(coordinate, revision.event);
    const artifact = await verifyArtifact(manifest, new TextEncoder().encode(revision.html));
    assert.equal(manifest.expectedHtmlHash, revision.hash);
    assert.equal(artifact.manifest.eventId, revision.event.id);
    assert.deepEqual(manifest.serverHints, [pair.server]);
    assert.deepEqual(manifest.requiredDomains, ['theme']);
  }
});

test('release handoff rejects changed HTML, server, signature and version order', () => {
  const pair = makeReleasePair(secret, options);
  const changedHtml = clone(pair);
  changedHtml.revisions[1].html = changedHtml.revisions[1].html.replace('update-v2', 'update-v3');
  assert.throws(() => validateReleasePair(changedHtml));
  const changedServer = clone(pair);
  changedServer.server = 'https://other.example.com/';
  assert.throws(() => validateReleasePair(changedServer));
  const changedSignature = clone(pair);
  changedSignature.revisions[1].event.sig = '0'.repeat(128);
  assert.throws(() => validateReleasePair(changedSignature));
  const changedOrder = clone(pair);
  changedOrder.revisions.reverse();
  assert.throws(() => validateReleasePair(changedOrder));
});

test('release builder requires bounded public endpoints and a short stable identifier', () => {
  assert.throws(() => makeReleasePair(secret, { ...options, server: 'http://127.0.0.1/' }));
  assert.throws(() => makeReleasePair(secret, { ...options, server: 'https://127.0.0.1/' }));
  assert.throws(() => makeReleasePair(secret, { ...options, server: 'https://blossom.local/' }));
  assert.throws(() => makeReleasePair(secret, { ...options, relays: ['wss://192.168.1.2/'] }));
  assert.throws(() => makeReleasePair(secret, { ...options, relays: ['wss://relay.internal/'] }));
  assert.throws(() => makeReleasePair(secret, { ...options, relays: ['ws://localhost:8000'] }));
  assert.throws(() => makeReleasePair(secret, { ...options, identifier: 'invalid_identifier' }));
});
