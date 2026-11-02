import test from 'node:test';
import assert from 'node:assert/strict';
import { openShellDatabase, type ShellDatabase } from '../../src/storage/database.ts';
import { TABLES } from '../../src/storage/schema.ts';
import { assertCode, DiskSQLite, hex, registration, setup } from './harness.ts';

const old = hex(3), next = hex(4);
const update = () => ({ fromVersion: old, targetVersion: next, targetEventId: hex(8), receiptId: 'accepted_update_1', assertFrozen: () => { assert(true); } });
async function seed(database: ShellDatabase) {
  const owner = registration(), control = database.bindApp(owner).port;
  await control.selectInitialVersion(old);
  const shared = database.bindStorage(owner).port, other = database.bindStorage(registration({ instanceId: 'instance_2' })).port;
  await shared.set('shared', 'saved💫'); await shared.set('instance', 'first', 'instance'); await other.set('instance', 'second', 'instance');
  const sessions = ['instance_2', 'instance_1'].map(id => ({ id, title: id, publisher: owner.publisher, appId: owner.appId, version: old, source: 'published' as const, eventId: hex(7) }));
  await database.bindWorkspace(owner).port.save({ schema: 1, sessions, lastActiveId: 'instance_1' }, null);
  return control;
}

test('accepted copy preserves exact shared/instance values, old data, order/focus; receipt and selection survive reopen', async t => {
  const { sqlite, database } = await setup(t); const control = await seed(database);
  const receipt = await control.acceptUpdate(update());
  assert.deepEqual(receipt, { receiptId: 'accepted_update_1', fromVersion: old, targetVersion: next, rowCount: 3, byteCount: 42, workspaceRevision: 1, targetEventId: update().targetEventId });
  assert.equal(await control.selectedVersion(), next); assert.deepEqual(await control.receipt(receipt.receiptId), receipt);
  for (const aggregate of [old, next]) {
    assert.equal(await database.bindStorage(registration({ version: aggregate })).port.get('shared'), 'saved💫');
    assert.equal(await database.bindStorage(registration({ version: aggregate })).port.get('instance', 'instance'), 'first');
    assert.equal(await database.bindStorage(registration({ version: aggregate, instanceId: 'instance_2' })).port.get('instance', 'instance'), 'second');
  }
  const workspace = await database.bindWorkspace(registration()).port.load(); assert(workspace);
  assert.deepEqual(workspace.snapshot.sessions.map(item => item.id), ['instance_2', 'instance_1']); assert.equal(workspace.snapshot.lastActiveId, 'instance_1');
  assert(workspace.snapshot.sessions.every(item => item.version === next));
  assert(workspace.snapshot.sessions.every(item => item.eventId === update().targetEventId));
  await database.close(); const reopened = await openShellDatabase(sqlite, 'android');
  const reopenedControl = reopened.bindApp(registration()).port;
  assert.equal(await reopenedControl.selectedVersion(), next); assert.deepEqual(await reopenedControl.receipt(receipt.receiptId), receipt);
  assert.deepEqual(await reopenedControl.acceptUpdate(update()), receipt); // Idempotent observed result; never re-copy.
  await assert.rejects(reopenedControl.acceptUpdate({ ...update(), targetEventId: hex(9) }), assertCode('CONFLICT'));
  assert.equal(sqlite.calls.filter(call => call.sql.startsWith('INSERT INTO saved_strings') && call.sql.includes(' SELECT ')).length, 1);
});

test('v1 update receipts migrate with an unknown event pin and refuse replay as unverifiable', async t => {
  const sqlite = new DiskSQLite(); t.after(() => sqlite.cleanup());
  const raw = sqlite.raw();
  const legacyTables = Object.entries(TABLES).filter(([name]) => name !== 'access_grants').map(([name, sql]) => name === 'update_receipts' ? sql.replace(', target_event_id TEXT', '') : sql);
  raw.exec(legacyTables.join(';'));
  raw.exec('PRAGMA user_version = 1');
  raw.prepare('INSERT INTO app_versions (user, publisher, app, version) VALUES (?, ?, ?, ?)').run(hex(1), hex(2), 'test-app', old);
  raw.prepare('INSERT INTO app_versions (user, publisher, app, version) VALUES (?, ?, ?, ?)').run(hex(1), hex(2), 'test-app', next);
  raw.prepare('INSERT INTO selected_versions (user, publisher, app, version) VALUES (?, ?, ?, ?)').run(hex(1), hex(2), 'test-app', next);
  raw.prepare('INSERT INTO update_receipts (user, publisher, app, receipt, previous_version, version, row_count, byte_count, workspace_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(hex(1), hex(2), 'test-app', 'accepted_update_1', old, next, 0, 0, null);
  raw.close(); sqlite.connections.delete(raw);

  const database = await openShellDatabase(sqlite, 'android');
  const control = database.bindApp(registration()).port;
  const migrated = sqlite.raw();
  assert.equal(migrated.prepare('PRAGMA user_version').get()!['user_version'], 4);
  migrated.close(); sqlite.connections.delete(migrated);
  assert.deepEqual(await control.receipt('accepted_update_1'), {
    receiptId: 'accepted_update_1', fromVersion: old, targetVersion: next, rowCount: 0, byteCount: 0,
    workspaceRevision: null, targetEventId: null,
  });
  await assert.rejects(control.acceptUpdate(update()), assertCode('CONFLICT'));
  await database.close();
  const reopened = await openShellDatabase(sqlite, 'ios');
  assert.equal((await reopened.bindApp(registration()).port.receipt('accepted_update_1'))?.targetEventId, null);
  await reopened.close();
});

test('copy cannot select another user, publisher or app; unrelated workspaces are unchanged', async t => {
  const { database } = await setup(t); const control = await seed(database);
  const outsiders = [registration({ user: hex(7) }), registration({ publisher: hex(7) }), registration({ appId: 'test-app::instance' })];
  for (const outsider of outsiders) {
    await database.bindApp(outsider).port.selectInitialVersion(old);
    await database.bindStorage(outsider).port.set('shared', 'not copied');
  }
  await control.acceptUpdate(update());
  for (const outsider of outsiders) {
    assert.equal(await database.bindApp(outsider).port.selectedVersion(), old);
    assert.equal(await database.bindApp(outsider).port.receipt('accepted_update_1'), null);
    assert.equal(await database.bindStorage({ ...outsider, version: next }).port.get('shared'), null);
    assert.equal(await database.bindStorage(outsider).port.get('shared'), 'not copied');
  }
});

for (const method of ['set-remove', 'read-only', 'keys'] as const) test(`previously retained target (${method}) is refused even with no remaining strings`, async t => {
  const { database } = await setup(t); const control = await seed(database);
  const target = database.bindStorage(registration({ version: next })).port;
  if (method === 'set-remove') { await target.set('former', 'saved'); await target.remove('former'); }
  else if (method === 'read-only') await target.get('absent');
  else {
    const other = database.bindApp(registration({ appId: 'other' })).port;
    await other.selectInitialVersion(next); // Another owner does not retain our target.
    await target.keys();
  }
  await assert.rejects(control.acceptUpdate(update()), assertCode('TARGET_RETAINED'));
  assert.equal(await control.selectedVersion(), old); assert.equal(await control.receipt('accepted_update_1'), null); assert.deepEqual(await target.keys(), []);
});

for (const prefix of ['INSERT INTO saved_strings', 'UPDATE workspaces', 'UPDATE selected_versions', 'INSERT INTO update_receipts', 'COMMIT']) {
  for (const mode of ['before', 'after'] as const) {
    if (prefix === 'COMMIT' && mode === 'after') continue;
    test(`accepted update failure ${mode} ${prefix} rolls back copy, selection, receipt and workspace`, async t => {
      const { sqlite, database } = await setup(t); const control = await seed(database);
      sqlite.faults.push({ prefix, mode });
      await assert.rejects(control.acceptUpdate(update()), assertCode('STORAGE_FAILURE'));
      assert.equal(await control.selectedVersion(), old); assert.equal(await control.receipt('accepted_update_1'), null);
      const workspace = await database.bindWorkspace(registration()).port.load(); assert.equal(workspace?.revision, 0); assert(workspace?.snapshot.sessions.every(item => item.version === old));
      const rows = sqlite.raw().prepare('SELECT count(*) AS n FROM app_versions WHERE version = ?').get(next); assert.equal(rows!['n'], 0);
      assert.equal(await database.bindStorage(registration()).port.get('shared'), 'saved💫');
      // Failed transactions did not retain the empty target or consume its receipt ID.
      assert.equal((await control.acceptUpdate(update())).targetVersion, next);
    });
  }
}

test('copy omission is detected and rejected before selected-version commit', async t => {
  const { sqlite, database } = await setup(t); const control = await seed(database);
  sqlite.faults.push({ prefix: 'INSERT INTO saved_strings', mode: 'omit' });
  await assert.rejects(control.acceptUpdate(update()), assertCode('STORAGE_FAILURE'));
  assert.equal(await control.selectedVersion(), old); assert.equal(await control.receipt('accepted_update_1'), null);
});

test('lost COMMIT acknowledgement resolves by the atomic receipt, without retrying copy', async t => {
  const { sqlite, database } = await setup(t); const control = await seed(database);
  sqlite.faults.push({ prefix: 'COMMIT', mode: 'after' });
  const receipt = await control.acceptUpdate(update()); assert.equal(receipt.targetVersion, next);
  assert.equal(await control.selectedVersion(), next);
  assert.equal(sqlite.calls.filter(call => call.sql.startsWith('INSERT INTO saved_strings') && call.sql.includes(' SELECT ')).length, 1);
});

test('lost commit plus unavailable receipt readback returns indeterminate; reopen finds committed selection', async t => {
  const { sqlite, database } = await setup(t); const control = await seed(database);
  sqlite.faults.push({ prefix: 'COMMIT', mode: 'after' }, { prefix: 'SELECT receipt,', mode: 'before', nth: 2 });
  await assert.rejects(control.acceptUpdate(update()), assertCode('STORAGE_INDETERMINATE'));
  await database.close(); const restored = await openShellDatabase(sqlite, 'ios');
  assert.equal(await restored.bindApp(registration()).port.selectedVersion(), next); assert.equal((await restored.bindApp(registration()).port.receipt('accepted_update_1'))?.targetVersion, next);
});

test('revocation while copying rolls back and cannot deliver or commit through a replacement context', async t => {
  const { sqlite, database } = await setup(t); const control = await seed(database); let frozen = true;
  sqlite.onStep = sql => { if (sql.startsWith('INSERT INTO saved_strings')) frozen = false; };
  await assert.rejects(control.acceptUpdate({ ...update(), assertFrozen: () => { if (!frozen) throw new Error('registry context changed'); } }), assertCode('REVOKED'));
  sqlite.onStep = undefined;
  assert.equal(await control.selectedVersion(), old); assert.equal(await control.receipt('accepted_update_1'), null);
  const rows = sqlite.raw().prepare('SELECT count(*) AS n FROM app_versions WHERE version = ?').get(next); assert.equal(rows!['n'], 0);
});

test('receipt replay with changed parameters, stale expected selection and same-version update fail', async t => {
  const { database } = await setup(t); const control = await seed(database);
  assert.throws(() => control.acceptUpdate({ ...update(), targetVersion: old }), assertCode('INVALID_INPUT'));
  await assert.rejects(control.acceptUpdate({ ...update(), fromVersion: hex(7) }), assertCode('SELECTION_MISMATCH'));
  await control.acceptUpdate(update());
  await assert.rejects(control.acceptUpdate({ ...update(), targetVersion: hex(8) }), assertCode('CONFLICT'));
  await assert.rejects(control.selectInitialVersion(old), assertCode('SELECTION_MISMATCH'));
});

test('empty saved state copies with zero counts and keeps an explicit empty workspace', async t => {
  const { database } = await setup(t); const control = database.bindApp(registration()).port;
  await control.selectInitialVersion(old); await database.bindWorkspace(registration()).port.save({ schema: 1, sessions: [], lastActiveId: null }, null);
  const result = await control.acceptUpdate(update()); assert.equal(result.rowCount, 0); assert.equal(result.byteCount, 0); assert.equal(result.workspaceRevision, 0);
  assert.deepEqual((await database.bindWorkspace(registration()).port.load())?.snapshot, { schema: 1, sessions: [], lastActiveId: null });
});
