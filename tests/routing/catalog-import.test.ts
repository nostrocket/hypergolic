import test from 'node:test';
import assert from 'node:assert/strict';
import { verifiedPublicationIdentity } from '../../src/napplets/verified-publication-identity.ts';
import { openRoutingCatalog, ROUTING_DATABASE } from '../../src/routing/routing-catalog.ts';
import { deferred, DiskSQLite, hex } from '../storage/harness.ts';
import { artifact, modernHandler, snapshotHandler } from './fixtures.ts';

const owner = {user: hex(1), assertActive() {}};
const other = {user: hex(2), assertActive() {}};
const archetype = 'napptest';
const defaultRead = 'SELECT publisher, app_id FROM (SELECT 1)';
type InstalledArtifact = Awaited<ReturnType<typeof modernHandler>>;

function pin(artifact: InstalledArtifact) {
  return {
    publisher: artifact.manifest.pubkey,
    appId: verifiedPublicationIdentity(artifact.manifest).appId,
    eventId: artifact.manifest.id,
    version: artifact.aggregateHash,
  };
}

test('reviewed snapshot selection and explicit clear persist without touching other identities or roles', async t => {
  const sqlite = new DiskSQLite(); t.after(() => sqlite.cleanup());
  const [named, snapshot, unrelated] = await Promise.all([modernHandler(), snapshotHandler(), artifact()]);
  const current = pin(named), target = pin(snapshot), note = pin(unrelated);
  let catalog = await openRoutingCatalog(sqlite, 'ios');
  for (const user of [owner, other]) {
    await catalog.remember(user, named);
    await catalog.prefer(user, archetype, current);
  }
  await catalog.remember(owner, snapshot);
  await catalog.remember(owner, unrelated);
  await catalog.prefer(owner, 'note', note);

  await catalog.importDefault(owner, {archetype, current, target});
  await catalog.close();
  catalog = await openRoutingCatalog(sqlite, 'ios');
  assert.deepEqual((await catalog.inspect(owner)).defaults.map(row => [row.archetype, row.appId]), [
    [archetype, target.appId], ['note', note.appId],
  ]);
  assert.equal((await catalog.inspect(other)).defaults[0]?.appId, current.appId);

  await catalog.importDefault(owner, {archetype, current: target, target: null});
  await catalog.close();
  catalog = await openRoutingCatalog(sqlite, 'ios');
  assert.deepEqual((await catalog.inspect(owner)).defaults.map(row => row.archetype), ['note']);
  await catalog.close();
});

test('stale reviewed defaults, replaced target pins and unregistered or nonmodern handlers cannot change defaults', async t => {
  const sqlite = new DiskSQLite(); t.after(() => sqlite.cleanup());
  const catalog = await openRoutingCatalog(sqlite, 'ios');
  const [named, snapshot, legacy, noIntent] = await Promise.all([
    modernHandler(), snapshotHandler(), artifact(9, 'legacy-handler', archetype, 1_800_000_000, ['napplet:napptest/open']),
    modernHandler(undefined, ['theme'], 11),
  ]);
  const current = pin(named), target = pin(snapshot);
  for (const verified of [named, legacy, noIntent]) await catalog.remember(owner, verified);
  await catalog.remember(other, snapshot);
  await catalog.prefer(owner, archetype, current);
  const raw = sqlite.raw(ROUTING_DATABASE);
  const defaults = () => raw.prepare('SELECT * FROM routing_defaults ORDER BY user, archetype').all();
  const original = defaults();

  await assert.rejects(catalog.importDefault(owner, {archetype, current: null, target: null}), {code: 'REVOKED'});
  for (const denied of [target, pin(legacy), pin(noIntent), {...current, version: hex(99)}]) {
    await assert.rejects(catalog.importDefault(owner, {archetype, current, target: denied}), {code: 'INVALID_INPUT'});
  }
  const refreshed = await modernHandler([['z', archetype], ['i', 'napplet:napptest/open', 'msg'], ['title', 'New revision']]);
  await catalog.remember(owner, refreshed);
  assert.equal(refreshed.aggregateHash, current.version);
  assert.notEqual(refreshed.manifest.id, current.eventId);
  await assert.rejects(catalog.importDefault(owner, {archetype, current, target: current}), {code: 'INVALID_INPUT'});
  assert.deepEqual(defaults(), original);
  await catalog.close();
});

test('failed write acknowledgements or readback roll back set and clear', async t => {
  const sqlite = new DiskSQLite(); t.after(() => sqlite.cleanup());
  const catalog = await openRoutingCatalog(sqlite, 'ios');
  const named = await modernHandler(), snapshot = await snapshotHandler();
  const current = pin(named), target = pin(snapshot);
  await catalog.remember(owner, named);
  await catalog.remember(owner, snapshot);
  await catalog.prefer(owner, archetype, current);

  for (const failure of [
    {prefix: 'INSERT INTO routing_defaults', mode: 'omit'},
    {prefix: defaultRead, mode: 'omit', nth: 2},
  ] as const) {
    sqlite.faults.push({...failure});
    await assert.rejects(catalog.importDefault(owner, {archetype, current, target}), {code: 'STORAGE_FAILURE'});
  }
  sqlite.faults.push({prefix: defaultRead, mode: 'omit', nth: 2});
  await assert.rejects(catalog.importDefault(owner, {archetype, current, target: null}), {code: 'STORAGE_FAILURE'});
  sqlite.faults.push({prefix: defaultRead, mode: 'omit'});
  await assert.rejects(catalog.importDefault(owner, {archetype, current: null, target}), {code: 'STORAGE_FAILURE'});
  assert.equal((await catalog.inspect(owner)).defaults[0]?.appId, current.appId);
  await catalog.close();
});

test('an account change or abort after the SQL write rolls back the reviewed default', async t => {
  const sqlite = new DiskSQLite(); t.after(() => sqlite.cleanup());
  const catalog = await openRoutingCatalog(sqlite, 'ios');
  const named = await modernHandler(), target = pin(named);
  await catalog.remember(owner, named);
  for (const reason of ['REVOKED', 'CANCELLED']) {
    const entered = deferred(), release = deferred(), controller = new AbortController();
    let selected = owner.user;
    const authority = {user: selected, assertActive() { assert.equal(selected, owner.user); }};
    sqlite.onStep = async sql => {
      if (!sql.startsWith('INSERT INTO routing_defaults')) return;
      entered.resolve();
      await release.promise;
    };
    const result = catalog.importDefault(authority, {archetype, current: null, target}, {signal: controller.signal});
    await entered.promise;
    if (reason === 'REVOKED') selected = other.user;
    else controller.abort();
    release.resolve();
    await assert.rejects(result, {code: reason});
    sqlite.onStep = undefined;
    assert.deepEqual((await catalog.inspect(owner)).defaults, []);
    assert.deepEqual((await catalog.inspect(other)).defaults, []);
  }
  await catalog.close();
});

test('preview omits corrupt catalog rows and defaults without repairing them', async t => {
  const sqlite = new DiskSQLite(); t.after(() => sqlite.cleanup());
  const catalog = await openRoutingCatalog(sqlite, 'ios');
  const named = await modernHandler(), target = pin(named);
  await catalog.remember(owner, named);
  await catalog.prefer(owner, archetype, target);
  const db = sqlite.raw(ROUTING_DATABASE);
  db.prepare("UPDATE routing_catalog SET signed_event = replace(signed_event, 'napplet:napptest/open', 'napplet:evil/open')").run();
  const counts = () => db.prepare('SELECT (SELECT count(*) FROM routing_catalog) AS handlers, (SELECT count(*) FROM routing_defaults) AS defaults').get();
  assert.deepEqual(await catalog.inspect(owner), {handlers: [], defaults: []});
  assert.deepEqual({...counts()}, {handlers: 1, defaults: 1});
  await assert.rejects(catalog.importDefault(owner, {archetype, current: null, target: null}), {code: 'REVOKED'});
  assert.deepEqual({...counts()}, {handlers: 1, defaults: 1});
  assert.deepEqual(await catalog.list(owner), {handlers: [], defaults: []});
  assert.deepEqual({...counts()}, {handlers: 0, defaults: 0});
  await catalog.close();
});
