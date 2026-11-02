import test from 'node:test';
import assert from 'node:assert/strict';
import { openIdentityMetadata, type SQLiteModule } from '../../src/security/identity-metadata.ts';
import { encodeDatabase } from '../../src/security/identity-codec.ts';
import { type DatabaseRecord } from '../../src/security/identity-vault.ts';
import { SqliteFake, pubkey, TEST_ID } from './harness.ts';

const record = (): DatabaseRecord => ({ revision: 0, inventory: { schema: 1, vaultId: TEST_ID, revision: 1, initialized: true, selectedPubkey: pubkey(1), identities: [{ pubkey: pubkey(1), addedAt: 42, origin: 'generated' }] }, pending: null });
const INSERT = 'run:INSERT INTO vault_metadata (singleton, revision, payload) VALUES (1, ?, ?)';
const SELECT = 'all:SELECT singleton, revision, payload FROM vault_metadata';

for (const platform of ['android', 'ios'] as const) test(`${platform}: real SQLite schema, durability settings, prepared CAS and restart`, async t => {
  const native = new SqliteFake(); t.after(() => native.cleanup());
  const adapter = await openIdentityMetadata(native, platform);
  assert.equal(await adapter.read(), null);
  assert.deepEqual(native.openOptions, [{ useNewConnection: true, enableChangeListener: false }]);
  assert(native.calls.includes('exec:PRAGMA synchronous = FULL'));
  assert.equal(native.calls.includes('exec:PRAGMA fullfsync = ON'), platform === 'ios');
  const next = record(); await adapter.compareAndSwap(null, next);
  assert.deepEqual(await adapter.read(), next);
  await assert.rejects(adapter.compareAndSwap(null, next), { code: 'READBACK_FAILED' });
  const changed = { ...next, revision: 1 }; await adapter.compareAndSwap(0, changed);
  const writes = native.statements.filter(statement => statement.params.length);
  assert(writes.every(statement => statement.sql.includes('?') && !statement.sql.includes(TEST_ID)));
  assert(writes.every(statement => !JSON.stringify(statement.params).includes('secretKey')));
  await adapter.close();
  const reopened = await openIdentityMetadata(native, platform);
  assert.deepEqual(await reopened.read(), changed);
});
test('CAS snapshots metadata before queue execution and caller mutation cannot alter stored inventory', async t => {
  const native = new SqliteFake(); t.after(() => native.cleanup());
  const adapter = await openIdentityMetadata(native, 'ios');
  const input = structuredClone(record()), original = structuredClone(input);
  const writing = adapter.compareAndSwap(null, input);
  (input as { revision: number }).revision = 9;
  (input.inventory.identities[0] as { addedAt: number }).addedAt = 100;
  await writing; assert.deepEqual(await adapter.read(), original);
});
test('two queued competing writers cannot both replace the same revision', async t => {
  const native = new SqliteFake(); t.after(() => native.cleanup());
  const adapter = await openIdentityMetadata(native, 'ios'); await adapter.compareAndSwap(null, record());
  const first = { ...record(), revision: 1 };
  const second = { ...first, inventory: { ...first.inventory, revision: 2 } };
  const results = await Promise.allSettled([adapter.compareAndSwap(0, first), adapter.compareAndSwap(0, second)]);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected']);
  assert.deepEqual(await adapter.read(), first);
});
test('separate connections enforce CAS against persisted revision, not a cached JS copy', async t => {
  const native = new SqliteFake(); t.after(() => native.cleanup());
  const a = await openIdentityMetadata(native, 'ios'), b = await openIdentityMetadata(native, 'ios');
  await a.compareAndSwap(null, record());
  await assert.rejects(b.compareAndSwap(null, record()), { code: 'READBACK_FAILED' });
  await b.compareAndSwap(0, { ...record(), revision: 1 });
  await assert.rejects(a.compareAndSwap(0, { ...record(), revision: 1 }), { code: 'READBACK_FAILED' });
});
for (const setup of ['PRAGMA user_version = 7', 'CREATE TABLE foreign_state (secret TEXT)', 'PRAGMA user_version = 1']) test(`unknown/incomplete schema fails without reset (${setup})`, async t => {
  const native = new SqliteFake(); t.after(() => native.cleanup());
  const raw = native.raw(); raw.exec(setup);
  await assert.rejects(openIdentityMetadata(native, 'ios'), { code: 'CORRUPT_METADATA' });
  assert(!native.statements.some(statement => /DROP|DELETE FROM|REPLACE INTO/.test(statement.sql)));
});
for (const mode of ['before', 'after', 'omit'] as const) test(`SQL row-write ${mode} failure rolls back completely`, async t => {
  const native = new SqliteFake(); t.after(() => native.cleanup()); const adapter = await openIdentityMetadata(native, 'ios');
  native.fault = { match: INSERT, mode };
  await assert.rejects(adapter.compareAndSwap(null, record()));
  assert.equal(await adapter.read(), null);
  await adapter.compareAndSwap(null, record()); assert.deepEqual(await adapter.read(), record());
});
for (const mode of ['before', 'after'] as const) test(`COMMIT ${mode} rejection preserves authoritative readback`, async t => {
  const native = new SqliteFake(); t.after(() => native.cleanup()); const adapter = await openIdentityMetadata(native, 'ios');
  native.fault = { match: 'exec:COMMIT', mode };
  await assert.rejects(adapter.compareAndSwap(null, record()), { code: 'STORAGE_FAILURE' });
  assert.deepEqual(await adapter.read(), mode === 'after' ? record() : null);
});
for (const failure of ['inTransaction', 'exec:ROLLBACK']) test(`failed ${failure} poisons connection; it cannot return uncommitted data`, async t => {
  const native = new SqliteFake(); t.after(() => native.cleanup()); const adapter = await openIdentityMetadata(native, 'ios');
  native.fault = { match: INSERT, mode: 'after' };
  native.failures = [{ match: failure, mode: 'before' }];
  await assert.rejects(adapter.compareAndSwap(null, record()));
  await assert.rejects(adapter.read(), { code: 'STORAGE_FAILURE' });
  native.failures = [];
  const recovered = await openIdentityMetadata(native, 'ios'); assert.equal(await recovered.read(), null);
});
test('corrupt payload or SQL revision mismatch fails; no implicit erase or reinitialization', async t => {
  const native = new SqliteFake(); t.after(() => native.cleanup()); const adapter = await openIdentityMetadata(native, 'ios');
  await adapter.compareAndSwap(null, record()); const raw = native.raw();
  raw.prepare('UPDATE vault_metadata SET revision = ?').run(90);
  await assert.rejects(adapter.read(), { code: 'CORRUPT_METADATA' });
  raw.prepare('UPDATE vault_metadata SET revision = 0, payload = ?').run('{"secret":"should not load"}');
  await assert.rejects(adapter.read(), { code: 'CORRUPT_METADATA' });
});
test('unsafe revision or injected secret metadata never reaches SQL', async t => {
  const native = new SqliteFake(); t.after(() => native.cleanup()); const adapter = await openIdentityMetadata(native, 'ios'); native.statements = [];
  assert.throws(() => adapter.compareAndSwap(null, { ...record(), secretKey: 'leak' } as DatabaseRecord));
  assert.throws(() => adapter.compareAndSwap(Number.MAX_SAFE_INTEGER, record()));
  assert.throws(() => adapter.compareAndSwap(0, record()));
  assert.deepEqual(native.statements, []);
});
test('open failure and missing WAL support fail without creating identity metadata', async t => {
  const native = new SqliteFake(); t.after(() => native.cleanup()); native.fault = { match: 'open', mode: 'before' };
  await assert.rejects(openIdentityMetadata(native, 'ios'), { code: 'STORAGE_FAILURE' });
  native.fault = { match: 'all:PRAGMA journal_mode = WAL', mode: 'omit' };
  await assert.rejects(openIdentityMetadata(native, 'ios'), { code: 'STORAGE_FAILURE' });
  assert(!native.calls.includes(INSERT));
});
test('read failure rejects rather than returning absent, and close never wipes the persisted record', async t => {
  const native = new SqliteFake(); t.after(() => native.cleanup()); const adapter = await openIdentityMetadata(native, 'ios');
  await adapter.compareAndSwap(null, record()); native.fault = { match: SELECT, mode: 'before' };
  await assert.rejects(adapter.read(), { code: 'STORAGE_FAILURE' });
  await adapter.close(); await assert.rejects(adapter.read(), { code: 'STORAGE_FAILURE' });
  assert.equal(native.raw().prepare('SELECT payload FROM vault_metadata').get()!.payload, encodeDatabase(record()));
});
test('unsupported platforms cannot open a database', async () => {
  const module: SQLiteModule = { openDatabaseAsync: async () => { throw new Error('must never be reached'); } };
  await assert.rejects(openIdentityMetadata(module, 'web' as 'ios'), { code: 'STORAGE_FAILURE' });
});
