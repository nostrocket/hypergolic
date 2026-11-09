import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { finalizeEvent, type NostrEvent } from 'nostr-tools/pure';
import { CATALOG_PAGE, parseCatalogPageRequest } from '../../src/napplets/catalog-page-contract.ts';
import { createCatalogPaging } from '../../src/napplets/catalog-paging.ts';
import { createNativeRelayQuery } from '../../src/network/native-relay-query.ts';
import { createCapabilityBroker } from '../../src/runtime/capability-broker.ts';
import type { NativeRegistration } from '../../src/runtime/capability-protocol.ts';
import { deferred, hex, setup } from '../storage/harness.ts';
import { NativeLeases } from './native-leases.ts';

const relayA = 'wss://exclusive-fixture.example.org';
const relayB = 'wss://other-fixture.example.org';
const secret = Uint8Array.from({length: 32}, (_, index) => index + 1);
const event = (created_at: number, identifier: string) => finalizeEvent({
  kind: 35129, created_at, content: 'Fixture publication',
  tags: [['d', identifier], ['x', hex(5)], ['server', 'https://fixture.example.org']],
}, secret);
const exclusive = event(88, 'exclusive-publication');
const healthy = Array.from({length: 35}, (_, i) => event(100 - i, 'healthy-' + i));
const round = '1'.repeat(32);
const request = (after: number, nextRound = round) => parseCatalogPageRequest({
  type: CATALOG_PAGE, id: 'query-' + after, reset: after === 0, round: nextRound, after,
});

function fixture(options: {failure?: 'throw' | 'missing-eose' | 'duplicate'; failures?: number; ties?: boolean} = {}) {
  const calls: {relay: string; until: number; since?: number; failure: boolean}[] = [];
  let relays = [relayA, relayB];
  const ties = options.ties ? Array.from({length: 32}, (_, i) => event(100, 'tie-' + i)) : [];
  const service = createNativeRelayQuery({
    newInstanceId: randomUUID,
    cancelPublishedRelay() {},
    async queryPublishedRelay(_operation, relay, raw, subscription) {
      const [type, id, filter] = JSON.parse(raw);
      assert.equal(type, 'REQ'); assert.equal(id, subscription); assert.deepEqual(filter.kinds, [35129]);
      const failure = relay === relayA && calls.filter(call => call.relay === relayA).length < (options.failures ?? 0);
      calls.push({relay, until: filter.until, since: filter.since, failure});
      const candidates = relay === relayA ? options.ties ? ties : [exclusive] : healthy;
      const rows = candidates.filter(event => event.created_at <= filter.until && event.created_at >= (filter.since ?? 0)).slice(0, filter.limit);
      if (failure && options.failure === 'throw') throw Error('Fixture transport failed before EOSE');
      const events = rows.map(event => JSON.stringify(['EVENT', subscription, event]));
      if (failure && options.failure === 'missing-eose') return events;
      if (failure && options.failure === 'duplicate') events.push(...events);
      return [...events, JSON.stringify(['EOSE', subscription])];
    },
  }, () => relays);
  const paging = createCatalogPaging(service.catalog!, () => 100);
  const run = (after: number, nextRound?: string, signal = new AbortController().signal) => paging(request(after, nextRound), signal, () => {});
  return {calls, run, service, setRelays(value: string[]) {relays = value;}};
}

for (const failure of ['throw', 'missing-eose', 'duplicate'] as const) {
  test('healthy pages advance while a sole-source publication survives ' + failure, async () => {
    const f = fixture({failure, failures: 3});
    for (let i = 0; i < 3; i++) {
      const page = await f.run(i);
      assert.equal(page.partial, true);
      assert.equal(page.events.length, 8);
      assert(!page.events.some(row => (row as {event: NostrEvent}).event.id === exclusive.id));
    }
    const recovered = await f.run(3);
    assert.equal(recovered.partial, false);
    assert(recovered.events.some(row => (row as {event: NostrEvent}).event.id === exclusive.id));
    assert.deepEqual(f.calls.filter(call => call.relay === relayA).map(call => call.until), [100, 100, 100, 100]);
    assert.deepEqual(f.calls.filter(call => call.relay === relayB).map(call => call.until), [100, 93, 86, 79]);
  });
}

test('lost pages replay without network and ACK is specific to a refresh round and settings', async () => {
  const f = fixture();
  const first = await f.run(0);
  assert.equal(await f.run(0), first);
  assert.equal(f.calls.length, 2);
  const next = await f.run(1);
  assert.equal(next.page, 2);
  assert.equal(await f.run(1), next);
  assert.equal(f.calls.length, 4);
  const fresh = '2'.repeat(32);
  await f.run(0, fresh);
  await assert.rejects(f.run(1));
  await assert.rejects(f.run(0));
  f.setRelays([relayB]);
  await assert.rejects(f.run(0, fresh));
  assert.equal(f.calls.length, 6);
  const restarted = await f.run(0, '3'.repeat(32));
  assert.equal(restarted.page, 1);
  assert.equal(f.calls.at(-1)?.relay, relayB);
});

test('same-second saturation is reported before crossing and a deferred lane stays on its cursor', async () => {
  const f = fixture({ties: true});
  const first = await f.run(0);
  assert.equal(first.events.length, 16);
  const boundary = await f.run(1);
  assert.equal(boundary.events.length, 32);
  assert.equal(boundary.gap, true);
  assert.equal(f.calls.filter(call => call.relay === relayA).at(-1)?.since, 100);
  const next = await f.run(2);
  assert.equal(next.gap, true);
  assert.equal(f.calls.filter(call => call.relay === relayB).at(-1)?.until, 93);
  assert.equal(f.calls.filter(call => call.relay === relayA).at(-1)?.until, 99);
});

test('an unavailable lane can be retried through the work bound without claiming complete coverage', async () => {
  const f = fixture({failure: 'throw', failures: 32});
  let page;
  for (let i = 0; i < 20; i++) page = await f.run(i);
  assert(page);
  assert.equal(page.more, false);
  assert.equal(page.partial, true);
  assert.equal(page.bounded, true);
  await assert.rejects(f.run(20));
});

test('the private operation requires exact native registration, Discover eligibility and Relay grant', async t => {
  const {database} = await setup(t);
  const native = new NativeLeases(), f = fixture();
  const registered: NativeRegistration = {sessionId: 'discover-1', generation: 'discover-generation', epoch: 1,
    user: hex(1), publisher: hex(2), appId: 'napplet-discovery', version: hex(3), instanceId: 'discover-1',
    fixture: 'napplet-discovery', domains: ['relay']};
  for (const [configured, owner, sender, input] of [
    [false, registered, registered, request(0)],
    [true, {...registered, domains: []}, {...registered, domains: []}, request(0)],
    [true, registered, {...registered, generation: 'foreign-generation'}, request(0)],
    [true, registered, registered, {...request(0), relay: 'wss://foreign.example.org'}],
    [true, registered, registered, {...request(0), filters: [{limit: 0}]}],
  ] as const) {
    const broker = createCapabilityBroker(database, native, {registration: owner, assertActive() {}},
      f.service, undefined, undefined, undefined, undefined, undefined, configured);
    const token = native.add(sender, input);
    await broker.dispatch(token);
    assert.equal(native.results.get(token), null);
  }
  assert.equal(f.calls.length, 0);

  const gate = deferred(), started = deferred();
  let active = true, sawAbort = false;
  const broker = createCapabilityBroker(database, native, {registration: registered, assertActive() {
    if (!active) throw Error('Owner revoked');
  }}, {query: f.service.query, catalog: {destinations: () => [relayA], async read(_relay, _filter, signal) {
    signal.addEventListener('abort', () => {sawAbort = true; gate.resolve();}, {once: true});
    started.resolve(); await gate.promise; return [{event: exclusive}];
  }}}, undefined, undefined, undefined, undefined, undefined, true);
  const token = native.add(registered, request(0));
  const result = broker.dispatch(token);
  await started.promise;
  active = false;
  await result;
  assert.equal(sawAbort, true);
  assert.equal(native.results.get(token), null);
});

test('a timed-out lane retains its cursor and cancels without discarding a matched healthy EOSE', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const hung = deferred(), started = deferred(), cancelled: string[] = [];
  const cursors: number[] = [];
  let hangingOperation: string | undefined;
  const service = createNativeRelayQuery({
    newInstanceId: randomUUID,
    cancelPublishedRelay(operation) {
      if (operation === hangingOperation) {
        cancelled.push(operation); hung.resolve();
      }
    },
    async queryPublishedRelay(operation, relay, raw, subscription) {
      const filter = JSON.parse(raw)[2];
      if (relay === relayA) {
        cursors.push(filter.until);
        if (cursors.length === 1) {hangingOperation = operation; started.resolve(); return hung.promise.then(() => []);}
      }
      const row = relay === relayA ? exclusive : healthy.find(value => value.created_at <= filter.until);
      return [...(row ? [JSON.stringify(['EVENT', subscription, row])] : []), JSON.stringify(['EOSE', subscription])];
    },
  }, () => [relayA, relayB], 25);
  const paging = createCatalogPaging(service.catalog!, () => 100), signal = new AbortController().signal;
  const first = paging(request(0), signal, () => {});
  await started.promise;
  await new Promise<void>(resolve => setImmediate(resolve));
  t.mock.timers.tick(25);
  assert.equal((await first).partial, true);
  assert.deepEqual(cancelled, [hangingOperation]);
  assert.equal((await paging(request(1), signal, () => {})).partial, false);
  assert.deepEqual(cursors, [100, 100]);
});
