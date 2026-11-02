import assert from 'node:assert/strict';
import test from 'node:test';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { runNativeSignerCheck, type NativeSignerCoreModule } from '../../src/security/native-signer-core.ts';

const secret = new Uint8Array(32).fill(17);
const pubkey = getPublicKey(secret);
const timestamp = 1_790_000_000;

function bridge(reply: (wire: string) => string): NativeSignerCoreModule {
  return {
    activateEphemeralSigner: () => true,
    generateDisposableIdentityAsync: async () => pubkey,
    reviewAndSignDisposableEventAsync: async wire => reply(wire),
    cancelDisposableReviewAsync: async () => {},
  };
}

test('native trace verifies a public signed result against its exact request', async () => {
  const result = await runNativeSignerCheck(bridge(wire => {
    const event = JSON.parse(wire);
    assert.equal(event.pubkey, pubkey);
    assert.equal(event.content, 'Hypergolic native signing check');
    return JSON.stringify(finalizeEvent(event, secret));
  }), timestamp);
  assert.equal(result.pubkey, pubkey);
  assert.equal(result.created_at, timestamp);
  assert.ok(Object.isFrozen(result));
});

test('unavailable native owner cannot generate or request approval', async () => {
  const module = bridge(() => { throw new Error('must not review'); });
  module.activateEphemeralSigner = () => false;
  module.generateDisposableIdentityAsync = async () => { throw new Error('must not generate'); };
  await assert.rejects(runNativeSignerCheck(module, timestamp), /SIGNER_UNAVAILABLE/);
});

test('bridge activation must return the exact success boolean', async () => {
  for (const value of [undefined, null, 1, 'true', {}]) {
    const module = bridge(() => { throw new Error('must not review'); });
    module.activateEphemeralSigner = () => value as unknown as boolean;
    module.generateDisposableIdentityAsync = async () => { throw new Error('must not generate'); };
    await assert.rejects(runNativeSignerCheck(module, timestamp), /SIGNER_UNAVAILABLE/);
  }
});

test('invalid public key cannot reach native review', async () => {
  const module = bridge(() => { throw new Error('must not review'); });
  module.generateDisposableIdentityAsync = async () => 'not a public key';
  await assert.rejects(runNativeSignerCheck(module, timestamp), /Invalid event snapshot/);
});

for (const field of ['content', 'kind', 'created_at', 'tags', 'pubkey', 'sig'] as const) {
  test(`native trace rejects changed ${field}`, async () => {
    const module = bridge(wire => {
      const event = JSON.parse(wire);
      if (field === 'content') event.content = 'Substituted event';
      if (field === 'kind') event.kind = 0;
      if (field === 'created_at') event.created_at += 1;
      if (field === 'tags') event.tags = [['t', 'substituted']];
      const signed = finalizeEvent(event, field === 'pubkey' ? new Uint8Array(32).fill(18) : secret);
      if (field === 'sig') signed.sig = '0'.repeat(128);
      return JSON.stringify(signed);
    });
    await assert.rejects(runNativeSignerCheck(module, timestamp), /Invalid signed event/);
  });
}

test('native refusal propagates without retry or fallback', async () => {
  let calls = 0;
  await assert.rejects(runNativeSignerCheck(bridge(() => {
    calls += 1;
    throw new Error('SIGNER_REJECTED');
  }), timestamp), /SIGNER_REJECTED/);
  assert.equal(calls, 1);
});

test('malformed and oversized replies fail before being accepted', async () => {
  for (const reply of ['null', '{', ' '.repeat(16_385)]) {
    await assert.rejects(runNativeSignerCheck(bridge(() => reply), timestamp));
  }
});
