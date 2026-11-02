import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finalizeEvent, getPublicKey, type NostrEvent } from 'nostr-tools/pure';
import { openOutboxRelayListCache, OUTBOX_CACHE_DATABASE, OUTBOX_CACHE_LIMITS } from '../../src/outbox/relay-list-cache.ts';
import { ShellStorageError } from '../../src/storage/ports.ts';
import { DiskSQLite, hex } from '../storage/harness.ts';
const key = new Uint8Array(32).fill(34), author = getPublicKey(key), user = hex(41);
const signal = () => new AbortController().signal;
function event(created_at = 100, tags = [['r', 'wss://nos.lol']]): NostrEvent {
  return JSON.parse(JSON.stringify(finalizeEvent({kind: 10002, created_at, tags, content: ''}, key))) as NostrEvent;
}
async function setup(t: {after(fn: () => void): void}) {
  const sqlite = new DiskSQLite(); t.after(() => sqlite.cleanup());
  return {sqlite, cache: await openOutboxRelayListCache(sqlite, 'android')};
}
test('cold reopen retains verified event and successful lookup time in its identity namespace', async t => {
  const {sqlite, cache} = await setup(t), signed = event();
  await cache.write(user, author, {event: signed, fetchedAt: 2000}, () => {}, signal());
  await cache.close();
  const restored = await openOutboxRelayListCache(sqlite, 'ios');
  assert.deepEqual(await restored.read(user, author, () => {}, signal()), {event: signed, fetchedAt: 2000});
  assert.equal(await restored.read(hex(42), author, () => {}, signal()), null);
  assert.equal(await restored.read(user, hex(43), () => {}, signal()), null);
});
test('cache authenticates disk bytes again and fails closed after payload tampering', async t => {
  const {sqlite, cache} = await setup(t), signed = event();
  await cache.write(user, author, {event: signed, fetchedAt: 2000}, () => {}, signal());
  signed.tags[0]![1] = 'wss://relay.damus.io';
  sqlite.raw(OUTBOX_CACHE_DATABASE).prepare('UPDATE relay_lists SET payload = ?').run(JSON.stringify(signed));
  await assert.rejects(cache.read(user, author, () => {}, signal()), (error: unknown) => error instanceof ShellStorageError && error.code === 'CORRUPT_STORAGE');
});
test('older and missing lookup replies retain signed winner; newer empty list revokes routes', async t => {
  const {cache} = await setup(t);
  await cache.write(user, author, {event: event(100), fetchedAt: 1000}, () => {}, signal());
  await cache.write(user, author, {event: event(99), fetchedAt: 2000}, () => {}, signal());
  await cache.write(user, author, {event: null, fetchedAt: 3000}, () => {}, signal());
  assert.equal((await cache.read(user, author, () => {}, signal()))?.event?.created_at, 100);
  await cache.write(user, author, {event: event(101, []), fetchedAt: 4000}, () => {}, signal());
  assert.deepEqual((await cache.read(user, author, () => {}, signal()))?.event?.tags, []);
});
test('queued cancellation and owner revocation cannot write or return cached data', async t => {
  const {sqlite, cache} = await setup(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(cache.write(user, author, {event: event(), fetchedAt: 1000}, () => {}, controller.signal), (e: unknown) => e instanceof ShellStorageError && e.code === 'CANCELLED');
  let live = true;
  sqlite.onStep = sql => { if (sql.startsWith('INSERT INTO relay_lists')) live = false; };
  await assert.rejects(cache.write(user, author, {event: event(), fetchedAt: 1000}, () => {if (!live) throw Error('revoked');}, signal()), (e: unknown) => e instanceof ShellStorageError && e.code === 'REVOKED');
  sqlite.onStep = undefined;
  assert.equal(await cache.read(user, author, () => {}, signal()), null);
});
test('cache quota evicts oldest namespace without allowing unbounded rows', async t => {
  const {sqlite, cache} = await setup(t);
  for (let i = 0; i <= OUTBOX_CACHE_LIMITS.rows; i++) {
    await cache.write(hex(i + 1), author, {event: null, fetchedAt: i}, () => {}, signal());
  }
  assert.equal(await cache.read(hex(1), author, () => {}, signal()), null);
  assert.ok(await cache.read(hex(OUTBOX_CACHE_LIMITS.rows + 1), author, () => {}, signal()));
  const rows = sqlite.raw(OUTBOX_CACHE_DATABASE).prepare('SELECT count(*) AS total FROM relay_lists').get();
  assert.equal(rows?.total, OUTBOX_CACHE_LIMITS.rows);
});
test('failed write rolls back and wrong schema closes instead of reinitializing data', async t => {
  const {sqlite, cache} = await setup(t);
  sqlite.faults.push({prefix: 'INSERT INTO relay_lists', mode: 'before'});
  await assert.rejects(cache.write(user, author, {event: event(), fetchedAt: 1000}, () => {}, signal()), ShellStorageError);
  assert.equal(await cache.read(user, author, () => {}, signal()), null);
  await cache.close();
  sqlite.raw(OUTBOX_CACHE_DATABASE).exec('PRAGMA user_version = 2');
  await assert.rejects(openOutboxRelayListCache(sqlite, 'android'), (e: unknown) => e instanceof ShellStorageError && e.code === 'CORRUPT_STORAGE');
});
