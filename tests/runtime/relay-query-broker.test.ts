import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapabilityBroker } from '../../src/runtime/capability-broker.ts';
import type { NativeRegistration } from '../../src/runtime/capability-protocol.ts';
import { NativeLeases } from './native-leases.ts';
import { setup, hex } from '../storage/harness.ts';
const registration = (patch: Partial<NativeRegistration> = {}): NativeRegistration => ({ sessionId: 'feed-lab-1', generation: 'generation-1', epoch: 0,
  user: hex(1), publisher: hex(2), appId: 'feed-lab', version: hex(3), instanceId: 'feed-lab-1', fixture: 'feed-lab', domains: ['relay'], ...patch });
const request = (id = 'query') => ({ type: 'relay.query', id, filters: [{ kinds: [1] }] });
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
