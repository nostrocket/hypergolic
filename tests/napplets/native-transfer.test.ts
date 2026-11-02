import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { naddrEncode } from 'nostr-tools/nip19';
import { resolveNappletLink } from '../../src/napplets/resolve-link.ts';
import { stageVerifiedArtifact, TRANSFER_CHUNK_BYTES, type NativePublishedTransferPort } from '../../src/napplets/native-transfer.ts';
import { verifyArtifact, verifyManifest } from '../../src/napplets/verified-artifact.ts';

const SECRET = new Uint8Array(32); SECRET[31] = 5;
const PUBKEY = getPublicKey(SECRET);
const SESSION = 'published_test_1';
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
async function sha(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}
async function verified(body = 'ok') {
  const bytes = new TextEncoder().encode(`<!doctype html><html><head><title>Test</title></head><body>${body}</body></html>`);
  const htmlHash = await sha(bytes);
  const aggregate = await sha(new TextEncoder().encode(`${htmlHash} /index.html\n`));
  const event = finalizeEvent({ kind: 35129, created_at: 1_800_000_000, content: '',
    tags: [['d', 'hello'], ['path', '/index.html', htmlHash], ['x', aggregate, 'aggregate'],
      ['server', 'https://blossom.example.org']] }, SECRET);
  const coordinate = resolveNappletLink(naddrEncode({ kind: 35129, pubkey: PUBKEY, identifier: 'hello' }));
  return { artifact: await verifyArtifact(await verifyManifest(coordinate, JSON.parse(JSON.stringify(event))), bytes), bytes, event };
}

function port(overrides: Partial<NativePublishedTransferPort> = {}) {
  const chunks: Uint8Array[] = [];
  const calls: string[] = [];
  const native: NativePublishedTransferPort = {
    registerPublishedSession() { calls.push('register'); return true; },
    beginPublishedArtifact(sessionId, publisher, identifier, eventId, aggregateHash, htmlHash, byteLength) {
      calls.push('begin');
      assert.equal(sessionId, SESSION); assert.equal(publisher, PUBKEY); assert.equal(identifier, 'hello');
      assert.match(eventId, /^[0-9a-f]{64}$/); assert.match(aggregateHash, /^[0-9a-f]{64}$/);
      assert.match(htmlHash, /^[0-9a-f]{64}$/); assert.ok(byteLength > 0);
      return 'upload';
    },
    appendPublishedArtifact(uploadId, sequence, base64Chunk) {
      calls.push('append'); assert.equal(uploadId, 'upload'); assert.equal(sequence, chunks.length);
      assert.equal(base64Chunk, Buffer.from(base64Chunk, 'base64').toString('base64'));
      const decoded = Buffer.from(base64Chunk, 'base64');
      assert.ok(decoded.length > 0 && decoded.length <= TRANSFER_CHUNK_BYTES);
      chunks.push(decoded); return true;
    },
    finishPublishedArtifact(uploadId) { calls.push('finish'); assert.equal(uploadId, 'upload'); return 'opaque-handle'; },
    cancelPublishedArtifact(uploadId) { calls.push('cancel'); assert.equal(uploadId, 'upload'); },
    revokePublishedSession(sessionId) { calls.push('revoke'); assert.equal(sessionId, SESSION); },
    revokeAllPublishedArtifacts() { calls.push('revoke-all'); },
    ...overrides,
  };
  return { native, calls, chunks };
}

test('stages original verified bytes in canonical bounded chunks with exact native claims', async () => {
  const { artifact, bytes } = await verified('a'.repeat(TRANSFER_CHUNK_BYTES * 2));
  const transfer = port();
  const result = await stageVerifiedArtifact(artifact, SESSION, transfer.native, new AbortController().signal, () => {});
  assert.equal(result, 'opaque-handle');
  assert.deepEqual(Buffer.concat(transfer.chunks), Buffer.from(bytes));
  assert.deepEqual(transfer.calls, ['begin', 'append', 'append', 'append', 'finish']);
});

test('rejects a structural lookalike before any native admission', async () => {
  const { artifact } = await verified();
  const transfer = port();
  await assert.rejects(stageVerifiedArtifact({ ...artifact }, SESSION, transfer.native,
    new AbortController().signal, () => {}));
  assert.deepEqual(transfer.calls, []);
});

test('cancels an incomplete upload when ownership changes during a chunk', async () => {
  const { artifact } = await verified('a'.repeat(TRANSFER_CHUNK_BYTES));
  const controller = new AbortController();
  const transfer = port({ appendPublishedArtifact() { transfer.calls.push('append'); controller.abort(); return true; } });
  await assert.rejects(stageVerifiedArtifact(artifact, SESSION, transfer.native, controller.signal, () => {}));
  assert.deepEqual(transfer.calls, ['begin', 'append', 'cancel']);
});

test('revokes a finished native handle if identity expires during finalize', async () => {
  const { artifact } = await verified();
  let active = true;
  const transfer = port({ finishPublishedArtifact() { transfer.calls.push('finish'); active = false; return 'opaque-handle'; } });
  await assert.rejects(stageVerifiedArtifact(artifact, SESSION, transfer.native,
    new AbortController().signal, () => { if (!active) throw new Error('stale'); }));
  assert.deepEqual(transfer.calls, ['begin', 'append', 'finish', 'revoke']);
});

test('a native begin denial does not send bytes', async () => {
  const { artifact } = await verified();
  const transfer = port({ beginPublishedArtifact() { transfer.calls.push('begin'); return null; } });
  await assert.rejects(stageVerifiedArtifact(artifact, SESSION, transfer.native,
    new AbortController().signal, () => {}));
  assert.deepEqual(transfer.calls, ['begin']);
});
