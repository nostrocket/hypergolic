import test from 'node:test';
import assert from 'node:assert/strict';
import { createProtectedSecrets, INVENTORY_KEY, STAGE_KEY, secretStorageKey, VAULT_SERVICE, type NativePlatform } from '../../src/security/android-encrypted-secrets.ts';
import { decodeInventory, encodeInventory, encodeSecret } from '../../src/security/identity-codec.ts';
import { VaultError, type Inventory } from '../../src/security/identity-vault.ts';
import { SecureFake, deletionFixture, pubkey, TEST_ID } from './harness.ts';

const grant = Object.freeze({ assertActive() {} });
const inventory = (): Inventory => ({ schema: 1, vaultId: TEST_ID, revision: 1, initialized: true, selectedPubkey: pubkey(1), identities: [{ pubkey: pubkey(1), addedAt: 42, origin: 'generated' }] });
const secret = () => ({ schema: 1 as const, pubkey: pubkey(1), secretKey: new Uint8Array(32).fill(7) });
for (const platform of ['android'] as const) {
  test(`${platform}: stable native options protect every item; no biometric enrollment gate or dynamic fallback`, async () => {
    const native = new SecureFake(), adapter = await createProtectedSecrets(native, platform, deletionFixture(native));
    await adapter.writeInventory(inventory());
    await adapter.writeStage({ ...secret(), vaultId: TEST_ID, kind: 'import', addedAt: 42 });
    await adapter.writeSecret(pubkey(1), secret());
    assert.deepEqual(await adapter.readInventory(), inventory());
    assert.deepEqual(await adapter.readSecret(pubkey(1)), secret());
    await adapter.readStage(); await adapter.deleteStage(); await adapter.deleteSecret(pubkey(1), grant);
    assert.equal(await adapter.readStage(), null); assert.equal(await adapter.readSecret(pubkey(1)), null);
    assert(native.options.length > 10);
    for (const options of native.options) {
      assert.deepEqual(options, { keychainService: VAULT_SERVICE, requireAuthentication: false });
      assert(Object.isFrozen(options));
      assert.equal(options, native.options[0]);
    }
    assert.equal(native.calls.filter(call => call === 'available').length, 1);
  });
  test(`${platform}: adapter construction never mutates surviving storage`, async () => {
    const native = new SecureFake(); native.values.set(INVENTORY_KEY, encodeInventory(inventory()));
    const before = new Map(native.values);
    await createProtectedSecrets(native, platform, deletionFixture(native));
    assert.deepEqual(native.values, before);
    assert.deepEqual(native.calls, ['available']);
  });
}
test('unavailable SecureStore fails before native reads/writes and unsupported web fails before availability probe', async () => {
  const native = new SecureFake(); native.available = false;
  await assert.rejects(createProtectedSecrets(native, 'android', deletionFixture(native)), { code: 'STORAGE_FAILURE' });
  assert.deepEqual(native.calls, ['available']); native.calls = [];
  await assert.rejects(createProtectedSecrets(native, 'web' as NativePlatform), { code: 'STORAGE_FAILURE' });
  assert.deepEqual(native.calls, []);
});
test('read rejection cannot become absent; raw native secret-looking error is not retained', async () => {
  const native = new SecureFake(), adapter = await createProtectedSecrets(native, 'android', deletionFixture(native));
  native.fault = { match: `get:${INVENTORY_KEY}`, mode: 'before' };
  await assert.rejects(adapter.readInventory(), e => e instanceof VaultError && e.message === 'STORAGE_FAILURE' && !('cause' in e));
  native.values.set(INVENTORY_KEY, 'malformed');
  await assert.rejects(adapter.readInventory(), { code: 'CORRUPT_METADATA' });
});
test('write snapshots the caller before awaited read; no secret envelope replacement, including malformed stored item', async () => {
  const native = new SecureFake(), adapter = await createProtectedSecrets(native, 'android', deletionFixture(native));
  const input = secret(), writing = adapter.writeSecret(pubkey(1), input);
  input.secretKey.fill(9); await writing;
  assert.deepEqual(await adapter.readSecret(pubkey(1)), secret());
  await assert.rejects(adapter.writeSecret(pubkey(1), input), { code: 'RECOVERY_REQUIRED' });
  const saved = native.values.get(secretStorageKey(pubkey(1)));
  await adapter.writeSecret(pubkey(1), secret());
  assert.equal(native.values.get(secretStorageKey(pubkey(1))), saved);
  native.values.set(secretStorageKey(pubkey(1)), 'broken');
  await assert.rejects(adapter.writeSecret(pubkey(1), secret()), { code: 'RECOVERY_REQUIRED' });
  assert.equal(native.values.get(secretStorageKey(pubkey(1))), 'broken');
});
test('stage cannot overwrite another staged key and future/foreign receipt cannot be replaced', async () => {
  const native = new SecureFake(), adapter = await createProtectedSecrets(native, 'android', deletionFixture(native));
  const staged = { ...secret(), vaultId: TEST_ID, kind: 'import' as const, addedAt: 42 };
  await adapter.writeStage(staged);
  await assert.rejects(adapter.writeStage({ ...staged, addedAt: 43 }), { code: 'RECOVERY_REQUIRED' });
  await adapter.writeInventory(inventory());
  await assert.rejects(adapter.writeInventory({ ...inventory(), vaultId: 'foreign_vault_000001', revision: 2 }), { code: 'RECOVERY_REQUIRED' });
  native.values.set(INVENTORY_KEY, encodeInventory({ ...inventory(), revision: 5 }));
  await assert.rejects(adapter.writeInventory(inventory()), { code: 'RECOVERY_REQUIRED' });
  assert.equal(decodeInventory(native.values.get(INVENTORY_KEY)!).revision, 5);
});
test('deletion reaches native API synchronously with no awaited preflight after core grant recheck', async () => {
  const native = new SecureFake(), adapter = await createProtectedSecrets(native, 'android', deletionFixture(native));
  native.values.set(secretStorageKey(pubkey(1)), encodeSecret(secret())); native.calls = [];
  const deleting = adapter.deleteSecret(pubkey(1), grant);
  assert.deepEqual(native.calls, [`delete:${secretStorageKey(pubkey(1))}`]);
  await deleting;
});
test('adapter does not claim successful native write/delete is durable; vault supplies required readbacks', async () => {
  const native = new SecureFake(), adapter = await createProtectedSecrets(native, 'android', deletionFixture(native));
  native.fault = { match: `set:${secretStorageKey(pubkey(1))}`, mode: 'omit' };
  await adapter.writeSecret(pubkey(1), secret());
  assert.equal(await adapter.readSecret(pubkey(1)), null);
  await adapter.writeSecret(pubkey(1), secret());
  native.fault = { match: `delete:${secretStorageKey(pubkey(1))}`, mode: 'omit' };
  await adapter.deleteSecret(pubkey(1), grant); assert.deepEqual(await adapter.readSecret(pubkey(1)), secret());
});
test('invalid key/address/method mismatch never reaches native storage', async () => {
  const native = new SecureFake(), adapter = await createProtectedSecrets(native, 'android', deletionFixture(native)); native.calls = [];
  assert.throws(() => adapter.writeSecret(pubkey(2), secret()));
  assert.throws(() => adapter.deleteSecret('bad.key', grant));
  assert.throws(() => adapter.writeStage({ ...secret(), vaultId: TEST_ID, kind: 'import', addedAt: NaN }));
  assert.deepEqual(native.calls, []);
  assert(!native.values.has(STAGE_KEY));
});

test('iOS rejects this adapter before probing native storage', async () => {
  const native = new SecureFake();
  await assert.rejects(createProtectedSecrets(native, 'ios'), { code: 'STORAGE_FAILURE' });
  assert.deepEqual(native.calls, []);
});
test('a revoked deletion grant cannot enter the native adapter', async () => {
  const native = new SecureFake(), adapter = await createProtectedSecrets(native, 'android', deletionFixture(native));
  native.calls = [];
  assert.throws(() => adapter.deleteSecret(pubkey(1), { assertActive() { throw Error('revoked'); } }), { code: 'AUTHORIZATION_DENIED' });
  assert.deepEqual(native.calls, []);
});

for (const constantShape of ['absent', 'undefined'] as const) {
  test(`Android storage works when iOS accessibility constant is ${constantShape}`, async () => {
    const native = new SecureFake();
    assert.equal('WHEN_UNLOCKED_THIS_DEVICE_ONLY' in native, false);
    if (constantShape === 'undefined') {
      Object.defineProperty(native, 'WHEN_UNLOCKED_THIS_DEVICE_ONLY', { value: undefined });
    }
    const saved = inventory();
    native.values.set(INVENTORY_KEY, encodeInventory(saved));
    native.values.set(secretStorageKey(pubkey(1)), encodeSecret(secret()));
    const before = new Map(native.values);
    const adapter = await createProtectedSecrets(native, 'android', deletionFixture(native));
    assert.deepEqual(await adapter.readInventory(), saved);
    assert.deepEqual(await adapter.readSecret(pubkey(1)), secret());
    assert.deepEqual(native.values, before);
    assert.deepEqual(native.calls, ['available', `get:${INVENTORY_KEY}`, `get:${secretStorageKey(pubkey(1))}`]);
  });
}

test('availability rejection fails before storage access and removes the native error payload', async () => {
  const native = new SecureFake();
  native.fault = { match: 'available', mode: 'before' };
  await assert.rejects(createProtectedSecrets(native, 'android', deletionFixture(native)), error =>
    error instanceof VaultError && error.code === 'STORAGE_FAILURE' && error.message === 'STORAGE_FAILURE' && !('cause' in error));
  assert.deepEqual(native.calls, ['available']);
  assert.equal(native.values.size, 0);
  assert.deepEqual(native.options, []);
});


test('missing native deletion port fails closed even with a JavaScript grant', async () => {
  const native = new SecureFake(), adapter = await createProtectedSecrets(native, 'android');
  native.calls = [];
  assert.throws(() => adapter.deleteSecret(pubkey(1), grant), { code: 'AUTHORIZATION_DENIED' });
  assert.deepEqual(native.calls, []);
});
