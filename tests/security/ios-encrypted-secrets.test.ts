import { IdentityDeviceRequired } from '../../src/security/identity-device-required.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIOSEncryptedSecrets, type IdentityStoreModule, type NativeDeletionTokens } from '../../src/security/ios-encrypted-secrets.ts';
import { VaultError, type DeletionGrant, type Inventory, type SecretRecord, type StagedSecret } from '../../src/security/identity-vault.ts';
import { encodeInventory, encodeSecret, encodeStage } from '../../src/security/identity-codec.ts';

const key = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
const inventory: Inventory = { schema: 1, vaultId: 'fixture_vault_000001', revision: 0, initialized: false, selectedPubkey: null, identities: [] };
const secret = (n = 1): SecretRecord => ({ schema: 1, pubkey: key(n), secretKey: new Uint8Array(32).fill(n + 10) });
const stage = (): StagedSecret => ({ ...secret(), vaultId: inventory.vaultId, kind: 'initialize', addedAt: 42 });
const token = 'fixture_deletion_token_000001';
class FixtureTokens implements NativeDeletionTokens {
  private readonly bindings = new WeakMap<DeletionGrant, { pubkey: string; token: string }>();
  assertions = 0;
  grant(pubkey = key(1), nativeToken = token): DeletionGrant {
    const grant = Object.freeze({ assertActive: () => { this.assertions++; } });
    this.bindings.set(grant, { pubkey, token: nativeToken });
    return grant;
  }
  consume(grant: DeletionGrant, pubkey: string): string {
    const binding = this.bindings.get(grant);
    if (!binding || binding.pubkey !== pubkey) throw new Error('fixture grant binding unavailable');
    this.bindings.delete(grant);
    return binding.token;
  }
}
class FixtureModule implements IdentityStoreModule {
  calls: { method: string; args: string[] }[] = [];
  values = new Map<string, string>();
  available: unknown = true;
  failure: unknown = null;
  pendingDelete: Promise<void> | null = null;
  record(method: string, ...args: string[]): void {
    this.calls.push({ method, args });
    if (this.failure) throw this.failure;
  }
  async isAvailableAsync() { this.record('available'); return this.available as boolean; }
  async readInventoryAsync() { this.record('readInventory'); return this.values.get('inventory') ?? null; }
  async writeInventoryAsync(value: string) { this.record('writeInventory', value); this.values.set('inventory', value); }
  async readStageAsync() { this.record('readStage'); return this.values.get('stage') ?? null; }
  async writeStageAsync(value: string) { this.record('writeStage', value); this.values.set('stage', value); }
  async deleteStageAsync() { this.record('deleteStage'); this.values.delete('stage'); }
  async readSecretAsync(pubkey: string) { this.record('readSecret', pubkey); return this.values.get(pubkey) ?? null; }
  async writeSecretAsync(pubkey: string, value: string) { this.record('writeSecret', pubkey, value); this.values.set(pubkey, value); }
  async deleteSecretAsync(pubkey: string, grantToken: string) {
    this.record('deleteSecret', pubkey, grantToken);
    if (this.pendingDelete) await this.pendingDelete;
    this.values.delete(pubkey);
  }
}
async function setup() {
  const module = new FixtureModule(), tokens = new FixtureTokens();
  return { module, tokens, adapter: await createIOSEncryptedSecrets(module, 'ios', tokens) };
}
const hasCode = (code: string) => (error: unknown) => error instanceof VaultError && error.code === code && error.message === code;

for (const platform of ['android', 'web', '', 'IOS']) test(`rejects ${JSON.stringify(platform)} without native lookup or fallback`, async () => {
  const module = new FixtureModule();
  await assert.rejects(createIOSEncryptedSecrets(module, platform, new FixtureTokens()), hasCode('STORAGE_FAILURE'));
  assert.equal(module.calls.length, 0);
});
for (const availability of [null, undefined, 1, 'true']) test(`requires literal native presence: ${String(availability)}`, async () => {
  const module = new FixtureModule(); module.available = availability;
  await assert.rejects(createIOSEncryptedSecrets(module, 'ios', new FixtureTokens()), hasCode('STORAGE_FAILURE'));
  assert.deepEqual(module.calls.map(call => call.method), ['available']);
});

test('literal unavailable environment stops before all native persistence methods', async () => {
  const module = new FixtureModule(); module.available = false;
  module.values.set('inventory', 'existing value must remain untouched');
  const before = [...module.values];
  await assert.rejects(createIOSEncryptedSecrets(module, 'ios', new FixtureTokens()), IdentityDeviceRequired);
  assert.deepEqual(module.calls.map(call => call.method), ['available']);
  assert.deepEqual([...module.values], before);
});

test('uses exact methods and immutable codec snapshots, preserves successful absence', async () => {
  const { module, adapter } = await setup();
  assert(Object.isFrozen(adapter));
  assert.equal(await adapter.readInventory(), null);
  assert.equal(await adapter.readStage(), null);
  assert.equal(await adapter.readSecret(key(1)), null);
  await adapter.writeInventory(inventory);
  await adapter.writeStage(stage());
  const value = secret(), expected = encodeSecret(value), writing = adapter.writeSecret(key(1), value);
  value.secretKey.fill(0); value.pubkey = key(2);
  await writing;
  assert.equal(module.values.get(key(1)), expected);
  assert.deepEqual(await adapter.readInventory(), inventory);
  assert.deepEqual(await adapter.readStage(), stage());
  const first = await adapter.readSecret(key(1)) as SecretRecord;
  first.secretKey.fill(0);
  assert.deepEqual(await adapter.readSecret(key(1)), secret());
  await adapter.deleteStage();
  assert.equal(await adapter.readStage(), null);
  assert.equal(module.values.get('inventory'), encodeInventory(inventory));
});

for (const code of ['UNAVAILABLE', 'CORRUPT', 'RECOVERY_REQUIRED', 'INVALID_INPUT', 'CONFLICT', 'UNAUTHORIZED']) test(`sanitizes allowlisted native ${code}`, async () => {
  const { module, adapter } = await setup();
  const expected: Record<string, string> = { UNAVAILABLE: 'STORAGE_FAILURE', CORRUPT: 'RECOVERY_REQUIRED', RECOVERY_REQUIRED: 'RECOVERY_REQUIRED', INVALID_INPUT: 'CORRUPT_METADATA', CONFLICT: 'RECOVERY_REQUIRED', UNAUTHORIZED: 'AUTHORIZATION_DENIED' };
  module.failure = Object.assign(new Error('secret raw native detail'), { code: `ERR_IDENTITY_STORE_${code}`, cause: 'private path' });
  await assert.rejects(adapter.readInventory(), hasCode(expected[code]!));
});
for (const value of [new Error('secret raw message'), 'secret raw string', { code: 'UNKNOWN', message: 'secret raw value' }]) test('unknown native failure is neither absence nor retained error detail', async () => {
  const { module, adapter } = await setup(); module.failure = value;
  await assert.rejects(adapter.readSecret(key(1)), hasCode('STORAGE_FAILURE'));
});
test('native error accessors are not invoked and throwing proxies are sanitized', async () => {
  const { module, adapter } = await setup(); let getterCalls = 0;
  module.failure = Object.defineProperty({}, 'code', { get() { getterCalls++; return 'ERR_IDENTITY_STORE_UNAUTHORIZED'; } });
  await assert.rejects(adapter.readInventory(), hasCode('STORAGE_FAILURE'));
  assert.equal(getterCalls, 0);
  module.failure = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('secret proxy detail'); } });
  await assert.rejects(adapter.readInventory(), hasCode('STORAGE_FAILURE'));
});
for (const text of ['[]', '{', 'null', '\n', 'é', 'x'.repeat(2049)]) test('malformed native receipt rejects without creating another identity', async () => {
  const { module, adapter } = await setup(); module.values.set('inventory', text);
  await assert.rejects(adapter.readInventory(), hasCode('CORRUPT_METADATA'));
  assert(!module.calls.some(call => call.method.startsWith('write')));
});
test('read secret rejects mismatched public key and malformed native secret', async () => {
  const { module, adapter } = await setup(); module.values.set(key(1), encodeSecret(secret(2)));
  await assert.rejects(adapter.readSecret(key(1)), hasCode('INVALID_SECRET'));
  module.values.set('stage', encodeStage(stage()).replace('HGS1', 'INVALID'));
  await assert.rejects(adapter.readStage(), hasCode('INVALID_SECRET'));
});
test('invalid caller input never reaches native methods or consumes a grant', async () => {
  const { module, tokens, adapter } = await setup(); const grant = tokens.grant();
  assert.throws(() => adapter.readSecret('../inventory'), hasCode('CORRUPT_METADATA'));
  assert.throws(() => adapter.writeSecret(key(2), secret()), hasCode('INVALID_SECRET'));
  assert.throws(() => adapter.deleteSecret('wrapping-key', grant), hasCode('CORRUPT_METADATA'));
  const invalid = Object.assign(secret(), { arbitrary: 'extra' });
  assert.throws(() => adapter.writeSecret(key(1), invalid), hasCode('CORRUPT_METADATA'));
  assert.equal(tokens.assertions, 0);
  assert.deepEqual(module.calls.map(call => call.method), ['available']);
});
test('exact grant object resolves its own token even after a newer grant for the same identity', async () => {
  const { module, tokens, adapter } = await setup();
  const oldGrant = tokens.grant(key(1), 'fixture_older_token_000001');
  const newGrant = tokens.grant(key(1), 'fixture_newer_token_000002');
  let complete: (() => void) | undefined;
  module.pendingDelete = new Promise<void>(resolve => { complete = resolve; });
  const oldRequest = adapter.deleteSecret(key(1), oldGrant);
  assert.deepEqual(module.calls.at(-1), { method: 'deleteSecret', args: [key(1), 'fixture_older_token_000001'] });
  const newRequest = adapter.deleteSecret(key(1), newGrant);
  assert.deepEqual(module.calls.at(-1), { method: 'deleteSecret', args: [key(1), 'fixture_newer_token_000002'] });
  assert.throws(() => adapter.deleteSecret(key(1), oldGrant), hasCode('AUTHORIZATION_DENIED'));
  assert(complete); complete(); await Promise.all([oldRequest, newRequest]);
});
test('unbound, revoked, wrong-target and invalid-token grants fail before bridge deletion', async () => {
  const { module, tokens, adapter } = await setup();
  let unboundChecks = 0;
  const unbound = Object.freeze({ assertActive() { unboundChecks++; } });
  const revoked = Object.freeze({ assertActive() { throw new Error('revoked by owner'); } });
  for (const grant of [unbound, revoked, tokens.grant(key(2)), tokens.grant(key(1), '../unsafe-token'), tokens.grant(key(1), 'x'.repeat(129))]) {
    assert.throws(() => adapter.deleteSecret(key(1), grant), hasCode('AUTHORIZATION_DENIED'));
  }
  assert(!module.calls.some(call => call.method === 'deleteSecret'));
  assert.equal(unboundChecks, 1);
});
test('native late revocation remains a rejection and token cannot be reused', async () => {
  const { module, tokens, adapter } = await setup(); const grant = tokens.grant();
  module.failure = { code: 'ERR_IDENTITY_STORE_UNAUTHORIZED', message: 'private native reason' };
  await assert.rejects(adapter.deleteSecret(key(1), grant), hasCode('AUTHORIZATION_DENIED'));
  assert.throws(() => adapter.deleteSecret(key(1), grant), hasCode('AUTHORIZATION_DENIED'));
  assert.equal(module.calls.filter(call => call.method === 'deleteSecret').length, 1);
});


for (const nativeFailure of [
  { code: 'ERR_IDENTITY_STORE_UNAVAILABLE', message: 'private flush failure' },
  { code: 'ERR_IDENTITY_STORE_CORRUPT', message: 'private native state' },
  new Error('private transport failure'),
]) test('iOS erase uncertainty remains a durable failure even when the file is subsequently absent', async () => {
  const { module, tokens, adapter } = await setup(), grant = tokens.grant();
  module.values.set(key(1), encodeSecret(secret()));
  module.deleteSecretAsync = async (pubkey, nativeToken) => {
    module.record('deleteSecret', pubkey, nativeToken);
    module.values.delete(pubkey);
    throw nativeFailure;
  };
  await assert.rejects(adapter.deleteSecret(key(1), grant), hasCode('READBACK_FAILED'));
  assert.equal(await adapter.readSecret(key(1)), null);
  assert.throws(() => adapter.deleteSecret(key(1), grant), hasCode('AUTHORIZATION_DENIED'));
});
test('iOS failure before erase preserves the record and never retains a native diagnostic', async () => {
  const { module, tokens, adapter } = await setup();
  module.values.set(key(1), encodeSecret(secret()));
  module.deleteSecretAsync = async () => { throw { code: 'ERR_IDENTITY_STORE_UNAVAILABLE', message: 'private storage detail' }; };
  await assert.rejects(adapter.deleteSecret(key(1), tokens.grant()), error =>
    error instanceof VaultError && error.code === 'READBACK_FAILED' && error.message === 'READBACK_FAILED' && !('cause' in error));
  assert.deepEqual(await adapter.readSecret(key(1)), secret());
});
