import test from 'node:test';
import assert from 'node:assert/strict';
import { installNativeRandom, EntropyUnavailableError } from '../../src/security/native-random.ts';

test('real Nostr key generation and Schnorr signing use the installed provider and propagate its failure', async () => {
  let fail = false;
  const calls: number[] = [];
  // A deterministic test provider only. These keys/events never leave this process.
  installNativeRandom(globalThis, bytes => {
    calls.push(bytes.length);
    if (fail) throw new Error('test native failure');
    bytes.fill(37);
  });
  const previousRandom = Math.random;
  Math.random = () => { throw new Error('Weak random must not run'); };
  let key: Uint8Array | undefined;
  try {
    const { identityCrypto, newOpaqueId } = await import('../../src/security/identity-crypto.ts');
    const { finalizeEvent, verifyEvent } = await import('nostr-tools/pure');
    key = identityCrypto.generateSecretKey();
    assert.equal(key.length, 32);
    assert.match(identityCrypto.derivePublicKey(key), /^[a-f0-9]{64}$/);
    const event = finalizeEvent({ kind: 1, created_at: 1, content: 'Local crypto test', tags: [] }, key);
    // Remove the library's cached verification symbol: verify actual serialized bytes.
    assert.equal(verifyEvent(JSON.parse(JSON.stringify(event))), true);
    assert.match(newOpaqueId(), /^[a-f0-9]{48}$/);
    assert.deepEqual(calls, [32, 48, 32, 24]);
    fail = true;
    assert.throws(() => identityCrypto.generateSecretKey(), EntropyUnavailableError);
    assert.throws(() => finalizeEvent({ kind: 1, created_at: 2, content: '', tags: [] }, key!), EntropyUnavailableError);
    assert.throws(newOpaqueId, EntropyUnavailableError);
  } finally { key?.fill(0); Math.random = previousRandom; }
});
