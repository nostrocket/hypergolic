import test from 'node:test';
import assert from 'node:assert/strict';
import { createAndroidDeletionPort } from '../../src/security/android-identity-deletion.ts';
import type { DeletionGrant } from '../../src/security/identity-vault.ts';
const target = '11'.repeat(32), other = '22'.repeat(32);
const grant: DeletionGrant = Object.freeze({ assertActive() {} });
function fixture() {
  const calls: unknown[][] = [];
  const grants = new WeakMap<DeletionGrant, string>([[grant, 'native_test_grant_000001']]);
  const tokens = { consume(value: DeletionGrant, key: string) {
    const token = grants.get(value);
    if (!token || key !== target) throw new Error('foreign grant');
    grants.delete(value); return token;
  } };
  const module = { async deleteSecretAsync(key: string, token: string) { calls.push([key, token]); } };
  return { calls, module, tokens, port: createAndroidDeletionPort(module, tokens) };
}
test('native erase receives exact target/token synchronously and a consumed grant cannot replay', async () => {
  const f = fixture(), deleting = f.port.deleteSecret(target, grant);
  assert.deepEqual(f.calls, [[target, 'native_test_grant_000001']]); await deleting;
  assert.throws(() => f.port.deleteSecret(target, grant), { code: 'AUTHORIZATION_DENIED' });
});
test('invalid target, wrong identity and foreign or revoked grants never reach native erasure', () => {
  const f = fixture();
  assert.throws(() => f.port.deleteSecret('invalid', grant), { code: 'CORRUPT_METADATA' });
  assert.throws(() => f.port.deleteSecret(other, grant), { code: 'AUTHORIZATION_DENIED' });
  assert.throws(() => f.port.deleteSecret(target, { assertActive() {} }), { code: 'AUTHORIZATION_DENIED' });
  assert.throws(() => f.port.deleteSecret(target, { assertActive() { throw new Error('revoked'); } }), { code: 'AUTHORIZATION_DENIED' });
  assert.deepEqual(f.calls, []);
});
for (const [code, expected] of [['ERR_IDENTITY_ACTION_DENIED', 'AUTHORIZATION_DENIED'], ['ERR_IDENTITY_ERASE_UNCONFIRMED', 'READBACK_FAILED'], ['unknown', 'READBACK_FAILED']] as const) {
  test(`native ${code} is constant, cannot imply success, and consumes its grant`, async () => {
    const f = fixture(); f.module.deleteSecretAsync = async () => { throw { code, message: 'native private details' }; };
    await assert.rejects(f.port.deleteSecret(target, grant), { code: expected, message: expected });
    assert.throws(() => f.port.deleteSecret(target, grant), { code: 'AUTHORIZATION_DENIED' });
  });
}
test('native error getters are not invoked or retained', async () => {
  const f = fixture(); let reads = 0;
  f.module.deleteSecretAsync = async () => { throw Object.defineProperty({}, 'code', { get() { reads++; throw new Error('private'); } }); };
  await assert.rejects(f.port.deleteSecret(target, grant), { code: 'READBACK_FAILED', message: 'READBACK_FAILED' });
  assert.equal(reads, 0);
});
