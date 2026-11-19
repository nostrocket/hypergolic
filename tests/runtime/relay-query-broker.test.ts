import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent } from 'nostr-tools/pure';
import { createCapabilityBroker } from '../../src/runtime/capability-broker.ts';
import type { NativeRegistration } from '../../src/runtime/capability-protocol.ts';
import { identityResult } from '../../src/runtime/capability-protocol.ts';
import { NativeLeases } from './native-leases.ts';
import { setup, hex } from '../storage/harness.ts';
const registration = (patch: Partial<NativeRegistration> = {}): NativeRegistration => ({ sessionId: 'feed-lab-1', generation: 'generation-1', epoch: 0,
  user: hex(1), publisher: hex(2), appId: 'feed-lab', version: hex(3), instanceId: 'feed-lab-1', fixture: 'feed-lab', domains: ['relay'], ...patch });
const request = (id = 'query') => ({ type: 'relay.query', id, filters: [{ kinds: [1] }] });
test('only bundled Discover samples public metadata across reachable peers and can retry incomplete empty reads', async t => {
  const {database} = await setup(t), native = new NativeLeases();
  const filters = [{kinds: [30267], '#d': ['napplets'], limit: 32}];
  const signed = finalizeEvent({kind: 30267, created_at: 1, tags: [['d', 'napplets']], content: ''}, new Uint8Array(32).fill(1));
  const event = JSON.parse(JSON.stringify(signed)); // Only wire fields cross the native boundary.
  for (const fixture of ['napplet-discovery', 'feed-lab'] as const) {
    const owner = registration({fixture});
    let calls = 0;
    const broker = createCapabilityBroker(database, native, {registration: owner, assertActive() {}}, {
      async query() {return [];},
      async queryDetailed(received, _signal, active, options) {
        active(); assert.deepEqual(received, filters); assert.equal(options?.completeRelays, true);
        return {incomplete: true, events: ++calls === 1 ? [] : [{event}]};
      },
    }, undefined, undefined, undefined, undefined, undefined, true);
    const expected = fixture === 'napplet-discovery' ? [{error: 'relay query failed'}, {events: [{event}]}] : [{events: []}, {events: []}];
    for (const [index, payload] of expected.entries()) {
      const id = `read-${index}`;
      const token = native.add(owner, {type: 'relay.query', id, filters});
      await broker.dispatch(token);
      assert.deepEqual(native.results.get(token), {type: 'relay.query.result', id, ...payload});
    }
    assert.equal(calls, fixture === 'napplet-discovery' ? 2 : 0);
  }
});

test('query broker preserves native correlation and canonical empty/error semantics without SQL', async t => {
  const { database, sqlite } = await setup(t), native = new NativeLeases(), owner = registration();
  let fail = false, calls = 0;
  const broker = createCapabilityBroker(database, native, { registration: owner, assertActive() {} }, { query: async () => { calls++; if (fail) throw new Error('offline'); return []; } });
  const before = sqlite.calls.length;
  const first = native.add(owner, request()); await broker.dispatch(first);
  assert.deepEqual(native.results.get(first), { type: 'relay.query.result', id: 'query', events: [] });
  fail = true;
  const second = native.add(owner, request('failure')); await broker.dispatch(second);
  assert.deepEqual(native.results.get(second), { type: 'relay.query.result', id: 'failure', error: 'relay query failed' });
  assert.equal(sqlite.calls.length, before); assert.equal(calls, 2);
});
test('missing grant, foreign generation and invalid filters cannot dispatch a read', async t => {
  const { database } = await setup(t), native = new NativeLeases(); let calls = 0;
  for (const [owner, captured, wire] of [
    [registration({ domains: ['identity'] }), registration({ domains: ['identity'] }), request()],
    [registration(), registration({ generation: 'foreign' }), request()],
    [registration(), registration(), { ...request(), filters: [{ authors: ['partial'] }] }],
    [registration(), registration(), { ...request(), user: hex(4) }],
  ] as const) {
    const broker = createCapabilityBroker(database, native, { registration: owner, assertActive() {} }, { query: async () => { calls++; return []; } });
    const token = native.add(captured, wire); await broker.dispatch(token);
    const result = native.results.get(token);
    assert.ok(result === null || (result as { error?: string }).error === 'invalid relay query');
  }
  assert.equal(calls, 0);
});
test('correlation reuse cannot cause a second read', async t => {
  const { database } = await setup(t), native = new NativeLeases(), owner = registration(); let calls = 0;
  const broker = createCapabilityBroker(database, native, { registration: owner, assertActive() {} }, { query: async () => { calls++; return []; } });
  const first = native.add(owner, request()), second = native.add(owner, { ...request(), filters: [{}] });
  await broker.dispatch(first); await broker.dispatch(second); assert.equal(calls, 1);
  assert.equal((native.results.get(second) as { error: string }).error, 'request already used or session limit reached');
});
for (const reason of ['broker', 'native', 'identity']) test(`in-flight ${reason} revocation aborts service and prevents stale delivery`, async t => {
  const { database } = await setup(t), native = new NativeLeases(), owner = registration(); let active = true, aborted = false;
  const broker = createCapabilityBroker(database, native, { registration: owner, assertActive() { if (!active) throw new Error('identity changed'); } },
    { query: async (_, signal) => new Promise((resolve) => signal.addEventListener('abort', () => { aborted = true; resolve([]); }, { once: true })) });
  const token = native.add(owner, request()), dispatch = broker.dispatch(token);
  if (reason === 'broker') broker.revoke(); else if (reason === 'native') native.revoke(token); else active = false;
  await dispatch; assert.equal(aborted, true); assert.equal(native.results.get(token), null);
});

test('public startup reads wait behind two active reads while a protected request still fails promptly', async t => {
  const {database} = await setup(t), native = new NativeLeases(), owner = registration({domains: ['identity','relay']});
  const started: string[] = [], release: Array<() => void> = [];
  const hold = (name: string) => new Promise<void>(resolve => {started.push(name); release.push(resolve);});
  const broker = createCapabilityBroker(database, native, {registration: owner, assertActive() {}}, {
    async query() {await hold('relay.query'); return [];},
  }, undefined, undefined, {
    async read(wire) {await hold(wire.type); return identityResult(wire, owner.user);},
  });
  const token = (type: string) => native.add(owner, {type, id: type});
  const profile = broker.dispatch(token('identity.getProfile')), relays = broker.dispatch(token('identity.getRelays'));
  const followsToken = token('identity.getFollows'), follows = broker.dispatch(followsToken);
  const queryToken = native.add(owner, request()), query = broker.dispatch(queryToken);
  const protectedToken = token('identity.getMutes');
  await broker.dispatch(protectedToken);
  assert.equal((native.results.get(protectedToken) as {error: string}).error, 'identity data busy');
  assert.deepEqual(started, ['identity.getProfile','identity.getRelays']);
  release[0]!(); await profile;
  assert.deepEqual(started, ['identity.getProfile','identity.getRelays','identity.getFollows']);
  release[1]!(); await relays;
  assert.deepEqual(started, ['identity.getProfile','identity.getRelays','identity.getFollows','relay.query']);
  release[2]!(); release[3]!();
  await Promise.all([follows,query]);
  assert.deepEqual(native.results.get(followsToken), {type:'identity.getFollows.result',id:'identity.getFollows',pubkeys:[]});
  assert.deepEqual(native.results.get(queryToken), {type:'relay.query.result',id:'query',events:[]});
});

test('a queued public read whose original native lease expires never starts', async t => {
  const {database} = await setup(t), native = new NativeLeases(), owner = registration();
  const release: Array<() => void> = [];
  const broker = createCapabilityBroker(database, native, {registration:owner, assertActive() {}}, {
    async query() {await new Promise<void>(resolve => release.push(resolve)); return [];},
  });
  const first = broker.dispatch(native.add(owner, request('first')));
  const second = broker.dispatch(native.add(owner, request('second')));
  const revoked = native.add(owner, request('revoked'));
  const waiting = broker.dispatch(revoked);
  native.revoke(revoked);
  release[0]!(); release[1]!();
  await Promise.all([first, second, waiting]);
  assert.equal(release.length, 2);
  assert.equal(native.results.get(revoked), null);
});
