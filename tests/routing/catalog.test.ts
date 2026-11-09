import test from 'node:test';
import assert from 'node:assert/strict';
import { artifact, modernHandler,snapshotHandler } from './fixtures.ts';
import { openRoutingCatalog, ROUTING_DATABASE } from '../../src/routing/routing-catalog.ts';
import {snapshotAppKey} from '../../src/napplets/published-identity.ts';
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

test('modern signed advertisements require matching roles and an Intent declaration', async t => {
  const sqlite = new DiskSQLite();
  const catalog = await openRoutingCatalog(sqlite, 'ios');
  t.after(async () => { await catalog.close(); sqlite.cleanup(); });
  const tags = [
    ['i', 'napplet:napptest/open', 'msg'],
    ['i', 'napplet:other/open', 'orphan'],
    ['z', 'empty'],
    ['z', 'napptest'],
    ['i', 'napplet:napptest/edit', 'first'],
    ['i', 'napplet:napptest/edit', 'conflicting'],
    ['i', 'napplet:napptest/open?unexpected=query'],
    ['i', 'napplet:napptest/' + 'a'.repeat(65)],
  ];
  const advertised = await modernHandler(tags), undeclared = await modernHandler(tags, ['theme'], 10);
  await catalog.remember(owner(), advertised);
  await catalog.remember(owner(), undeclared);
  const {handlers} = await catalog.list(owner());
  assert.deepEqual(handlers.find(handler => handler.publisher === advertised.manifest.pubkey)!.roles,
    [{archetype: 'napptest', conventions: ['napplet:napptest/open'], contracts: [{convention: 'napplet:napptest/open', params: ['msg']}]}]);
  assert.deepEqual(handlers.find(handler => handler.publisher === undeclared.manifest.pubkey)!.roles, []);
});

test('named v1 migration is atomic and older named catalog access cannot delete v2 snapshot defaults',async t=>{
  const sqlite=new DiskSQLite();t.after(()=>sqlite.cleanup());
  const legacy=sqlite.raw('hypergolic-routing-v1.db');
  legacy.exec('CREATE TABLE routing_catalog (user TEXT NOT NULL, publisher TEXT NOT NULL, app_id TEXT NOT NULL, event_id TEXT NOT NULL, signed_event TEXT NOT NULL CHECK (length(CAST(signed_event AS BLOB)) <= 65536), PRIMARY KEY (user, publisher, app_id)) WITHOUT ROWID');
  legacy.exec('CREATE TABLE routing_defaults (user TEXT NOT NULL, archetype TEXT NOT NULL, publisher TEXT NOT NULL, app_id TEXT NOT NULL, PRIMARY KEY (user, archetype), FOREIGN KEY (user, publisher, app_id) REFERENCES routing_catalog (user, publisher, app_id) ON DELETE CASCADE) WITHOUT ROWID');
  legacy.exec('PRAGMA user_version = 1');
  const named=await modernHandler(), m=named.manifest;
  const event=JSON.stringify({id:m.id,pubkey:m.pubkey,kind:m.kind,created_at:m.created_at,content:m.content,tags:m.tags,sig:m.sig});
  legacy.prepare('INSERT INTO routing_catalog VALUES (?,?,?,?,?)').run(first,m.pubkey,'modern-handler',m.id,event);
  legacy.prepare('INSERT INTO routing_defaults VALUES (?,?,?,?)').run(first,'napptest',m.pubkey,'modern-handler');
  sqlite.faults.push({prefix:'INSERT INTO routing_defaults (user,archetype',mode:'omit'});
  await assert.rejects(openRoutingCatalog(sqlite,'ios'),{code:'STORAGE_FAILURE'});
  const v2=sqlite.raw(ROUTING_DATABASE);
  assert.equal(v2.prepare('PRAGMA user_version').get()?.user_version,0);
  assert.equal(v2.prepare("SELECT count(*) AS rows FROM sqlite_schema WHERE type='table'").get()?.rows,0);
  assert.equal(legacy.prepare('SELECT signed_event FROM routing_catalog').get()?.signed_event,event);
  assert.equal(legacy.prepare('SELECT app_id FROM routing_defaults').get()?.app_id,'modern-handler');

  let catalog=await openRoutingCatalog(sqlite,'ios');
  assert.equal((await catalog.list(owner())).defaults[0]?.appId,'modern-handler');
  const snapshot=await snapshotHandler(), appId=snapshotAppKey(snapshot.manifest.id);
  await catalog.remember(owner(),snapshot);
  await catalog.prefer(owner(),'napptest',{publisher:snapshot.manifest.pubkey,appId});
  await catalog.close();
  assert.equal(legacy.prepare('SELECT app_id FROM routing_defaults').get()?.app_id,'modern-handler');
  assert.equal(legacy.prepare('SELECT count(*) AS rows FROM routing_catalog').get()?.rows,1);
  legacy.exec('DELETE FROM routing_catalog');
  catalog=await openRoutingCatalog(sqlite,'ios');
  const reopened=await catalog.list(owner());
  assert.equal(reopened.handlers.length,2);
  assert.equal(reopened.defaults[0]?.appId,appId);
  assert.deepEqual(await catalog.list(owner(second)),{handlers:[],defaults:[]});
  await catalog.remove(owner(),{publisher:snapshot.manifest.pubkey,appId});
  assert.deepEqual((await catalog.list(owner())).defaults,[]);
  await catalog.close();
});
