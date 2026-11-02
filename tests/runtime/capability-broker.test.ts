import assert from 'node:assert/strict';
import test from 'node:test';
import { createCapabilityBroker } from '../../src/runtime/capability-broker.ts';
import { CAPABILITY_LIMITS, decodeNativeRegistration, IDENTITY_OPERATIONS, parseCapabilityRequest,
  type NativeRegistration } from '../../src/runtime/capability-protocol.ts';
import { NativeLeases } from './native-leases.ts';
import { openShellDatabase } from '../../src/storage/database.ts';
import { deferred, hex, setup } from '../storage/harness.ts';

function registration(patch: Partial<NativeRegistration> = {}): NativeRegistration {
  return { sessionId: 'state-lab-1', generation: 'native-generation-1', epoch: 0,
    user: hex(1), publisher: hex(2), appId: 'state-lab', version: hex(3),
    instanceId: 'state-lab-1', fixture: 'state-lab', domains: ['theme', 'identity', 'storage'], ...patch };
}
test('real SQLite write/read/remove/list preserve original IDs, literal strings and empty-vs-missing', async t => {
  const { database } = await setup(t), native = new NativeLeases(), config = registration();
  const broker = createCapabilityBroker(database, native, { registration: config, assertActive() {} });
  async function invoke(request: unknown) { const token = native.add(config, request); await broker.dispatch(token); return native.results.get(token); }
  assert.deepEqual(await invoke({ type: 'storage.get', id: 'missing', key: '' }), { type: 'storage.get.result', id: 'missing', value: null });
  assert.deepEqual(await invoke({ type: 'storage.set', id: 'write', key: '', value: '' }), { type: 'storage.set.result', id: 'write' });
  assert.deepEqual(await invoke({ type: 'storage.get', id: 'empty', key: '' }), { type: 'storage.get.result', id: 'empty', value: '' });
  const value = '<b>🧪</b>\0你好';
  await invoke({ type: 'storage.set', id: 'literal', key: 'instance:other|__proto__', value });
  assert.deepEqual(await invoke({ type: 'storage.keys', id: 'list' }), { type: 'storage.keys.result', id: 'list', keys: ['', 'instance:other|__proto__'] });
  assert.deepEqual(await invoke({ type: 'storage.get', id: 'read', key: 'instance:other|__proto__' }), { type: 'storage.get.result', id: 'read', value });
  assert.deepEqual(await invoke({ type: 'storage.remove', id: 'remove', key: '' }), { type: 'storage.remove.result', id: 'remove' });
  assert.deepEqual(await invoke({ type: 'storage.get', id: 'removed', key: '' }), { type: 'storage.get.result', id: 'removed', value: null });
});

test('every identity read has the selected owning shape and no SQL or signer access', async t => {
  const { database, sqlite } = await setup(t), native = new NativeLeases(), config = registration();
  const broker = createCapabilityBroker(database, native, { registration: config, assertActive() {} });
  const before = sqlite.calls.length;
  const expected: Record<string, unknown> = { getPublicKey: { pubkey: hex(1) }, getRelays: { relays: {} }, getProfile: { profile: null },
    getFollows: { pubkeys: [] }, getMutes: { pubkeys: [] }, getBlocked: { pubkeys: [] }, getList: { entries: [] }, getZaps: { zaps: [] }, getBadges: { badges: [] } };
  for (const type of IDENTITY_OPERATIONS) {
    const token = native.add(config, { type, id: type, ...(type === 'identity.getList' ? { listType: 'bookmarks' } : {}) });
    await broker.dispatch(token);
    assert.deepEqual(native.results.get(token), { type: type + '.result', id: type, ...expected[type.split('.')[1]]! });
  }
  assert.equal(sqlite.calls.length, before);
});

test('native-bound user, publisher, app, version and instance namespaces remain separate after reopen', async t => {
  const { database, sqlite } = await setup(t), native = new NativeLeases();
  async function invoke(config: NativeRegistration, request: unknown, db = database) {
    const broker = createCapabilityBroker(db, native, { registration: config, assertActive() {} });
    const token = native.add(config, request); await broker.dispatch(token); return native.results.get(token);
  }
  const config = registration();
  await invoke(config, { type: 'storage.set', id: 'shared', key: 'sample', value: 'shared' });
  await invoke(config, { type: 'storage.set', id: 'instance', key: 'sample', value: 'instance', scope: 'instance' });
  for (const delta of [{ user: hex(4) }, { publisher: hex(4) }, { appId: 'state-lab-peer' }, { version: hex(4) }]) {
    assert.deepEqual(await invoke(registration(delta), { type: 'storage.get', id: 'read', key: 'sample' }), { type: 'storage.get.result', id: 'read', value: null });
  }
  const other = registration({ instanceId: 'state-lab-2' });
  assert.deepEqual(await invoke(other, { type: 'storage.get', id: 'shared', key: 'sample' }), { type: 'storage.get.result', id: 'shared', value: 'shared' });
  assert.deepEqual(await invoke(other, { type: 'storage.get', id: 'instance', key: 'sample', scope: 'instance' }), { type: 'storage.get.result', id: 'instance', value: null });
  await database.close();
  const reopened = await openShellDatabase(sqlite, 'android');
  assert.deepEqual(await invoke(registration({ generation: 'native-generation-2' }), { type: 'storage.get', id: 'restart', key: 'sample', scope: 'instance' }, reopened), { type: 'storage.get.result', id: 'restart', value: 'instance' });
});

for (const field of ['user', 'publisher', 'instanceId', 'version', 'appId']) test(`caller-selected ${field} cannot redirect storage`, async t => {
  const { database, sqlite } = await setup(t), native = new NativeLeases(), config = registration();
  const broker = createCapabilityBroker(database, native, { registration: config, assertActive() {} });
  const before = sqlite.calls.length;
  const token = native.add(config, { type: 'storage.set', id: 'invalid', key: 'sample', value: 'no', [field]: 'forged' });
  await broker.dispatch(token);
  assert.deepEqual(native.results.get(token), { type: 'storage.set.result', id: 'invalid', error: 'invalid storage request' });
  assert.equal(sqlite.calls.length, before);
});

test('foreign native registration, absent domains, signer requests and invalid correlation are denied before SQL', async t => {
  const { database, sqlite } = await setup(t), native = new NativeLeases(), config = registration();
  const broker = createCapabilityBroker(database, native, { registration: config, assertActive() {} });
  const before = sqlite.calls.length;
  for (const [owner, request] of [
    [registration({ generation: 'replacement' }), { type: 'storage.get', id: 'foreign', key: 'sample' }],
    [config, { type: 'identity.signEvent', id: 'sign', event: {} }],
    [config, { type: 'storage.get', id: '', key: 'sample' }],
  ] as const) { const token = native.add(owner, request); await broker.dispatch(token); assert.equal(native.results.get(token), null); }
  const noStorage = registration({ domains: ['identity'] });
  const restricted = createCapabilityBroker(database, native, { registration: noStorage, assertActive() {} });
  const denied = native.add(noStorage, { type: 'storage.get', id: 'absent', key: 'sample' });
  await restricted.dispatch(denied); assert.equal(native.results.get(denied), null);
  assert.equal(sqlite.calls.length, before);
});

test('duplicate or mutated request IDs cannot write again; duplicated native delivery cannot finish another consumer', async t => {
  const { database, sqlite } = await setup(t), native = new NativeLeases(), config = registration();
  const broker = createCapabilityBroker(database, native, { registration: config, assertActive() {} });
  const entered = deferred(), release = deferred(); let held = false;
  sqlite.onStep = async sql => { if (sql === 'BEGIN IMMEDIATE' && !held) { held = true; entered.resolve(); await release.promise; } };
  const token = native.add(config, { type: 'storage.set', id: 'same-id', key: 'sample', value: 'first' });
  const pending = broker.dispatch(token); await entered.promise;
  await broker.dispatch(token); assert.equal(native.finishCalls, 0);
  release.resolve(); await pending;
  assert.deepEqual(native.results.get(token), { type: 'storage.set.result', id: 'same-id' });
  const before = sqlite.calls.length;
  for (const value of ['first', 'modified']) {
    const duplicate = native.add(config, { type: 'storage.set', id: 'same-id', key: 'sample', value });
    await broker.dispatch(duplicate);
    assert.deepEqual(native.results.get(duplicate), { type: 'storage.set.result', id: 'same-id', error: 'request already used or session limit reached' });
  }
  assert.equal(sqlite.calls.length, before);
});

for (const scope of ['invalid', '', null]) test(`invalid storage scope ${String(scope)} has a canonical error and no effect`, async t => {
  const { database, sqlite } = await setup(t), native = new NativeLeases(), config = registration();
  const broker = createCapabilityBroker(database, native, { registration: config, assertActive() {} });
  const before = sqlite.calls.length;
  const token = native.add(config, { type: 'storage.get', id: 'scope', key: '', scope });
  await broker.dispatch(token);
  assert.deepEqual(native.results.get(token), { type: 'storage.get.result', id: 'scope', error: 'invalid storage request' });
  assert.equal(sqlite.calls.length, before);
});

test('snapshot payload stays immutable across asynchronous SQL and quota failure leaves earlier data intact', async t => {
  const { database, sqlite } = await setup(t), native = new NativeLeases(), config = registration();
  const broker = createCapabilityBroker(database, native, { registration: config, assertActive() {} });
  const request = { type: 'storage.set', id: 'original', key: 'first', value: 'x'.repeat(200_000) };
  const token = native.add(config, request); request.value = 'mutated';
  await broker.dispatch(token);
  const next = native.add(config, { ...request, id: 'second', key: 'second', value: 'y'.repeat(200_000) }); await broker.dispatch(next);
  const full = native.add(config, { ...request, id: 'quota', key: 'third', value: 'z'.repeat(200_000) }); await broker.dispatch(full);
  assert.deepEqual(native.results.get(full), { type: 'storage.set.result', id: 'quota', error: 'storage quota exceeded' });
  const rows = sqlite.raw().prepare('SELECT key, length(value) AS size FROM saved_strings ORDER BY key').all();
  assert.deepEqual(rows.map(row => ({ ...row })), [{ key: 'first', size: 200_000 }, { key: 'second', size: 200_000 }]);
});

for (const revoke of ['native', 'identity', 'broker'] as const) test(`${revoke} revocation while SQL awaits rolls back and suppresses success`, async t => {
  const { database, sqlite } = await setup(t), native = new NativeLeases(), config = registration(); let identityActive = true;
  const broker = createCapabilityBroker(database, native, { registration: config, assertActive() { assert(identityActive); } });
  const entered = deferred(), release = deferred(); let held = false;
  sqlite.onStep = async sql => { if (sql.startsWith('INSERT INTO saved_strings') && !held) { held = true; entered.resolve(); await release.promise; } };
  const token = native.add(config, { type: 'storage.set', id: 'cancel', key: 'sample', value: 'must roll back' });
  const pending = broker.dispatch(token); await entered.promise;
  if (revoke === 'native') native.revoke(token); else if (revoke === 'identity') identityActive = false; else broker.revoke();
  release.resolve(); await pending;
  assert.equal(native.results.get(token), null);
  assert.equal(sqlite.raw().prepare('SELECT count(*) AS count FROM saved_strings').get()!.count, 0);
});

test('native expiry while queued rejects before the first write', async t => {
  const { database, sqlite } = await setup(t), native = new NativeLeases(), config = registration();
  const broker = createCapabilityBroker(database, native, { registration: config, assertActive() {} });
  const entered = deferred(), release = deferred(); let held = false;
  sqlite.onStep = async sql => { if (sql === 'BEGIN IMMEDIATE' && !held) { held = true; entered.resolve(); await release.promise; } };
  const one = native.add(config, { type: 'storage.set', id: 'one', key: 'one', value: 'one' });
  const first = broker.dispatch(one); await entered.promise;
  const two = native.add(config, { type: 'storage.set', id: 'two', key: 'two', value: 'two' });
  const second = broker.dispatch(two); native.revoke(two); release.resolve(); await Promise.all([first, second]);
  assert.equal(native.results.get(two), null);
  assert.deepEqual(sqlite.raw().prepare('SELECT key FROM saved_strings').all().map(row => row.key), ['one']);
});

test('revocation after COMMIT leaves committed data but never sends a stale success', async t => {
  const { database, sqlite } = await setup(t), native = new NativeLeases(), config = registration(); let active = true;
  const broker = createCapabilityBroker(database, native, { registration: config, assertActive() { assert(active); } });
  sqlite.onStep = sql => { if (sql === 'COMMIT') active = false; };
  const token = native.add(config, { type: 'storage.set', id: 'commit', key: 'sample', value: 'committed' });
  await broker.dispatch(token); assert.equal(native.results.get(token), null);
  assert.equal(sqlite.raw().prepare('SELECT value FROM saved_strings').get()!.value, 'committed');
});

test('correlation history is bounded without silently forgetting used IDs', async t => {
  const { database, sqlite } = await setup(t), native = new NativeLeases(), config = registration();
  const broker = createCapabilityBroker(database, native, { registration: config, assertActive() {} });
  const before = sqlite.calls.length;
  for (let i = 0; i < CAPABILITY_LIMITS.sessionRequests; i++) {
    const token = native.add(config, { type: 'identity.getPublicKey', id: String(i) }); await broker.dispatch(token);
    assert.notEqual(native.results.get(token), null);
  }
  const exhausted = native.add(config, { type: 'storage.set', id: 'exhausted', key: 'x', value: 'y' });
  await broker.dispatch(exhausted); assert.deepEqual(native.results.get(exhausted), { type: 'storage.set.result', id: 'exhausted', error: 'request already used or session limit reached' });
  assert.equal(sqlite.calls.length, before);
});

test('capability requests retain strict field checks without Object.hasOwn', () => {
  const descriptor = Object.getOwnPropertyDescriptor(Object, 'hasOwn');
  assert.ok(descriptor);
  Object.defineProperty(Object, 'hasOwn', { configurable: true, value: undefined });
  try {
    assert.deepEqual(parseCapabilityRequest({ type: 'storage.get', id: 'legacy', key: 'draft' }),
      { type: 'storage.get', id: 'legacy', scope: 'shared', key: 'draft' });
    assert.equal(decodeNativeRegistration(registration()).appId, 'state-lab');
    assert.throws(() => parseCapabilityRequest({ type: 'storage.get', id: 'legacy', key: 'draft', extra: true }));
  } finally { Object.defineProperty(Object, 'hasOwn', descriptor); }
});

test('request parser rejects getters, forged result types, extra fields and non-round-tripping strings', () => {
  for (const request of [[], null, { type: 'storage.get.result', id: 'x', value: 'y' },
    { type: 'storage.set', id: 'x', key: '', value: '\ud800' },
    { type: 'storage.get', id: 'x', key: 'x', get user() { throw new Error('getter must not execute'); } },
    { type: 'identity.getPublicKey', id: 'x', publisher: hex(9) }]) assert.throws(() => parseCapabilityRequest(request));
  assert.throws(() => decodeNativeRegistration(registration({ domains: ['identity', 'identity'] })));
  assert.deepEqual(decodeNativeRegistration(registration({ domains: ['intent','inc'] })).domains, ['inc','intent']);
  assert.throws(() => decodeNativeRegistration(registration({ domains: ['webrtc'] })));
  assert.deepEqual(decodeNativeRegistration(registration({ domains: ['relay'] })).domains, ['relay']);
  assert.throws(() => parseCapabilityRequest({ type: 'relay.publish', id: 'approval-only', event: {} }));
});


test('maximum control-character strings round trip within the native request and reply byte bounds', async t => {
  const { database } = await setup(t), native = new NativeLeases(), config = registration();
  const broker = createCapabilityBroker(database, native, { registration: config, assertActive() {} });
  const key = '\0'.repeat(1024), value = '\0'.repeat(256 * 1024);
  const message = JSON.stringify({ type: 'storage.set', id: 'maximum', key, value });
  const snapshot = JSON.stringify({ registration: config, request: message });
  assert(Buffer.byteLength(snapshot) <= CAPABILITY_LIMITS.messageBytes);
  const write = native.add(config, JSON.parse(message)); await broker.dispatch(write);
  assert.deepEqual(native.results.get(write), { type: 'storage.set.result', id: 'maximum' });
  const read = native.add(config, { type: 'storage.get', id: 'read-maximum', key }); await broker.dispatch(read);
  assert.deepEqual(native.results.get(read), { type: 'storage.get.result', id: 'read-maximum', value });
  const response = JSON.stringify({ type: 'capability.result', sessionId: config.generation, sequence: 2,
    response: JSON.stringify(native.results.get(read)) });
  assert(Buffer.byteLength(response) <= CAPABILITY_LIMITS.messageBytes);
});
