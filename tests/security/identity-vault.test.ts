import test from 'node:test';
import assert from 'node:assert/strict';
import { IdentityVault, MAX_IDENTITIES, VaultError, type DatabaseRecord, type Inventory, type SecretRecord, type StagedSecret, type VaultDependencies } from '../../src/security/identity-vault.ts';

type Durable = { db: DatabaseRecord | null; inventory: Inventory | null; stage: StagedSecret | null; keys: Map<string, SecretRecord> };
type Checkpoint = { step: string; durable: Durable; generated: number };
const key = (n: number) => (n % 128).toString(16).padStart(2, '0').repeat(32);
const copy = <T>(value: T): T => structuredClone(value);
class Harness {
  durable: Durable;
  calls: string[] = [];
  checkpoints: Checkpoint[] = [];
  generated = 0;
  parsedBuffers: Uint8Array[] = [];
  generatedBuffers: Uint8Array[] = [];
  returnedBuffers: Uint8Array[] = [];
  authCalls = 0;
  authActive = true;
  authPause: Promise<void> | null = null;
  idCounter = 0;
  fault: { name: string; mode: 'before' | 'after' | 'omit'; occurrence: number } | null = null;
  onStep: ((name: string) => void) | null = null;
  constructor(durable?: Durable) { this.durable = durable ? copy(durable) : { db: null, inventory: null, stage: null, keys: new Map() }; }
  async step<T>(name: string, action: () => T, empty?: T): Promise<T> {
    this.calls.push(name);
    let mode: 'before' | 'after' | 'omit' | undefined;
    if (this.fault?.name === name && --this.fault.occurrence === 0) { mode = this.fault.mode; this.fault = null; }
    if (mode === 'before') throw new Error('test-only injected I/O failure');
    const value = mode === 'omit' ? empty as T : action();
    this.checkpoints.push({ step: name, durable: copy(this.durable), generated: this.generated });
    this.onStep?.(name);
    if (mode === 'after') throw new Error('test-only uncertain I/O failure');
    return value;
  }
  ownSecret<T extends SecretRecord | null>(value: T): T {
    const result = copy(value);
    if (result) this.returnedBuffers.push(result.secretKey);
    return result;
  }
  dependencies(): VaultDependencies {
    return {
      database: {
        read: () => this.step('db.read', () => copy(this.durable.db)),
        compareAndSwap: (expected, next) => this.step('db.write', () => {
          assert.equal(this.durable.db?.revision ?? null, expected, 'transactional CAS rejects stale writers');
          this.durable.db = copy(next);
        }),
      },
      secrets: {
        readInventory: () => this.step('inventory.read', () => copy(this.durable.inventory)),
        writeInventory: value => this.step('inventory.write', () => { this.durable.inventory = copy(value); }),
        readStage: () => this.step('stage.read', () => this.ownSecret(this.durable.stage)),
        writeStage: value => this.step('stage.write', () => { this.durable.stage = copy(value); }),
        deleteStage: () => this.step('stage.delete', () => { this.durable.stage = null; }),
        readSecret: pubkey => this.step(`key.read:${pubkey}`, () => this.ownSecret(this.durable.keys.get(pubkey) ?? null)),
        writeSecret: (pubkey, value) => this.step(`key.write:${pubkey}`, () => { this.durable.keys.set(pubkey, copy(value)); }),
        deleteSecret: pubkey => this.step(`key.delete:${pubkey}`, () => { this.durable.keys.delete(pubkey); }),
      },
      generateSecretKey: () => {
        this.generated++;
        const bytes = new Uint8Array(32).fill(1);
        this.generatedBuffers.push(bytes);
        this.checkpoints.push({ step: 'generate', durable: copy(this.durable), generated: this.generated });
        return bytes;
      },
      parseNsec: value => {
        // Deliberately fake fixture encoding. Production must decode real nsec/NIP19.
        const match = /^nsec1fixture-(\d+)$/.exec(value);
        if (!match) throw new Error('Do not echo secret input');
        const bytes = new Uint8Array(32).fill(Number(match[1]));
        this.parsedBuffers.push(bytes);
        return bytes;
      },
      derivePublicKey: bytes => {
        // Deliberately not secp256k1. Zero/255 stand for invalid fixture scalars.
        if (bytes.length !== 32 || bytes[0] === 0 || bytes[0] === 255) throw new Error('bad scalar');
        return key(bytes[0]!);
      },
      newId: () => `fixture_id_${String(++this.idCounter).padStart(8, '0')}`,
      now: () => 1_800_000_000,
      authorizeDeletion: async request => {
        this.authCalls++;
        assert(Object.isFrozen(request));
        if (this.authPause) await this.authPause;
        return { assertActive: () => { if (!this.authActive) throw new Error('native owner revoked authorization'); } };
      },
    };
  }
  vault(): IdentityVault { return new IdentityVault(this.dependencies()); }
  fail(name: string, mode: 'before' | 'after' | 'omit' = 'before', occurrence = 1): void { this.fault = { name, mode, occurrence }; }
  resetTrace(): void { this.calls = []; this.checkpoints = []; }
}
async function established(count = 1) {
  const h = new Harness(), v = h.vault();
  await v.open();
  for (let n = 2; n <= count; n++) await v.importNsec(`nsec1fixture-${n}`);
  h.resetTrace();
  return { h, v };
}
async function errorCode(operation: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(operation, (error: unknown) => error instanceof VaultError && error.code === code);
}
function noSecretsInMetadata(h: Harness): void {
  for (const value of [h.durable.db, h.durable.inventory]) {
    const text = JSON.stringify(value);
    assert(!text.includes('secretKey'));
    assert(!text.includes('nsec'));
    assert(!text.includes('fixture-'));
  }
}

test('creates exactly one durable identity, protected receipt, and empty staging slot', async () => {
  const h = new Harness(), v = h.vault();
  const state = await v.open();
  assert.equal(state.selectedPubkey, key(1));
  assert.equal(h.generated, 1);
  assert.equal(h.durable.stage, null);
  assert.equal(h.durable.db?.pending, null);
  assert.deepEqual(h.durable.db?.inventory, h.durable.inventory);
  assert.equal(h.durable.keys.size, 1);
  assert(h.generatedBuffers[0]?.every(byte => byte === 0));
  assert(h.returnedBuffers.every(bytes => bytes.every(byte => byte === 0)));
  noSecretsInMetadata(h);
});

test('cold reopen reuses exact key without generation', async () => {
  const { h } = await established();
  const before = copy(h.durable.keys);
  assert.equal((await h.vault().open()).selectedPubkey, key(1));
  assert.equal(h.generated, 1);
  assert.deepEqual(h.durable.keys, before);
});

for (const read of ['db.read', 'inventory.read', 'stage.read']) {
  test(`initial ${read} failure never generates or writes`, async () => {
    const h = new Harness(); h.fail(read);
    await errorCode(h.vault().open(), 'STORAGE_FAILURE');
    assert.equal(h.generated, 0);
    assert(!h.calls.some(name => name.includes('write')));
  });
}

test('unavailable RNG leaves initialization marker and never silently retries with a replacement', async () => {
  const h = new Harness();
  const deps = h.dependencies(); deps.generateSecretKey = () => { throw new Error('native crypto unavailable'); };
  await errorCode(new IdentityVault(deps).open(), 'STORAGE_FAILURE');
  await errorCode(h.vault().open(), 'RECOVERY_REQUIRED');
  assert.equal(h.generated, 0);
  assert.equal(h.durable.keys.size, 0);
});

test('invalid generated scalar is rejected and cannot enter ready state', async () => {
  const h = new Harness(), deps = h.dependencies();
  deps.generateSecretKey = () => new Uint8Array(32);
  await errorCode(new IdentityVault(deps).open(), 'INVALID_SECRET');
  assert.equal(h.durable.db?.inventory.initialized, false);
  assert.equal(h.durable.keys.size, 0);
});

for (const mutate of ['missing-key', 'wrong-pubkey', 'bad-scalar', 'missing-receipt', 'corrupt-receipt', 'mismatched-receipt'] as const) {
  test(`established ${mutate} fails closed without replacement`, async () => {
    const { h } = await established();
    if (mutate === 'missing-key') h.durable.keys.delete(key(1));
    if (mutate === 'wrong-pubkey') h.durable.keys.get(key(1))!.pubkey = key(2);
    if (mutate === 'bad-scalar') h.durable.keys.get(key(1))!.secretKey.fill(0);
    if (mutate === 'missing-receipt') h.durable.inventory = null;
    if (mutate === 'corrupt-receipt') h.durable.inventory = { bad: true } as unknown as Inventory;
    if (mutate === 'mismatched-receipt') h.durable.inventory = { ...h.durable.inventory!, vaultId: 'different_vault_identifier' };
    const before = copy(h.durable);
    await assert.rejects(h.vault().open(), VaultError);
    assert.equal(h.generated, 1);
    assert.deepEqual(h.durable, before);
  });
}

test('a missing inactive saved key is recovery failure, not silent deletion from inventory', async () => {
  const { h } = await established(2);
  h.durable.keys.delete(key(1));
  await errorCode(h.vault().open(), 'RECOVERY_REQUIRED');
  assert.equal(h.durable.inventory?.identities.length, 2);
  assert.equal(h.generated, 1);
});

test('iOS-style surviving Keychain inventory with missing SQLite requires explicit recovery', async () => {
  const { h } = await established(2); h.durable.db = null;
  const before = copy(h.durable);
  await errorCode(h.vault().open(), 'RECOVERY_REQUIRED');
  assert.deepEqual(h.durable, before);
  const recovered = await h.vault().recoverMissingDatabase();
  assert.equal(recovered.selectedPubkey, key(2));
  assert.equal(recovered.identities.length, 2);
  assert.equal(h.generated, 1);
  assert.deepEqual(h.durable.keys, before.keys);
});

test('explicit missing-DB recovery never replaces a missing secret', async () => {
  const { h } = await established(2); h.durable.db = null; h.durable.keys.delete(key(1));
  await errorCode(h.vault().recoverMissingDatabase(), 'RECOVERY_REQUIRED');
  assert.equal(h.durable.db, null);
  assert.equal(h.generated, 1);
});

test('orphan fixed staging slot prevents fresh bootstrap even with both metadata stores absent', async () => {
  const h = new Harness();
  h.durable.stage = { schema: 1, pubkey: key(2), secretKey: new Uint8Array(32).fill(2), vaultId: 'orphan_vault_identifier', kind: 'initialize', addedAt: 0 };
  await errorCode(h.vault().open(), 'RECOVERY_REQUIRED');
  assert.equal(h.generated, 0);
  assert.equal(h.durable.db, null);
});

for (const input of ['npub1fixture-2', key(2), 'nsec1invalid-secret-do-not-echo', 'nsec1fixture-0', 'nsec1fixture-255']) {
  test(`invalid import ${input.slice(0, 12)} preserves current usable identity`, async () => {
    const { h, v } = await established(); const before = copy(h.durable);
    await assert.rejects(v.importNsec(input), (error: unknown) => error instanceof VaultError && error.code === 'INVALID_NSEC' && !error.message.includes(input));
    assert.equal(v.getSnapshot().selectedPubkey, key(1));
    assert.deepEqual(h.durable, before);
  });
}

test('import trims input, preserves original identity, and selects verified imported key', async () => {
  const { h, v } = await established();
  const original = copy(h.durable.keys.get(key(1)));
  const imported = await v.importNsec('  nsec1fixture-2\n');
  assert.equal(imported.selectedPubkey, key(2));
  assert.equal(imported.identities.length, 2);
  assert.deepEqual(h.durable.keys.get(key(1)), original);
  assert(h.parsedBuffers.every(bytes => bytes.every(byte => byte === 0)));
  noSecretsInMetadata(h);
});

test('duplicate x-only pubkey import selects existing envelope without overwriting it', async () => {
  const { h, v } = await established(2);
  const original = copy(h.durable.keys.get(key(1)));
  await v.importNsec('nsec1fixture-129');
  assert.equal(v.getSnapshot().selectedPubkey, key(1));
  assert.equal(v.getSnapshot().identities.length, 2);
  assert.deepEqual(h.durable.keys.get(key(1)), original);
  assert(!h.calls.includes(`key.write:${key(1)}`));
});

test('duplicate import cannot repair or overwrite an established missing key', async () => {
  const { h, v } = await established(); h.durable.keys.delete(key(1));
  await errorCode(v.importNsec('nsec1fixture-1'), 'RECOVERY_REQUIRED');
  assert(!h.calls.includes(`key.write:${key(1)}`));
});

test('identity limit is explicit and preserves every previous record', async () => {
  const { h, v } = await established(MAX_IDENTITIES);
  const before = copy(h.durable);
  await errorCode(v.importNsec(`nsec1fixture-${MAX_IDENTITIES + 1}`), 'LIMIT_REACHED');
  assert.deepEqual(h.durable, before);
});

test('exposed snapshots are frozen and cannot mutate vault ownership', async () => {
  const { v } = await established(); const view = v.getSnapshot();
  assert(Object.isFrozen(view)); assert(Object.isFrozen(view.identities)); assert(Object.isFrozen(view.identities[0]));
  assert.throws(() => { (view as { selectedPubkey: string }).selectedPubkey = key(9); }, TypeError);
  assert.equal(v.getSnapshot().selectedPubkey, key(1));
});

test('selection verifies destination and rejects unknown identities without writes', async () => {
  const { h, v } = await established(2);
  await errorCode(v.select(key(3)), 'NOT_FOUND');
  assert(!h.calls.includes('db.write'));
  h.durable.keys.delete(key(1));
  await errorCode(v.select(key(1)), 'RECOVERY_REQUIRED');
  assert.equal(h.durable.db?.inventory.selectedPubkey, key(2));
});

for (const action of ['db.write', 'inventory.write']) {
  test(`selection ${action} omitted write preserves prior selection on recovery`, async () => {
    const { h, v } = await established(2); h.fail(action, 'omit');
    await errorCode(v.select(key(1)), 'READBACK_FAILED');
    assert.equal((await h.vault().open()).selectedPubkey, key(2));
  });
}

test('a mutation throwing after it committed is recognized through readback', async () => {
  const { h, v } = await established(2); h.fail('inventory.write', 'after');
  assert.equal((await v.select(key(1))).selectedPubkey, key(1));
  assert.deepEqual(h.durable.inventory, h.durable.db?.inventory);
});

test('unreadable commit result closes the vault until authoritative reopen', async () => {
  const { h, v } = await established(2);
  h.onStep = name => { if (name === 'inventory.write') { h.fail('inventory.read'); h.onStep = null; } };
  await errorCode(v.select(key(1)), 'STORAGE_FAILURE');
  assert.throws(() => v.getSnapshot(), { code: 'NOT_READY' });
  assert.equal((await h.vault().open()).selectedPubkey, key(2));
});

test('deletion refuses selected or final identity before asking for authentication', async () => {
  const { h, v } = await established();
  await errorCode(v.deleteIdentity(key(1)), 'DELETE_SELECTED');
  assert.equal(h.authCalls, 0); assert(h.durable.keys.has(key(1)));
});

test('failed or revoked device authentication leaves all records untouched', async () => {
  const { h, v } = await established(2); const before = copy(h.durable); h.authActive = false;
  await errorCode(v.deleteIdentity(key(1)), 'AUTHORIZATION_DENIED');
  assert.deepEqual(h.durable, before);
});

test('late auth result is rechecked and does not erase after UI ownership revocation', async () => {
  const { h, v } = await established(2);
  let release!: () => void; h.authPause = new Promise(resolve => { release = resolve; });
  const operation = v.deleteIdentity(key(1));
  await new Promise(resolve => setImmediate(resolve));
  h.authActive = false; release();
  await errorCode(operation, 'AUTHORIZATION_DENIED');
  assert(h.durable.keys.has(key(1))); assert.equal(h.durable.db?.pending, null);
});

test('native prompt transient inactive is not itself interpreted as revocation by platform-neutral core', async () => {
  const { h, v } = await established(2);
  // The native authorizer owns whether a lifecycle transition revoked the prompt.
  h.authActive = true;
  assert.equal((await v.deleteIdentity(key(1))).selectedPubkey, key(2));
  assert.equal(h.authCalls, 1);
});

test('revocation after durable tombstone requires new authentication before erase', async () => {
  const { h, v } = await established(2);
  h.onStep = name => { if (name === 'db.write') { h.authActive = false; h.onStep = null; } };
  await errorCode(v.deleteIdentity(key(1)), 'AUTHORIZATION_DENIED');
  assert.equal(v.getSnapshot().pendingDeletion, key(1));
  assert(h.durable.keys.has(key(1)));
  const reopened = h.vault();
  assert.equal((await reopened.open()).pendingDeletion, key(1));
  assert(h.durable.keys.has(key(1)));
  h.authActive = true;
  await reopened.deleteIdentity(key(1));
  assert.equal(h.authCalls, 2); assert(!h.durable.keys.has(key(1)));
});

test('silent OS deletion failure leaves a tombstone and cannot report completion', async () => {
  const { h, v } = await established(2); h.fail(`key.delete:${key(1)}`, 'omit');
  await errorCode(v.deleteIdentity(key(1)), 'READBACK_FAILED');
  const after = await h.vault().open();
  assert.equal(after.pendingDeletion, key(1)); assert.equal(after.selectedPubkey, key(2));
  assert(h.durable.keys.has(key(1))); assert.equal(h.authCalls, 1);
});

test('pending deletion blocks import and selection but retains the selected identity', async () => {
  const { h, v } = await established(2); h.fail(`key.delete:${key(1)}`, 'omit');
  await errorCode(v.deleteIdentity(key(1)), 'READBACK_FAILED');
  const next = h.vault(); await next.open();
  await errorCode(next.importNsec('nsec1fixture-3'), 'PENDING_DELETION');
  await errorCode(next.select(key(1)), 'PENDING_DELETION');
  assert.equal(next.getSnapshot().selectedPubkey, key(2));
});

test('serialized imports cannot overwrite each other or bypass the journal', async () => {
  const { h, v } = await established();
  await Promise.all([v.importNsec('nsec1fixture-2'), v.importNsec('nsec1fixture-3')]);
  assert.deepEqual(v.getSnapshot().identities.map(i => i.pubkey), [key(1), key(2), key(3)]);
  assert.equal(v.getSnapshot().selectedPubkey, key(3)); assert.equal(h.durable.db?.pending, null);
});

test('CAS conflict is not treated as successful persistence', async () => {
  const { h, v } = await established(2);
  h.durable.db = { ...h.durable.db!, revision: h.durable.db!.revision + 10 };
  const before = copy(h.durable.inventory);
  await errorCode(v.select(key(1)), 'READBACK_FAILED');
  assert.deepEqual(h.durable.inventory, before);
});

for (const seam of ['stage.write', `key.write:${key(1)}`, 'stage.delete']) {
  test(`initialization validates ${seam} by readback`, async () => {
    const h = new Harness(); h.fail(seam, 'omit');
    await errorCode(h.vault().open(), 'READBACK_FAILED');
    assert.equal(h.generated, 1);
    const next = h.vault();
    if (seam === 'stage.write') await errorCode(next.open(), 'RECOVERY_REQUIRED');
    else assert.equal((await next.open()).selectedPubkey, key(1));
    assert.equal(h.generated, 1);
  });
}

test('all initialization durability checkpoints recover exact staged key or fail without new generation', async t => {
  const original = new Harness(); await original.vault().open();
  for (const [index, cut] of original.checkpoints.entries()) await t.test(`${index}:${cut.step}`, async () => {
    const h = new Harness(cut.durable); h.generated = cut.generated;
    const initialCount = h.generated;
    const hasDurableMarker = Boolean(h.durable.db || h.durable.inventory || h.durable.stage);
    try {
      const result = await h.vault().open(); assert.equal(result.selectedPubkey, key(1));
      assert.equal(h.durable.keys.size, 1);
    } catch (error) {
      assert(error instanceof VaultError && error.code === 'RECOVERY_REQUIRED');
      assert(h.durable.db?.pending?.kind === 'initialize');
    }
    if (hasDurableMarker) assert.equal(h.generated, initialCount);
    noSecretsInMetadata(h);
  });
});

test('all import durability checkpoints preserve old identity and recover staged imports unselected', async t => {
  const { h: original, v } = await established(); await v.importNsec('nsec1fixture-2');
  for (const [index, cut] of original.checkpoints.entries()) await t.test(`${index}:${cut.step}`, async () => {
    const h = new Harness(cut.durable);
    const wasCommitted = cut.durable.db?.pending === null && cut.durable.db.inventory.identities.some(i => i.pubkey === key(2));
    const next = await h.vault().open();
    assert.equal(next.selectedPubkey, wasCommitted ? key(2) : key(1));
    assert(next.identities.some(i => i.pubkey === key(1))); assert(h.durable.keys.has(key(1)));
    if (cut.durable.stage) assert(next.identities.some(i => i.pubkey === key(2)));
    assert.equal(h.generated, 0); noSecretsInMetadata(h);
  });
});

test('all selection durability checkpoints retain old selection until the DB commit', async t => {
  const { h: original, v } = await established(2); await v.select(key(1));
  for (const [index, cut] of original.checkpoints.entries()) await t.test(`${index}:${cut.step}`, async () => {
    const h = new Harness(cut.durable);
    const wasCommitted = cut.durable.db?.pending === null && cut.durable.db.inventory.selectedPubkey === key(1);
    const result = await h.vault().open();
    assert.equal(result.selectedPubkey, wasCommitted ? key(1) : key(2));
    assert.equal(result.identities.length, 2); assert.equal(h.generated, 0);
  });
});

test('all deletion durability checkpoints preserve replacement and never auto-erase surviving tombstoned key', async t => {
  const { h: original, v } = await established(2); await v.deleteIdentity(key(1));
  for (const [index, cut] of original.checkpoints.entries()) await t.test(`${index}:${cut.step}`, async () => {
    const h = new Harness(cut.durable), keySurvived = cut.durable.keys.has(key(1));
    const result = await h.vault().open();
    assert.equal(result.selectedPubkey, key(2)); assert(h.durable.keys.has(key(2)));
    assert.equal(h.durable.keys.has(key(1)), keySurvived);
    assert.equal(h.authCalls, 0); assert.equal(h.generated, 0);
    assert(!h.calls.includes(`key.delete:${key(1)}`));
  });
});

test('selection recovery is itself restartable at every durable checkpoint', async t => {
  const { h: seed, v } = await established(2);
  seed.fail('db.write', 'omit', 2);
  await errorCode(v.select(key(1)), 'READBACK_FAILED');
  const baseline = copy(seed.durable);
  const recovering = new Harness(baseline); await recovering.vault().open();
  for (const [index, cut] of recovering.checkpoints.entries()) await t.test(`${index}:${cut.step}`, async () => {
    const h = new Harness(cut.durable);
    assert.equal((await h.vault().open()).selectedPubkey, key(2));
    assert.equal(h.generated, 0);
  });
});

test('import recovery is itself restartable at every durable checkpoint', async t => {
  const { h: seed, v } = await established();
  seed.fail('db.write', 'omit', 2);
  await errorCode(v.importNsec('nsec1fixture-2'), 'READBACK_FAILED');
  const recovering = new Harness(seed.durable); await recovering.vault().open();
  for (const [index, cut] of recovering.checkpoints.entries()) await t.test(`${index}:${cut.step}`, async () => {
    const h = new Harness(cut.durable), result = await h.vault().open();
    assert.equal(result.selectedPubkey, key(1)); assert.equal(result.identities.length, 2);
    assert.equal(h.generated, 0);
  });
});

test('explicit missing-DB recovery retains a discoverable staged import without selecting it', async () => {
  const { h, v } = await established();
  h.fail(`key.write:${key(2)}`, 'omit');
  await errorCode(v.importNsec('nsec1fixture-2'), 'READBACK_FAILED');
  h.durable.db = null;
  const recovery = h.vault();
  await errorCode(recovery.open(), 'RECOVERY_REQUIRED');
  const state = await recovery.recoverMissingDatabase();
  assert.equal(state.selectedPubkey, key(1)); assert.equal(state.identities.length, 2);
  assert(h.durable.keys.has(key(2))); assert.equal(h.generated, 1);
});

test('metadata final commit with unreadable readback reports uncertainty, then reopens the committed selection', async () => {
  const { h, v } = await established(2);
  let writes = 0;
  h.onStep = name => { if (name === 'db.write' && ++writes === 2) { h.fail('db.read'); h.onStep = null; } };
  await errorCode(v.select(key(1)), 'STORAGE_FAILURE');
  assert.throws(() => v.getSnapshot(), { code: 'NOT_READY' });
  assert.equal((await h.vault().open()).selectedPubkey, key(1));
});

test('initialized metadata corruption never causes fresh initialization', async () => {
  const { h } = await established();
  h.durable.db = { ...h.durable.db!, inventory: { ...h.durable.db!.inventory, identities: [] } };
  await errorCode(h.vault().open(), 'CORRUPT_METADATA');
  assert.equal(h.generated, 1); assert.equal(h.durable.keys.size, 1);
});

test('read failures still clear a concurrently returned stage buffer', async () => {
  const { h, v } = await established();
  h.fail(`key.write:${key(2)}`, 'omit');
  await errorCode(v.importNsec('nsec1fixture-2'), 'READBACK_FAILED');
  h.returnedBuffers = [];
  h.fail('db.read');
  await errorCode(h.vault().open(), 'STORAGE_FAILURE');
  assert(h.returnedBuffers.length > 0);
  assert(h.returnedBuffers.every(bytes => bytes.every(byte => byte === 0)));
});

test('malformed fixed staging record is rejected and its returned secret buffer cleared', async () => {
  const { h } = await established();
  h.durable.stage = { schema: 1, pubkey: key(2), secretKey: new Uint8Array(32).fill(2), vaultId: 'wrong', kind: 'import', addedAt: 0 };
  h.returnedBuffers = [];
  await errorCode(h.vault().open(), 'INVALID_SECRET');
  assert(h.returnedBuffers.every(bytes => bytes.every(byte => byte === 0)));
});

test('failed initialization secret readback cannot be treated as a missing identity and replaced', async () => {
  const h = new Harness();
  h.onStep = name => { if (name === `key.write:${key(1)}`) { h.fail(`key.read:${key(1)}`); h.onStep = null; } };
  await errorCode(h.vault().open(), 'STORAGE_FAILURE');
  assert.equal(h.generated, 1);
  assert.equal((await h.vault().open()).selectedPubkey, key(1));
  assert.equal(h.generated, 1);
});

test('deletion passes the exact authorization result across the journal await even if a newer grant exists', async () => {
  const { h } = await established(2);
  const dependencies = h.dependencies();
  let oldChecks = 0, newChecks = 0;
  const originalGrant = Object.freeze({ assertActive: () => { oldChecks++; } });
  const newerGrant = Object.freeze({ assertActive: () => { newChecks++; } });
  let latestGrant = originalGrant;
  dependencies.authorizeDeletion = async () => originalGrant;
  const originalDelete = dependencies.secrets.deleteSecret;
  let received: unknown;
  dependencies.secrets.deleteSecret = async (pubkey, grant) => {
    received = grant;
    assert.equal(latestGrant, newerGrant, 'a newer grant appeared while the journal awaited');
    assert.equal(grant, originalGrant, 'effect carries its original grant, never a mutable latest lookup');
    await originalDelete(pubkey, grant);
  };
  const vault = new IdentityVault(dependencies); await vault.open();
  h.onStep = name => { if (name === 'db.write' && h.durable.db?.pending?.kind === 'delete') latestGrant = newerGrant; };
  await vault.deleteIdentity(key(1));
  assert.equal(received, originalGrant); assert.equal(oldChecks, 2); assert.equal(newChecks, 0);
});

test('a revoked original grant cannot be replaced by a newer same-target grant during journaling', async () => {
  const { h } = await established(2), dependencies = h.dependencies();
  let revoked = false, newerChecks = 0;
  const originalGrant = Object.freeze({ assertActive: () => { if (revoked) throw new Error('original grant revoked'); } });
  const newerGrant = Object.freeze({ assertActive: () => { newerChecks++; } });
  let latestGrant = originalGrant;
  dependencies.authorizeDeletion = async () => originalGrant;
  const vault = new IdentityVault(dependencies); await vault.open();
  h.onStep = name => {
    if (name === 'db.write' && h.durable.db?.pending?.kind === 'delete') { revoked = true; latestGrant = newerGrant; }
  };
  await errorCode(vault.deleteIdentity(key(1)), 'AUTHORIZATION_DENIED');
  assert.equal(latestGrant, newerGrant); assert.equal(newerChecks, 0);
  assert(h.durable.keys.has(key(1)));
  assert(!h.calls.some(name => name.startsWith('key.delete:')));
});


test('failed key verification drains other reads and wipes their buffers before releasing the vault', async () => {
  const { h } = await established(2);
  const durable = copy(h.durable);
  const dependencies = h.dependencies();
  const originalRead = dependencies.secrets.readSecret;
  const returnedBefore = h.returnedBuffers.length;
  let resolveStarted!: () => void;
  let resolveRelease!: () => void;
  const started = new Promise<void>(resolve => { resolveStarted = resolve; });
  const release = new Promise<void>(resolve => { resolveRelease = resolve; });
  dependencies.secrets.readSecret = async pubkey => {
    if (pubkey === key(1)) throw new Error('test read failure');
    resolveStarted();
    await release;
    return originalRead(pubkey);
  };
  const vault = new IdentityVault(dependencies);
  let settled = false;
  const opening = vault.open();
  void opening.then(() => { settled = true; }, () => { settled = true; });
  await started;
  let queuedSettled = false;
  const queued = vault.importNsec('nsec1fixture-3');
  void queued.then(() => { queuedSettled = true; }, () => { queuedSettled = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(queuedSettled, false);
  assert.deepEqual(h.durable, durable);
  resolveRelease();
  await errorCode(opening, 'STORAGE_FAILURE');
  await errorCode(queued, 'NOT_READY');
  assert.equal(h.returnedBuffers.length, returnedBefore + 1);
  assert(h.returnedBuffers.every(bytes => bytes.every(byte => byte === 0)));
  assert.deepEqual(h.durable, durable);
  assert.equal(h.generated, 1);
});


test('native revocation before erase preserves a retryable journal when the key remains', async () => {
  const { h } = await established(2), deps = h.dependencies();
  deps.secrets.deleteSecret = async () => { throw new VaultError('AUTHORIZATION_DENIED'); };
  const vault = new IdentityVault(deps); await vault.open();
  await errorCode(vault.deleteIdentity(key(1)), 'AUTHORIZATION_DENIED');
  assert.equal(vault.getSnapshot().pendingDeletion, key(1));
  assert(h.durable.keys.has(key(1)));
  deps.secrets.deleteSecret = h.dependencies().secrets.deleteSecret;
  assert.equal((await vault.deleteIdentity(key(1))).identities.length, 1);
});
test('native durable-erase failure cannot become success through an in-memory absence readback', async () => {
  const { h } = await established(2), deps = h.dependencies();
  deps.secrets.deleteSecret = async pubkey => { h.durable.keys.delete(pubkey); throw new VaultError('READBACK_FAILED'); };
  const vault = new IdentityVault(deps); await vault.open();
  await errorCode(vault.deleteIdentity(key(1)), 'READBACK_FAILED');
  assert.throws(() => vault.getSnapshot(), { code: 'NOT_READY' });
  assert.equal(h.durable.db?.pending?.kind, 'delete');
  assert.equal(h.durable.inventory?.identities.length, 2);
});
test('native denial with an unexpectedly absent key enters recovery', async () => {
  const { h } = await established(2), deps = h.dependencies();
  deps.secrets.deleteSecret = async pubkey => { h.durable.keys.delete(pubkey); throw new VaultError('AUTHORIZATION_DENIED'); };
  const vault = new IdentityVault(deps); await vault.open();
  await errorCode(vault.deleteIdentity(key(1)), 'READBACK_FAILED');
  assert.throws(() => vault.getSnapshot(), { code: 'NOT_READY' });
});
