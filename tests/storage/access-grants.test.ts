import test from 'node:test';
import assert from 'node:assert/strict';
import { openShellDatabase, type ShellDatabase } from '../../src/storage/database.ts';
import { TABLES } from '../../src/storage/schema.ts';
import { assertCode, DiskSQLite, hex, registration, setup } from './harness.ts';

function control(database: ShellDatabase, patch: Parameters<typeof registration>[0] = {}) {
  return database.bindApp(registration(patch)).port;
}

test('capability grants are exact, sorted and isolated by selected identity, publisher and app', async t => {
  const { database } = await setup(t);
  const primary = control(database), user = control(database, { user: hex(7) }), publisher = control(database, { publisher: hex(7) }), app = control(database, { appId: 'other-app' });
  assert.equal(await primary.readAccessGrant(), null);
  const saved = await primary.replaceAccessGrant(['storage', 'relay', 'theme'], null);
  assert.deepEqual(saved, { revision: 0, domains: ['relay', 'storage', 'theme'] });
  assert.deepEqual((await control(database, { appId: 'theme-only' }).replaceAccessGrant(['theme'], null)).domains, ['theme']);
  assert(Object.isFrozen(saved) && Object.isFrozen(saved.domains));
  for (const outsider of [user, publisher, app]) assert.equal(await outsider.readAccessGrant(), null);
  const otherGrant = await user.replaceAccessGrant(['profile'], null);
  assert.deepEqual(otherGrant.domains, ['profile']);
  assert.deepEqual(await primary.readAccessGrant(), saved);
});

test('replace and revoke use revision compare-and-swap and serialize concurrent first-open grants', async t => {
  const { database } = await setup(t), grant = control(database);
  const writes = await Promise.allSettled([
    grant.replaceAccessGrant(['theme'], null), grant.replaceAccessGrant(['storage'], null),
  ]);
  assert.equal(writes.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(writes.filter(item => item.status === 'rejected').length, 1);
  await assert.rejects(grant.replaceAccessGrant(['stale'], null), assertCode('CONFLICT'));
  const first = await grant.readAccessGrant(); assert(first);
  const second = await grant.replaceAccessGrant(['storage', 'theme'], first.revision);
  assert.deepEqual(second, { revision: first.revision + 1, domains: ['storage', 'theme'] });
  await assert.rejects(grant.replaceAccessGrant(['stale'], first.revision), assertCode('CONFLICT'));
  await assert.rejects(grant.revokeAccessGrant(first.revision), assertCode('CONFLICT'));
  await grant.revokeAccessGrant(second.revision);
  assert.equal(await grant.readAccessGrant(), null);
  await assert.rejects(grant.revokeAccessGrant(second.revision), assertCode('CONFLICT'));
  const recreated = await grant.replaceAccessGrant(['theme'], null);
  assert.deepEqual(recreated, { revision: 0, domains: ['theme'] });
});

test('invalid caller capability sets are rejected before storage', async t => {
  const { database } = await setup(t), grant = control(database);
  for (const domains of [
    ['Theme'], ['theme.widgets'], ['0theme'], ['bad_label'], ['theme', 'theme'],
  ]) assert.throws(() => grant.replaceAccessGrant(domains, null), assertCode('INVALID_INPUT'));
  const sparse = new Array(1) as string[];
  assert.throws(() => grant.replaceAccessGrant(sparse, null), assertCode('INVALID_INPUT'));
  assert.equal(await grant.readAccessGrant(), null);
});

test('capability set is snapshotted before asynchronous storage work is queued', async t => {
  const { database } = await setup(t), grant = control(database), reviewed = ['theme'];
  const pending = grant.replaceAccessGrant(reviewed, null);
  reviewed[0] = 'storage';
  await pending;
  assert.deepEqual((await grant.readAccessGrant())?.domains, ['theme']);
});

test('noncanonical or malformed persisted grants fail closed on read and replace', async t => {
  const { sqlite, database } = await setup(t), grant = control(database);
  await grant.replaceAccessGrant(['theme', 'storage'], null);
  const raw = sqlite.raw();
  raw.prepare('UPDATE access_grants SET domains = ? WHERE user = ? AND publisher = ? AND app = ?').run('["theme","storage"]', hex(1), hex(2), 'test-app');
  raw.close(); sqlite.connections.delete(raw);
  await assert.rejects(grant.readAccessGrant(), assertCode('CORRUPT_STORAGE'));
  await assert.rejects(grant.replaceAccessGrant(['profile'], 0), assertCode('CORRUPT_STORAGE'));
});

test('v2 database migrates to v4 without changing retained app data', async t => {
  const sqlite = new DiskSQLite(); t.after(() => sqlite.cleanup());
  const raw = sqlite.raw();
  const v2Tables = Object.entries(TABLES).filter(([name]) => name !== 'access_grants').map(([, sql]) => sql);
  raw.exec(v2Tables.join(';')); raw.exec('PRAGMA user_version = 2');
  raw.prepare('INSERT INTO app_versions (user, publisher, app, version) VALUES (?, ?, ?, ?)').run(hex(1), hex(2), 'test-app', hex(3));
  raw.prepare('INSERT INTO selected_versions (user, publisher, app, version) VALUES (?, ?, ?, ?)').run(hex(1), hex(2), 'test-app', hex(3));
  raw.close(); sqlite.connections.delete(raw);

  const database = await openShellDatabase(sqlite, 'android');
  const controlPort = control(database);
  assert.equal(await controlPort.selectedVersion(), hex(3));
  assert.equal(await controlPort.readAccessGrant(), null);
  const migrated = sqlite.raw();
  assert.equal(migrated.prepare('PRAGMA user_version').get()!['user_version'], 4);
  assert.equal(migrated.prepare('SELECT count(*) AS n FROM app_versions').get()!['n'], 1);
  assert.equal(migrated.prepare('SELECT count(*) AS n FROM selected_versions').get()!['n'], 1);
  migrated.close(); sqlite.connections.delete(migrated);
  await database.close();
  const reopened = await openShellDatabase(sqlite, 'ios');
  await control(reopened).replaceAccessGrant(['theme'], null);
  assert.deepEqual((await control(reopened).readAccessGrant())?.domains, ['theme']);
  await reopened.close();
});

test('version 2 with an unexpected access table is a schema mismatch and is preserved', async t => {
  const { sqlite, database } = await setup(t); await database.close();
  const raw = sqlite.raw(); raw.exec('PRAGMA user_version = 2');
  await assert.rejects(openShellDatabase(sqlite, 'ios'), assertCode('CORRUPT_STORAGE'));
  assert.equal(raw.prepare('PRAGMA user_version').get()!['user_version'], 2);
  assert(raw.prepare("SELECT name FROM sqlite_schema WHERE name = 'access_grants'").get());
});

test('v3 grants retain revisions and domains; support review persists across restart', async t => {
  const sqlite = new DiskSQLite(); t.after(() => sqlite.cleanup());
  const raw = sqlite.raw();
  const legacy = Object.values(TABLES).map(sql => sql.replace(', support_review TEXT NOT NULL CHECK (length(CAST(support_review AS BLOB)) <= 16384)', ''));
  raw.exec(legacy.join(';')); raw.exec('PRAGMA user_version = 3');
  raw.prepare('INSERT INTO access_grants (user, publisher, app, revision, domains) VALUES (?, ?, ?, ?, ?)').run(hex(1), hex(2), 'test-app', 7, '["theme"]');
  raw.close(); sqlite.connections.delete(raw);
  const database = await openShellDatabase(sqlite, 'android');
  const grant = control(database);
  assert.deepEqual(await grant.readAccessGrant(), {revision: 7, domains: ['theme']});
  await grant.replaceAccessGrant(['theme'], 7, {}, 'reviewed-host-profile');
  await database.close();
  const reopened = await openShellDatabase(sqlite, 'ios');
  assert.deepEqual(await control(reopened).readAccessGrant(), {revision: 8, domains: ['theme'], supportReview: 'reviewed-host-profile'});
  await reopened.close();
});
