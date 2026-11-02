import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { captureUploadAuthorization } from '../../src/uploads/upload-authorization.ts';
import { captureUploadSnapshot } from '../../src/uploads/upload-snapshot.ts';
import type { VerifiedSignedEvent } from '../../src/security/signed-event.ts';
import { UploadError } from '../../src/uploads/upload-contract.ts';

async function fixture() {
  const key = new Uint8Array(32); key[31] = 1;
  try {
    const snapshot = await captureUploadSnapshot(new Uint8Array([1,2,3]), getPublicKey(key), 'https://files.example.com',
      'image/png', 1000, async bytes => createHash('sha256').update(bytes).digest('hex'));
    const signed: VerifiedSignedEvent = JSON.parse(JSON.stringify(finalizeEvent({...snapshot.authorization, tags: snapshot.authorization.tags.map(tag => [...tag])}, key)));
    return {snapshot, signed};
  } finally { key.fill(0); }
}
const denied = (value: unknown) => value instanceof UploadError && value.code === 'policy denied';
test('real Schnorr signature is checked and credential is canonical unpadded base64url', async () => {
  const {snapshot, signed} = await fixture(); const auth = captureUploadAuthorization(snapshot, signed, 1001);
  assert.match(auth.token, /^[A-Za-z0-9_-]+$/); assert.equal(auth.token, Buffer.from(JSON.stringify(auth.event)).toString('base64url'));
  assert.deepEqual(JSON.parse(Buffer.from(auth.token, 'base64url').toString()), auth.event);
  assert.equal(Object.isFrozen(auth.event), true);
});
test('signer result cannot change scope, identity, hash or signature', async () => {
  const {snapshot, signed} = await fixture();
  for (const changed of [{sig: '0'.repeat(128)}, {id: 'b'.repeat(64)}, {pubkey: 'b'.repeat(64)},
    {tags: signed.tags.filter(tag => tag[0] !== 'server')}, {kind: 1}, {content: 'other purpose'}]) {
    assert.throws(() => captureUploadAuthorization(snapshot, {...signed, ...changed}, 1001), denied);
  }
});
test('not-yet-valid, expired and invalid clocks refuse credentials before dispatch', async () => {
  const {snapshot, signed} = await fixture();
  for (const now of [999,1000,1120,NaN,Infinity,1.5]) assert.throws(() => captureUploadAuthorization(snapshot, signed, now), denied);
});
