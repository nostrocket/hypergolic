import assert from 'node:assert/strict';
import test from 'node:test';
import { finalizeEvent, getPublicKey, type NostrEvent } from 'nostr-tools/pure';
import { openIdentityCache, IDENTITY_DATA_DATABASE } from '../../src/identity/identity-cache.ts';
import { createIdentityDataService } from '../../src/identity/identity-service.ts';
import { IDENTITY_LIMITS, profileFromEvents, verifiedProfileEvents } from '../../src/identity/identity-contract.ts';
import { RelayQueryError } from '../../src/network/relay-query-contract.ts';
import { DiskSQLite, deferred, hex } from '../storage/harness.ts';
import type { NativeRegistration } from '../../src/runtime/capability-protocol.ts';
const secret = new Uint8Array(32); secret[31] = 1;
const user = getPublicKey(secret);
const registration: NativeRegistration = { user, publisher: hex(2), appId: 'state-lab', version: hex(3), instanceId: 'one', sessionId: 'one', generation: 'generation', epoch: 0, fixture: 'state-lab', domains: ['identity', 'storage', 'theme'] };
function event(content: unknown, created = 10): NostrEvent {
  const signed = finalizeEvent({ kind: 0, created_at: created, tags: [], content: JSON.stringify(content) }, secret);
  return JSON.parse(JSON.stringify(signed)) as NostrEvent;
}
const request = { type: 'identity.getProfile', id: 'profile-1' } as const;
const signal = () => new AbortController().signal;
async function setup(t: { after(fn: () => void): void }) {
  const sqlite = new DiskSQLite(); t.after(() => sqlite.cleanup());
  return { sqlite, cache: await openIdentityCache(sqlite, 'android') };
}
test('signed profile allowlist maps display_name and treats strings as literal data', () => {
  const signed = event({ name: '<script>literal</script>', display_name: '雪', displayName: 'deprecated', bot: true, birthday: {}, about: 'A\0B', picture: 'https://private.example/image', unknown: 'discard' });
  const verified = verifiedProfileEvents([signed], user);
  assert.deepEqual(profileFromEvents(verified), { name: '<script>literal</script>', displayName: '雪', about: 'A\0B', picture: 'https://private.example/image' });
  assert.equal(profileFromEvents([]), null);
});
for (const delta of ['bad-signature', 'wrong-user', 'wrong-kind', 'mutated-content', 'invalid-json', 'array-content', 'wrong-field-type', 'oversize']) test(`profile rejects ${delta}`, () => {
  let signed = event({ name: 'Original' });
  if (delta === 'bad-signature') signed = { ...signed, sig: '0'.repeat(128) };
  if (delta === 'wrong-user') signed = { ...signed, pubkey: hex(5) };
  if (delta === 'wrong-kind') signed = JSON.parse(JSON.stringify(finalizeEvent({ kind: 3, content: '', tags: [], created_at: 10 }, secret))) as NostrEvent;
  if (delta === 'mutated-content') signed = { ...signed, content: '{}' };
  if (delta === 'invalid-json') signed = JSON.parse(JSON.stringify(finalizeEvent({ kind: 0, content: '{', tags: [], created_at: 10 }, secret))) as NostrEvent;
  if (delta === 'array-content') signed = event([]);
  if (delta === 'wrong-field-type') signed = event({ name: 42 });
  if (delta === 'oversize') signed = event({ name: 'x'.repeat(257) });
  assert.throws(() => profileFromEvents(verifiedProfileEvents([signed], user)));
});
test('fresh cache avoids network; older offline data survives real SQLite cold reopen', async t => {
  const { sqlite, cache } = await setup(t); let now = 1000, calls = 0;
  const signed = event({ name: 'Known profile', display_name: 'Known display' });
  const online = createIdentityDataService(cache, { async query(filters) { calls++; assert.deepEqual(filters[0]!.authors, [user]); return [{ event: signed }]; } }, () => now);
  assert.deepEqual(await online.read(request, registration, signal(), () => {}), { type: 'identity.getProfile.result', id: request.id, profile: { name: 'Known profile', displayName: 'Known display' } });
  now += IDENTITY_LIMITS.freshMs - 1;
  await online.read(request, registration, signal(), () => {}); assert.equal(calls, 1);
  await cache.close();
  const reopened = await openIdentityCache(sqlite, 'android');
  const offline = createIdentityDataService(reopened, { async query() { calls++; throw new RelayQueryError(); } }, () => now + 2);
  const restored = await offline.read(request, registration, signal(), () => {});
  assert.deepEqual(restored.profile, { name: 'Known profile', displayName: 'Known display' });
  assert.equal(restored.error, undefined); assert.equal(calls, 2);
  const foreign = await offline.read(request, { ...registration, user: hex(5) }, signal(), () => {});
  assert.equal(foreign.profile, null); assert.equal(foreign.error, 'identity data unavailable');
});
test('verified missing is successful null; no-cache offline is canonical error', async t => {
  const { cache } = await setup(t);
  const missing = createIdentityDataService(cache, { async query() { return []; } }, () => 1000);
  assert.deepEqual(await missing.read(request, registration, signal(), () => {}), { type: 'identity.getProfile.result', id: request.id, profile: null });
  const offline = createIdentityDataService(cache, { async query() { throw new RelayQueryError(); } }, () => IDENTITY_LIMITS.freshMs + 1001);
  assert.equal((await offline.read(request, registration, signal(), () => {})).error, undefined, 'cached verified absence is an offline snapshot');
  const neverCached = await offline.read(request, { ...registration, user: hex(5) }, signal(), () => {});
  assert.deepEqual(neverCached, { type: 'identity.getProfile.result', id: request.id, profile: null, error: 'identity data unavailable' });
});
test('malformed fresh metadata cannot poison or silently fall back to a good cache', async t => {
  const { cache } = await setup(t); const good = event({ name: 'Good' });
  await cache.write(user, 'profile', { fetchedAt: 1000, events: [good] }, () => {}, signal());
  const broken = createIdentityDataService(cache, { async query() { return [{ event: event({ name: [] }, 11) }]; } }, () => IDENTITY_LIMITS.freshMs + 1001);
  const result = await broken.read(request, registration, signal(), () => {});
  assert.equal(result.profile, null); assert.equal(result.error, 'invalid profile metadata');
  assert.equal((await cache.read(user, 'profile', () => {}, signal()))!.events[0]!.id, good.id);
});
test('older signed replies and empty EOSE cannot resurrect or remove newer metadata', async t => {
  const { cache } = await setup(t); const newest = event({ name: 'New' }, 20), old = event({ name: 'Old' }, 10);
  await cache.write(user, 'profile', { fetchedAt: 1, events: [newest] }, () => {}, signal());
  const older = createIdentityDataService(cache, { async query() { return [{ event: old }]; } }, () => IDENTITY_LIMITS.freshMs + 10);
  assert.deepEqual((await older.read(request, registration, signal(), () => {})).profile, { name: 'New' });
  const empty = createIdentityDataService(cache, { async query() { return []; } }, () => 3 * IDENTITY_LIMITS.freshMs);
  assert.deepEqual((await empty.read(request, registration, signal(), () => {})).profile, { name: 'New' });
});
test('same-time replacement uses lowest event ID and signed empty metadata clears prior fields', async t => {
  const a = event({ name: 'A' }, 20), b = event({ name: 'B' }, 20);
  const expected = a.id < b.id ? 'A' : 'B';
  assert.deepEqual(profileFromEvents(verifiedProfileEvents([a, b], user)), { name: expected });
  const { cache } = await setup(t); await cache.write(user, 'profile', { fetchedAt: 0, events: [a] }, () => {}, signal());
  const cleared = createIdentityDataService(cache, { async query() { return [{ event: event({}, 21) }]; } }, () => IDENTITY_LIMITS.freshMs + 1);
  assert.deepEqual((await cleared.read(request, registration, signal(), () => {})).profile, {});
});
test('tampered disk event cannot acquire validity from a previously verified object', async t => {
  const { sqlite, cache } = await setup(t); const signed = event({ name: 'Original' });
  await cache.write(user, 'profile', { fetchedAt: 1000, events: [signed] }, () => {}, signal());
  const db = sqlite.raw(IDENTITY_DATA_DATABASE); db.prepare('UPDATE identity_cache SET payload = ?').run(JSON.stringify([{ ...signed, content: '{"name":"Forged"}' }]));
  const service = createIdentityDataService(cache, { async query() { throw Error('must not query corrupt cache'); } }, () => 1001);
  assert.equal((await service.read(request, registration, signal(), () => {})).error, 'invalid identity data');
});
test('native revocation during SQLite commit prevents successful delivery despite durable public data', async t => {
  const { sqlite, cache } = await setup(t); let live = true;
  sqlite.onStep = sql => { if (sql === 'COMMIT') live = false; };
  const service = createIdentityDataService(cache, { async query() { return [{ event: event({ name: 'Known' }) }]; } }, () => 1000);
  await assert.rejects(service.read(request, registration, signal(), () => { if (!live) throw Error('revoked'); }), /revoked/);
  assert.equal(sqlite.raw(IDENTITY_DATA_DATABASE).prepare('SELECT count(*) AS n FROM identity_cache').get()!.n, 1);
});
test('abort releases request quota promptly even if a port ignores cancellation; late result cannot write', async t => {
  const { cache, sqlite } = await setup(t), held = deferred(); let calls = 0;
  const service = createIdentityDataService(cache, { async query() { calls++; await held.promise; return [{ event: event({ name: 'Late' }) }]; } }, () => 1000);
  const controller = new AbortController(); const pending = service.read(request, registration, controller.signal, () => {});
  while (calls === 0) await new Promise(resolve => setImmediate(resolve));
  const busy = await service.read({ ...request, id: 'duplicate' }, registration, signal(), () => {}); assert.equal(busy.error, 'identity data busy');
  controller.abort(); await assert.rejects(pending, /cancelled/);
  held.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(sqlite.raw(IDENTITY_DATA_DATABASE).prepare('SELECT count(*) AS n FROM identity_cache').get()!.n, 0);
});
test('transactional cache eviction stays bounded and keeps users isolated', async t => {
  const { cache, sqlite } = await setup(t);
  for (let n = 1; n <= IDENTITY_LIMITS.cacheRows + 1; n++) await cache.write(hex(n), 'profile', { fetchedAt: n, events: [] }, () => {}, signal());
  assert.equal(sqlite.raw(IDENTITY_DATA_DATABASE).prepare('SELECT count(*) AS n FROM identity_cache').get()!.n, IDENTITY_LIMITS.cacheRows);
  assert.equal(await cache.read(hex(1), 'profile', () => {}, signal()), null);
  assert.deepEqual((await cache.read(hex(65), 'profile', () => {}, signal()))!.events, []);
});
test('a failed or lost-acknowledgement cache commit is not reported as a successful identity read', async t => {
  const { cache, sqlite } = await setup(t); sqlite.faults.push({ prefix: 'COMMIT', mode: 'after' });
  const service = createIdentityDataService(cache, { async query() { return [{ event: event({ name: 'Known' }) }]; } }, () => 1000);
  const result = await service.read(request, registration, signal(), () => {});
  assert.equal(result.profile, null); assert.equal(result.error, 'identity data unavailable');
});
