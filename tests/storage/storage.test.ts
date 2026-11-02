import test from 'node:test';
import assert from 'node:assert/strict';
import { openShellDatabase } from '../../src/storage/database.ts';
import { LIMITS, type Scope, type TrustedRegistration } from '../../src/storage/ports.ts';
import { assertCode, deferred, hex, registration, setup } from './harness.ts';

test('one private fixed connection, durable platform pragmas and prepared opaque keys survive reopening', async t => {
  const { sqlite, database } = await setup(t);
  const store = database.bindStorage(registration()).port;
  const key = "instance::other\u0000' OR 1=1; --💫";
  await store.set(key, '值\u0000tail💫');
  assert.equal(await store.get(key), '值\u0000tail💫');
  assert.deepEqual(await store.keys(), [key]);
  assert.equal(sqlite.openOptions.length, 1);
  assert.deepEqual(sqlite.openOptions[0], { useNewConnection: true, enableChangeListener: false });
  for (const sql of ['PRAGMA synchronous = FULL', 'PRAGMA foreign_keys = ON', 'PRAGMA fullfsync = ON', 'PRAGMA checkpoint_fullfsync = ON']) assert(sqlite.calls.some(call => call.sql === sql));
  assert(sqlite.calls.every(call => !call.sql.includes(key)));
  await database.close();
  const restored = await openShellDatabase(sqlite, 'android');
  assert.equal(await restored.bindStorage(registration()).port.get(key), '值\u0000tail💫');
});

test('full user/publisher/app/version/scope/instance crossproduct has no namespace bleed', async t => {
  const { database } = await setup(t, 'android');
  const cases: { registration: TrustedRegistration; value: string }[] = [];
  for (const user of [hex(1), hex(11)]) for (const publisher of [hex(2), hex(12)]) for (const appId of ['app', 'app::instance']) for (const version of [hex(3), hex(13)]) {
    const common = { user, publisher, appId, version }, expected = JSON.stringify(common);
    for (const instanceId of ['one', 'two']) {
      const owner = registration({ ...common, instanceId });
      const port = database.bindStorage(owner).port;
      assert.equal(await port.get('key', 'instance'), null);
      await port.set('key', expected + instanceId, 'instance');
      await port.set('key', expected, 'shared');
      cases.push({ registration: owner, value: expected });
    }
  }
  for (const item of cases) {
    const port = database.bindStorage(item.registration).port;
    assert.equal(await port.get('key'), item.value);
    assert.equal(await port.get('key', 'instance'), item.value + item.registration.instanceId);
    assert.deepEqual(await port.keys(), ['key']);
  }
});

test('trusted registration is snapshotted and guest port has no owner or SQL selector', async t => {
  const { database } = await setup(t);
  const supplied = { ...registration() };
  const { port } = database.bindStorage(supplied);
  supplied.user = hex(9); supplied.publisher = hex(9); supplied.appId = 'changed'; supplied.version = hex(9); supplied.instanceId = 'changed';
  await port.set('user::publisher::app::version::instance::key', 'original');
  assert.deepEqual(Object.keys(port).sort(), ['get', 'keys', 'remove', 'set']);
  assert.equal(await database.bindStorage(registration()).port.get('user::publisher::app::version::instance::key'), 'original');
  assert.equal(await database.bindStorage(supplied).port.get('user::publisher::app::version::instance::key'), null);
  assert.throws(() => port.get('key', 'other' as Scope), assertCode('INVALID_INPUT'));
});

test('missing, empty string and removed values stay distinct, including restart and closed sessions', async t => {
  const { sqlite, database } = await setup(t);
  const binding = database.bindStorage(registration());
  assert.equal(await binding.port.get('empty'), null);
  await binding.port.set('empty', '');
  assert.equal(await binding.port.get('empty'), '');
  binding.revoke();
  await assert.rejects(binding.port.get('empty'), assertCode('REVOKED'));
  await database.close();
  const next = await openShellDatabase(sqlite, 'ios');
  const port = next.bindStorage(registration({ instanceId: 'later' })).port;
  assert.equal(await port.get('empty'), '');
  await port.set('', 'empty key remains ordinary data');
  assert.equal(await port.get(''), 'empty key remains ordinary data');
  await port.remove('');
  await port.remove('empty'); await port.remove('already-absent');
  assert.equal(await port.get('empty'), null);
});

test('UTF-8 quota includes keys and replacement values; exact512KiB succeeds, next byte fails atomically', async t => {
  const { database } = await setup(t);
  const store = database.bindStorage(registration()).port;
  await store.set('a', 'é'.repeat(131071) + 'x'); // value262143 + key1
  await store.set('b', '😀'.repeat(65535) + 'xyz'); // value262143 + key1
  assert.equal(await store.get('a'), 'é'.repeat(131071) + 'x');
  await assert.rejects(store.set('c', ''), assertCode('QUOTA_EXCEEDED'));
  await assert.rejects(store.set('a', 'a'.repeat(LIMITS.valueBytes)), assertCode('QUOTA_EXCEEDED'));
  assert.equal((await store.keys()).length, 2);
  await store.set('a', 'small'); await store.set('c', 'fits after replacement');
  await store.remove('b'); assert.deepEqual(await store.keys(), ['a', 'c']);
  await database.bindStorage(registration({ instanceId: 'two' })).port.set('b', 'x'.repeat(LIMITS.valueBytes), 'instance');
});

test('256-key bound applies transactionally and permits overwrite at capacity', async t => {
  const { database } = await setup(t);
  const port = database.bindStorage(registration()).port;
  for (let i = 0; i < LIMITS.keys; i++) await port.set(String(i), '');
  await assert.rejects(port.set('overflow', ''), assertCode('QUOTA_EXCEEDED'));
  await port.set('0', 'replacement');
  assert.equal((await port.keys()).length, 256);
  await port.remove('0'); await port.set('overflow', 'now fits');
});

test('bounded well-formed strings reject lone surrogates and oversize keys/values before SQL', async t => {
  const { sqlite, database } = await setup(t);
  const store = database.bindStorage(registration()).port, before = sqlite.calls.length;
  for (const key of ['é'.repeat(513), '\ud800', '\udc00']) assert.throws(() => store.get(key), assertCode('INVALID_INPUT'));
  for (const value of ['💫'.repeat(65537), '\ud800x']) assert.throws(() => store.set('key', value), assertCode('INVALID_INPUT'));
  assert.equal(sqlite.calls.length, before);
  assert.throws(() => database.bindStorage(registration({ publisher: 'unverified-fixture' })), assertCode('INVALID_INPUT'));
});

test('concurrent same-namespace writes serialize quota calculation across bindings', async t => {
  const { database } = await setup(t);
  const first = database.bindStorage(registration()).port, second = database.bindStorage(registration({ instanceId: 'two' })).port;
  const results = await Promise.allSettled([first.set('one', 'x'.repeat(262140)), second.set('two', 'y'.repeat(262140)), first.set('three', 'z')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
  const failure = results.find(result => result.status === 'rejected'); assert(failure?.status === 'rejected'); assertCode('QUOTA_EXCEEDED')(failure.reason);
  assert.deepEqual(await first.keys(), ['one', 'two']);
});

test('per-binding pending cap rejects overflow then recovers capacity', async t => {
  const { sqlite, database } = await setup(t);
  const reached = deferred(), release = deferred(); let held = false;
  sqlite.onStep = async sql => { if (sql === 'BEGIN IMMEDIATE' && !held) { held = true; reached.resolve(); await release.promise; } };
  const port = database.bindStorage(registration()).port;
  const requests = Array.from({ length: 16 }, (_, i) => port.get(String(i)));
  await reached.promise;
  await assert.rejects(port.get('overflow'), assertCode('BUSY'));
  release.resolve(); assert.deepEqual(await Promise.all(requests), Array(16).fill(null));
  assert.equal(await port.get('recovered'), null);
});

test('global pending cap bounds requests across distinct bindings', async t => {
  const { sqlite, database } = await setup(t);
  const reached = deferred(), release = deferred(); let held = false;
  sqlite.onStep = async sql => { if (sql === 'BEGIN IMMEDIATE' && !held) { held = true; reached.resolve(); await release.promise; } };
  const requests: Promise<string | null>[] = [];
  for (let i = 0; i < 8; i++) {
    const port = database.bindStorage(registration({ instanceId: `instance_${i}` })).port;
    for (let k = 0; k < 16; k++) requests.push(port.get(String(k)));
  }
  await reached.promise;
  await assert.rejects(database.bindStorage(registration()).port.get('overflow'), assertCode('BUSY'));
  release.resolve(); await Promise.all(requests);
});

for (const step of ['BEGIN IMMEDIATE', 'INSERT INTO app_versions', 'SELECT version FROM app_versions', 'SELECT count(*)', 'SELECT key, value', 'INSERT INTO saved_strings', 'COMMIT']) {
  test(`revocation during awaited ${step} suppresses completion and preserves owner isolation`, async t => {
    const { sqlite, database } = await setup(t);
    const binding = database.bindStorage(registration()); let tripped = false;
    sqlite.onStep = sql => { if (!tripped && sql.startsWith(step)) { tripped = true; binding.revoke(); } };
    await assert.rejects(binding.port.set('key', 'old-owner'), assertCode('REVOKED'));
    assert(tripped); sqlite.onStep = undefined;
    const reader = database.bindStorage(registration()).port;
    assert.equal(await reader.get('key'), step === 'COMMIT' ? 'old-owner' : null);
    assert.equal(await database.bindStorage(registration({ user: hex(8) })).port.get('key'), null);
  });
}

test('abort before execution and during SQL rolls back without making missing reads succeed', async t => {
  const { sqlite, database } = await setup(t);
  const port = database.bindStorage(registration()).port, aborted = new AbortController(); aborted.abort();
  const before = sqlite.calls.length;
  await assert.rejects(port.set('key', 'value', 'shared', { signal: aborted.signal }), assertCode('CANCELLED'));
  assert.equal(sqlite.calls.length, before);
  const during = new AbortController();
  sqlite.onStep = sql => { if (sql.startsWith('INSERT INTO saved_strings')) during.abort(); };
  await assert.rejects(port.set('key', 'value', 'shared', { signal: during.signal }), assertCode('CANCELLED'));
  sqlite.onStep = undefined; assert.equal(await port.get('key'), null);
  sqlite.faults.push({ prefix: 'SELECT key, value', mode: 'before' });
  await assert.rejects(port.get('missing'), assertCode('STORAGE_FAILURE'));
});

for (const mode of ['before', 'after', 'omit'] as const) test(`write ${mode} failure rolls back and queue remains usable`, async t => {
  const { sqlite, database } = await setup(t); const port = database.bindStorage(registration()).port;
  await port.set('key', 'old'); sqlite.faults.push({ prefix: 'INSERT INTO saved_strings', mode });
  await assert.rejects(port.set('key', 'new'), assertCode('STORAGE_FAILURE'));
  assert.equal(await port.get('key'), 'old'); await port.set('key', 'later'); assert.equal(await port.get('key'), 'later');
});

test('lost ordinary COMMIT acknowledgement is indeterminate, never a false success or retry', async t => {
  const { sqlite, database } = await setup(t); const port = database.bindStorage(registration()).port;
  sqlite.faults.push({ prefix: 'COMMIT', mode: 'after' });
  await assert.rejects(port.set('key', 'committed'), assertCode('STORAGE_INDETERMINATE'));
  assert.equal(await port.get('key'), 'committed');
  assert.equal(sqlite.calls.filter(call => call.sql.startsWith('INSERT INTO saved_strings')).length, 1);
});

test('rollback failure poisons the private connection and reopen recovers rolled-back state', async t => {
  const { sqlite, database } = await setup(t); const port = database.bindStorage(registration()).port;
  sqlite.faults.push({ prefix: 'INSERT INTO saved_strings', mode: 'after' }, { prefix: 'ROLLBACK', mode: 'before' });
  await assert.rejects(port.set('key', 'value'), assertCode('STORAGE_INDETERMINATE'));
  await assert.rejects(port.get('key'), assertCode('STORAGE_INDETERMINATE'));
  const restored = await openShellDatabase(sqlite, 'ios'); assert.equal(await restored.bindStorage(registration()).port.get('key'), null);
});

test('close invalidates active and queued bindings without erasing data', async t => {
  const { sqlite, database } = await setup(t);
  const port = database.bindStorage(registration()).port; await port.set('saved', 'retained');
  const reached = deferred(), release = deferred(); let held = false;
  sqlite.onStep = async sql => { if (sql === 'BEGIN IMMEDIATE' && !held) { held = true; reached.resolve(); await release.promise; } };
  const active = assert.rejects(port.set('pending', 'discarded'), assertCode('REVOKED'));
  const queued = assert.rejects(port.get('saved'), assertCode('REVOKED'));
  await reached.promise; const closed = database.close(); release.resolve(); await Promise.all([active, queued, closed]);
  sqlite.onStep = undefined;
  const restored = await openShellDatabase(sqlite, 'android');
  assert.equal(await restored.bindStorage(registration()).port.get('saved'), 'retained');
  assert.equal(await restored.bindStorage(registration()).port.get('pending'), null);
});
