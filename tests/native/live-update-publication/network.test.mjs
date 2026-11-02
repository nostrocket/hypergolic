import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyEvent } from 'nostr-tools/pure';
import { makeReleasePair } from './release-pair.mjs';
import { publishRevision, readBackRevision, uploadPair } from './network.mjs';

const secret = new Uint8Array(32).fill(4);
const pair = makeReleasePair(secret, { identifier: 'hg-update-qa',
  server: 'https://blossom.ditto.pub/', relays: ['wss://relay.damus.io', 'wss://relay.ditto.pub'],
  createdAt: 1_790_600_000 });

test('Blossom upload signs hash- and server-scoped BUD-11 tokens and verifies direct bytes', async () => {
  const pending = new Map(pair.revisions.map(revision => [revision.hash, revision]));
  let uploads = 0;
  const fetcher = async (url, init) => {
    assert.equal(url.origin, 'https://blossom.ditto.pub');
    assert.equal(init.redirect, 'manual');
    if (init.method === 'PUT') {
      assert.equal(url.pathname, '/upload');
      const hash = init.headers['X-SHA-256'];
      const revision = pending.get(hash);
      assert.ok(revision);
      assert.deepEqual(Buffer.from(init.body), Buffer.from(revision.html));
      const token = JSON.parse(Buffer.from(init.headers.Authorization.slice(6), 'base64url').toString());
      assert.equal(verifyEvent(token), true);
      assert.equal(token.pubkey, pair.publisher);
      assert.deepEqual(token.tags.filter(tag => tag[0] !== 'expiration'), [
        ['t', 'upload'], ['server', 'blossom.ditto.pub'], ['x', hash],
      ]);
      assert.ok(Number(token.tags.find(tag => tag[0] === 'expiration')[1]) > token.created_at);
      uploads++;
      return new Response(JSON.stringify({ sha256: hash, size: init.body.length }), { status: 201 });
    }
    assert.equal(init.method, 'GET');
    return new Response(pending.get(url.pathname.slice(1)).html, { status: 200 });
  };
  const receipts = await uploadPair(pair, secret, fetcher);
  assert.equal(uploads, 2);
  assert.deepEqual(receipts.map(item => item.hash), pair.revisions.map(item => item.hash));
});

test('Blossom readback with different bytes fails even after a success descriptor', async () => {
  const fetcher = async (url, init) => init.method === 'PUT'
    ? new Response(JSON.stringify({ sha256: init.headers['X-SHA-256'], size: init.body.length }), { status: 201 })
    : new Response('wrong bytes', { status: 200 });
  await assert.rejects(uploadPair(pair, secret, fetcher), /readback mismatch/);
});

test('upload rejects a mismatched publisher key before any network request', async () => {
  let requests = 0;
  await assert.rejects(uploadPair(pair, new Uint8Array(32).fill(5), async () => {
    requests++;
    throw new Error('network must not run');
  }), /key does not match/);
  assert.equal(requests, 0);
});

test('upload refuses oversized Blossom descriptor and HTML readback', async () => {
  const oversizedDescriptor = async () => new Response('x'.repeat(4097), { status: 201 });
  await assert.rejects(uploadPair(pair, secret, oversizedDescriptor), /descriptor invalid or oversized/);
  const oversizedReadback = async (_url, init) => init.method === 'PUT'
    ? new Response(JSON.stringify({ sha256: init.headers['X-SHA-256'], size: init.body.length }), { status: 201 })
    : new Response('x'.repeat(Buffer.byteLength(pair.revisions[0].html) + 1), { status: 200 });
  await assert.rejects(uploadPair(pair, secret, oversizedReadback), /exceeded expected size/);
});

class MockSocket {
  constructor(relay) { this.relay = relay; queueMicrotask(() => this.onopen()); }
  send(message) {
    const [kind, payload, filter] = JSON.parse(message);
    const allowed = !this.relay.includes('ditto');
    if (kind === 'EVENT') {
      queueMicrotask(() => this.onmessage({ data: JSON.stringify(['OK', payload.id, allowed, allowed ? '' : 'blocked']) }));
      return;
    }
    assert.equal(kind, 'REQ');
    assert.deepEqual(filter, { kinds: [35129], authors: [pair.publisher], '#d': [pair.identifier], limit: 32 });
    queueMicrotask(() => {
      this.onmessage({ data: JSON.stringify(['EVENT', payload, pair.revisions[1].event]) });
      this.onmessage({ data: JSON.stringify(['EOSE', payload]) });
    });
  }
  close() {}
}

test('release requires relay acknowledgement for the exact signed revision', async () => {
  const receipt = await publishRevision(pair, 'v2', MockSocket);
  assert.equal(receipt.eventId, pair.revisions[1].event.id);
  assert.deepEqual(receipt.accepted.map(item => item.relay), ['wss://relay.damus.io']);
  assert.equal(receipt.accepted[0].queryable, true);
  assert.equal(receipt.failures, 1);
  await assert.rejects(publishRevision(pair, 'v3', MockSocket), /Select v1 or v2/);
});

test('relay acknowledgement without exact coordinate readback is not a publication pass', async () => {
  class AbsentReadbackSocket extends MockSocket {
    send(message) {
      const [kind, payload] = JSON.parse(message);
      if (kind !== 'REQ') return super.send(message);
      queueMicrotask(() => this.onmessage({ data: JSON.stringify(['EOSE', payload]) }));
    }
  }
  await assert.rejects(publishRevision(pair, 'v2', AbsentReadbackSocket),
    /acknowledged but no lookup relay made the QA revision queryable/);
});

test('readback of the older signed revision cannot stand in for the new one', async () => {
  class StaleReadbackSocket extends MockSocket {
    send(message) {
      const [kind, payload] = JSON.parse(message);
      if (kind !== 'REQ') return super.send(message);
      queueMicrotask(() => {
        this.onmessage({ data: JSON.stringify(['EVENT', payload, pair.revisions[0].event]) });
        this.onmessage({ data: JSON.stringify(['EOSE', payload]) });
      });
    }
  }
  await assert.rejects(readBackRevision('wss://relay.damus.io', pair.revisions[1].event, StaleReadbackSocket),
    /exact QA revision was not queryable/);
});

test('readback rejects an invalid relay event before EOSE', async () => {
  class InvalidReadbackSocket extends MockSocket {
    send(message) {
      const [kind, payload] = JSON.parse(message);
      if (kind !== 'REQ') return super.send(message);
      queueMicrotask(() => this.onmessage({ data: JSON.stringify(['EVENT', payload, { id: 'not-signed' }]) }));
    }
  }
  await assert.rejects(readBackRevision('wss://relay.damus.io', pair.revisions[1].event, InvalidReadbackSocket),
    /readback event invalid/);
});
