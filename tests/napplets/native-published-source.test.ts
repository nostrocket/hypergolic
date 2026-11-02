import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { naddrEncode } from 'nostr-tools/nip19';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { loadPublishedArtifact, PublishedLoadError } from '../../src/napplets/loader.ts';
import { createNativePublishedRelayLookup, type NativePublishedRelayPort } from '../../src/napplets/native-published-relay.ts';
import { createNativePublishedArtifactSource } from '../../src/napplets/published-source.ts';

const secret = Uint8Array.from([...new Uint8Array(31), 2]);
const pubkey = getPublicKey(secret);
const identifier = 'native-source-test';
const link = naddrEncode({ kind: 35129, pubkey, identifier });
const relays = ['wss://chosen-a.example.org', 'wss://chosen-b.example.net'];
const html = new TextEncoder().encode('<!doctype html><html lang="en"><head><title>Native source</title></head><body>verified native source</body></html>');
const htmlHash = createHash('sha256').update(html).digest('hex');
const aggregateHash = createHash('sha256').update(`${htmlHash} /index.html\n`).digest('hex');
const signed = finalizeEvent({
  kind: 35129,
  created_at: 1_800_000_000,
  content: '',
  tags: [['d', identifier], ['path', '/index.html', htmlHash], ['x', aggregateHash, 'aggregate'],
    ['server', 'https://blossom.example.org/']],
}, secret);
const event = {
  id: signed.id, pubkey: signed.pubkey, created_at: signed.created_at, kind: signed.kind,
  tags: signed.tags.map(tag => [...tag]), content: signed.content, sig: signed.sig,
};

function relayPort(calls: string[]): NativePublishedRelayPort {
  let id = 0;
  return {
    newInstanceId() { id++; return `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`; },
    async queryPublishedRelay(_operationId, url, requestText, subscriptionId) {
      calls.push(`${url}|${requestText}`);
      return [JSON.stringify(['EVENT', subscriptionId, event]), JSON.stringify(['EOSE', subscriptionId])];
    },
    cancelPublishedRelay() {},
    revokeAllPublishedRelay() {},
  };
}

test('native source delegates only the selected relays and Blossom reads retain the signed content hash check', async () => {
  const relayCalls: string[] = [];
  const blobRequests: string[] = [];
  const lookup = createNativePublishedRelayLookup(relayPort(relayCalls));
  const source = createNativePublishedArtifactSource({
    relayLookup: lookup,
    fetchPublicHttps: async (url) => {
      blobRequests.push(url);
      return new Response(html, { status: 200 });
    },
  });

  const artifact = await loadPublishedArtifact(link, {
    source, lookupRelays: relays, signal: new AbortController().signal, assertActive: () => undefined,
  });
  assert.deepEqual(relayCalls.map(call => call.split('|', 1)[0]), relays);
  for (const call of relayCalls) assert.equal(JSON.parse(call.slice(call.indexOf('|') + 1))[0], 'REQ');
  assert.deepEqual(blobRequests, [`https://blossom.example.org/${htmlHash}`]);
  assert.equal(artifact.htmlHash, htmlHash);

  const tamperedSource = createNativePublishedArtifactSource({
    relayLookup: lookup,
    fetchPublicHttps: async () => new Response('altered bytes', { status: 200 }),
  });
  await assert.rejects(loadPublishedArtifact(link, {
    source: tamperedSource, lookupRelays: [relays[0]!], signal: new AbortController().signal,
    assertActive: () => undefined,
  }), PublishedLoadError);
});
