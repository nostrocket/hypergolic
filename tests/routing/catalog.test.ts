import test from 'node:test';
import assert from 'node:assert/strict';
import { artifact } from './fixtures.ts';
import { openRoutingCatalog, ROUTING_DATABASE } from '../../src/routing/routing-catalog.ts';
import { deferred, DiskSQLite } from '../storage/harness.ts';
const first = '01'.repeat(32), second = '02'.repeat(32);
const owner = (user = first) => ({ user, assertActive() {} });
test('catalog persists verified metadata and explicit identity-local defaults across reopening', async t => {
  const sqlite = new DiskSQLite(); t.after(() => sqlite.cleanup());
  const a = await artifact(), b = await artifact(10);
  let catalog = await openRoutingCatalog(sqlite, 'ios');
  await catalog.remember(owner(), a); await catalog.remember(owner(), b);
  let snapshot = await catalog.list(owner());
  assert.equal(snapshot.handlers.length, 2); assert.deepEqual(snapshot.defaults, []);
  assert.deepEqual(snapshot.handlers[0]!.roles, [{ archetype: 'note', conventions: ['napplet:note/open', 'napplet:note/edit'] }]);
  await catalog.prefer(owner(), 'note', { publisher: b.manifest.pubkey, appId: 'notes' });
  assert.equal((await catalog.list(owner(second))).handlers.length, 0);
  assert.equal((await catalog.list(owner(second))).defaults.length, 0);
  await catalog.close(); catalog = await openRoutingCatalog(sqlite, 'ios');
  snapshot = await catalog.list(owner()); assert.equal(snapshot.defaults[0]!.publisher, b.manifest.pubkey);
  assert.equal(snapshot.handlers.find(item => item.publisher === a.manifest.pubkey)!.eventId, a.manifest.eventId);
  await catalog.prefer(owner(), 'note', null); assert.deepEqual((await catalog.list(owner())).defaults, []);
  await catalog.close();
});
test('rejects structural lookalikes, unknown handlers and roles instead of granting authority', async t => {
  const sqlite = new DiskSQLite(); t.after(() => sqlite.cleanup());
  const catalog = await openRoutingCatalog(sqlite, 'android'), a = await artifact();
  await assert.rejects(catalog.remember(owner(), { ...a }));
  await assert.rejects(catalog.prefer(owner(), 'note', { publisher: a.manifest.pubkey, appId: 'notes' }));
  await catalog.remember(owner(), a);
  await assert.rejects(catalog.prefer(owner(), 'editor', { publisher: a.manifest.pubkey, appId: 'notes' }));
  assert.deepEqual((await catalog.list(owner())).defaults, []); await catalog.close();
});
test('updates retain compatible defaults and clear roles that the new signed manifest dropped', async t => {
  const sqlite = new DiskSQLite(); t.after(() => sqlite.cleanup());
  const catalog = await openRoutingCatalog(sqlite, 'ios'), a = await artifact();
  await catalog.remember(owner(), a); await catalog.prefer(owner(), 'note', { publisher: a.manifest.pubkey, appId: 'notes' });
  const compatible = await artifact(9, 'notes', 'note', 1_800_000_001); await catalog.remember(owner(), compatible);
  assert.equal((await catalog.list(owner())).defaults.length, 1);
  const changed = await artifact(9, 'notes', 'editor', 1_800_000_002); await catalog.remember(owner(), changed);
  const snapshot = await catalog.list(owner()); assert.deepEqual(snapshot.defaults, []); assert.equal(snapshot.handlers[0]!.eventId, changed.manifest.eventId);
  await catalog.close();
});
test('removal atomically clears defaults for this identity and leaves other identities alone', async t => {
  const sqlite = new DiskSQLite(); t.after(() => sqlite.cleanup());
  const catalog = await openRoutingCatalog(sqlite, 'ios'), a = await artifact();
  const key = { publisher: a.manifest.pubkey, appId: 'notes' };
  for (const user of [first, second]) { await catalog.remember(owner(user), a); await catalog.prefer(owner(user), 'note', key); }
  await catalog.remove(owner(), key); assert.deepEqual(await catalog.list(owner()), { handlers: [], defaults: [] });
  assert.equal((await catalog.list(owner(second))).defaults.length, 1); await catalog.close();
});
test('tampered signed metadata is evicted together with its preferred-handler authority', async t => {
  const sqlite = new DiskSQLite(); t.after(() => sqlite.cleanup());
  const catalog = await openRoutingCatalog(sqlite, 'ios'), a = await artifact();
  await catalog.remember(owner(), a); await catalog.prefer(owner(), 'note', { publisher: a.manifest.pubkey, appId: 'notes' });
  const db = sqlite.raw(ROUTING_DATABASE);
  db.prepare("UPDATE routing_catalog SET signed_event = replace(signed_event, 'napplet:note/open', 'napplet:evil/open')").run();
  assert.deepEqual(await catalog.list(owner()), { handlers: [], defaults: [] }); await catalog.close();
});
test('late identity revocation rolls back a write and blocks pending read results', async t => {
  const sqlite = new DiskSQLite(); t.after(() => sqlite.cleanup());
  const catalog = await openRoutingCatalog(sqlite, 'ios'), a = await artifact(); let active = true;
  const authority = { user: first, assertActive() { if (!active) throw new Error('revoked'); } };
  const entered = deferred(), release = deferred();
  sqlite.onStep = async sql => { if (sql.startsWith('INSERT INTO routing_catalog')) { entered.resolve(); await release.promise; } };
  const result = catalog.remember(authority, a); await entered.promise; active = false; release.resolve();
  await assert.rejects(result, { code: 'REVOKED' }); sqlite.onStep = undefined;
  assert.deepEqual(await catalog.list(owner()), { handlers: [], defaults: [] });
  active = true; await catalog.remember(authority, a);
  sqlite.onStep = sql => { if (sql.startsWith('SELECT publisher, app_id, event_id, signed_event FROM routing_catalog WHERE user = ? ORDER')) active = false; };
  await assert.rejects(catalog.list(authority), { code: 'REVOKED' }); sqlite.onStep = undefined;
  await catalog.close();
});
test('unacknowledged preferences fail and do not silently save a default', async t => {
  const sqlite = new DiskSQLite(); t.after(() => sqlite.cleanup());
  const catalog = await openRoutingCatalog(sqlite, 'ios'), a = await artifact(); await catalog.remember(owner(), a);
  sqlite.faults.push({ prefix: 'INSERT INTO routing_defaults', mode: 'omit' });
  await assert.rejects(catalog.prefer(owner(), 'note', { publisher: a.manifest.pubkey, appId: 'notes' }), { code: 'STORAGE_FAILURE' });
  assert.deepEqual((await catalog.list(owner())).defaults, []); await catalog.close();
});
