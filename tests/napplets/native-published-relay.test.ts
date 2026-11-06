import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativePublishedRelayLookup, NativePublishedRelayError, type NativePublishedRelayPort } from '../../src/napplets/native-published-relay.ts';
import { MAX_RELAY_FRAME_BYTES } from '../../src/napplets/published-source.ts';

const coordinate = Object.freeze({ kind: 35129 as const, pubkey: 'ab'.repeat(32), identifier: 'example-app' });
const relayA = 'wss://relay-a.example.org';
const relayB = 'wss://relay-b.example.org/path';
const ids = [
  '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000004',
  '00000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000006',
];
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const event = (id: string, content = 'unverified') => ({ id, pubkey: 'not-checked-here', kind: -1, content });
const eventFrame = (subscriptionId: string, payload: unknown) => JSON.stringify(['EVENT', subscriptionId, payload]);
const eose = (subscriptionId: string) => JSON.stringify(['EOSE', subscriptionId]);

function harness(run: (url: string, requestText: string, subscriptionId: string, index: number) => Promise<string[]> | string[],
  patch: Partial<NativePublishedRelayPort> = {}) {
  let index = 0, idIndex = 0; const calls: { id: string; url: string; requestText: string; subscriptionId: string }[] = [];
  const cancelled: string[] = [];
  const port: NativePublishedRelayPort = {
    newInstanceId() { return ids[idIndex++] ?? `00000000-0000-4000-8000-${String(idIndex).padStart(12, '0')}`; },
    queryPublishedRelay(id, url, requestText, subscriptionId) {
      const current = index++; calls.push({ id, url, requestText, subscriptionId });
      return Promise.resolve(run(url, requestText, subscriptionId, current));
    },
    cancelPublishedRelay(id) { cancelled.push(id); },
    revokeAllPublishedRelay() {},
    ...patch,
  };
  return { port, calls, cancelled };
}

test('queries every normalized selected relay with the exact lookup REQ and collects unverified events through EOSE', async () => {
  const fixture = harness((url, _request, sub) => [
    ...(url === relayA ? [eventFrame(sub, event('a'.repeat(64)))] : []), eose(sub),
  ]);
  const lookup = createNativePublishedRelayLookup(fixture.port);
  const result = await lookup.query(coordinate, [relayA, 'wss://relay-b.example.org:443/path/'], null, new AbortController().signal);
  assert.equal(fixture.calls.length, 2);
  assert.deepEqual(fixture.calls.map(call => call.url), [relayA, 'wss://relay-b.example.org/path/']);
  for (const call of fixture.calls) {
    assert.match(call.id, /^[0-9a-f-]{36}$/);
    const req = JSON.parse(call.requestText);
    assert.equal(req[0], 'REQ'); assert.equal(req[1], call.subscriptionId);
    assert.deepEqual(req[2], { kinds: [35129], authors: [coordinate.pubkey], '#d': [coordinate.identifier], limit: 32 });
  }
  assert.deepEqual(result, [event('a'.repeat(64))]);
  assert.equal(Object.isFrozen(result), true);
});

test('uses at most four concurrent native operations while eventually trying 7 relays', async () => {
  let nextId = 0, inFlight = 0, maximum = 0, calls = 0;
  const port: NativePublishedRelayPort = {
    newInstanceId() { return `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`; },
    queryPublishedRelay(_id, _url, _request, sub) {
      calls++; inFlight++; maximum = Math.max(maximum, inFlight);
      return new Promise(resolve => setTimeout(() => { inFlight--; resolve([eose(sub)]); }, 2));
    },
    cancelPublishedRelay() {},
    revokeAllPublishedRelay() {},
  };
  const relays = Array.from({ length: 7 }, (_, index) => `wss://relay-${index}.example.org`);
  await createNativePublishedRelayLookup(port).query(coordinate, relays, null, new AbortController().signal);
  assert.equal(maximum, 4);
  assert.equal(calls, 7);
});

test('pins reopened lookups to the supplied event ID', async () => {
  const fixture = harness((_url, _request, sub) => [eose(sub)]);
  const eventId = 'cd'.repeat(32);
  await createNativePublishedRelayLookup(fixture.port).query(coordinate, [relayA], eventId, new AbortController().signal);
  assert.deepEqual(JSON.parse(fixture.calls[0]!.requestText)[2].ids, [eventId]);
});

test('rejects invalid, duplicate or excessive selected relays before native calls', async () => {
  const fixture = harness((_url, _request, sub) => [eose(sub)]);
  const lookup = createNativePublishedRelayLookup(fixture.port);
  for (const relays of [[], [relayA, 'wss://relay-a.example.org/'], ['wss://127.0.0.1'], Array.from({ length: 17 }, (_, i) => `wss://r${i}.example.org`)]) {
    await assert.rejects(lookup.query(coordinate, relays, null, new AbortController().signal), NativePublishedRelayError);
  }
  assert.equal(fixture.calls.length, 0);
});

test('cancels every outstanding operation on abort and ignores late completions', async () => {
  const waits = [deferred<string[]>(), deferred<string[]>()];
  const fixture = harness((_url, _request, _sub, index) => waits[index]!.promise);
  const controller = new AbortController();
  const pending = createNativePublishedRelayLookup(fixture.port).query(coordinate, [relayA, relayB], null, controller.signal);
  await Promise.resolve();
  assert.equal(fixture.calls.length, 2);
  controller.abort();
  await assert.rejects(pending, NativePublishedRelayError);
  assert.deepEqual(fixture.cancelled.sort(), fixture.calls.map(call => call.id).sort());
  for (let index = 0; index < waits.length; index++) waits[index]!.resolve([eose(fixture.calls[index]!.subscriptionId)]);
  await new Promise(resolve => setTimeout(resolve, 0));
});

test('a relay failure does not cancel a sibling that can still return a valid EOSE', async () => {
  const slow = deferred<string[]>();
  const fixture = harness((_url, _request, _sub, index) => index === 0 ? Promise.reject(new Error('native failure')) : slow.promise);
  const pending = createNativePublishedRelayLookup(fixture.port).query(coordinate, [relayA, relayB], null, new AbortController().signal);
  slow.resolve([eose(fixture.calls[1]!.subscriptionId)]);
  assert.deepEqual(await pending, []);
  assert.deepEqual(fixture.cancelled, []);
});

test('Discover retries only failed peers after an empty partial response', async () => {
  const hit = event('a'.repeat(64));
  const fixture = harness((url, _request, sub, index) => {
    if (url === relayB) return [eose(sub)];
    if (index === 0) return Promise.reject(new Error('first connection failed'));
    return [eventFrame(sub, hit), eose(sub)];
  });
  const result = await createNativePublishedRelayLookup(fixture.port).query(coordinate, [relayA, relayB],
    null, new AbortController().signal, true);
  assert.deepEqual(result, [hit]);
  assert.deepEqual(fixture.calls.map(call => call.url), [relayA, relayB, relayA]);
  assert.equal(new Set(fixture.calls.map(call => call.id)).size, 3);
});

test('Discover retries a capacity-rejected carrier while a different initial peer is still pending', async () => {
  const relayC = 'wss://relay-c.example.org';
  const hit = event('a'.repeat(64)), slow = deferred<string[]>();
  const fixture = harness((url, _wire, sub, index) => {
    if (url === relayC) return slow.promise;
    if (url === relayB) return [eose(sub)];
    return index === 0 ? Promise.reject(Error('Native lookup capacity exhausted')) : [eventFrame(sub, hit), eose(sub)];
  });
  const result = await createNativePublishedRelayLookup(fixture.port, 15).query(
    coordinate, [relayA, relayB, relayC], null, new AbortController().signal, true);
  assert.deepEqual(result, [hit]);
  assert.deepEqual(fixture.calls.map(call => call.url), [relayA, relayB, relayC, relayA]);
  assert.deepEqual(fixture.cancelled, [fixture.calls[2]!.id]);
});

test('Discover attempts all configured relays before retries and keeps at most four operations in flight', async () => {
  const relays = Array.from({length: 8}, (_, index) => `wss://relay-${index}.example.org`);
  let active = 0, peak = 0;
  const fixture = harness((_url, _wire, sub, index) => {
    peak = Math.max(peak, ++active);
    return new Promise((resolve, reject) => setImmediate(() => {
      active--;
      if (index < relays.length) reject(Error('initial attempt failed'));
      else resolve([eose(sub)]);
    }));
  });
  const result = await createNativePublishedRelayLookup(fixture.port).query(
    coordinate, relays, null, new AbortController().signal, true);
  assert.deepEqual(result, []);
  assert.deepEqual(fixture.calls.slice(0, relays.length).map(call => call.url), relays);
  assert.deepEqual(fixture.calls.slice(relays.length).map(call => call.url).sort(), [...relays].sort());
  assert.equal(peak, 4);
});

test('a late complete candidate stops queued retries and keeps candidates from retries already in flight', async () => {
  const relays = Array.from({length: 8}, (_, index) => `wss://relay-${index}.example.org`);
  const initial = relays.map(() => deferred<string[]>());
  const started = deferred<void>(), retried = deferred<void>(), retry = deferred<string[]>();
  const firstHit = event('a'.repeat(64)), retryHit = event('b'.repeat(64));
  const fixture = harness((_url, _wire, _sub, index) => {
    if (index < 4) return Promise.reject(Error('initial attempt failed'));
    if (index < relays.length) {
      if (index === relays.length - 1) started.resolve();
      return initial[index]!.promise;
    }
    retried.resolve();
    return retry.promise;
  });
  const operation = createNativePublishedRelayLookup(fixture.port, 100).query(
    coordinate, relays, null, new AbortController().signal, true);
  await Promise.race([started.promise, operation]);
  initial[4]!.resolve([eose(fixture.calls[4]!.subscriptionId)]);
  await Promise.race([retried.promise, operation]);
  assert.equal(fixture.calls.length, 9);
  const late = fixture.calls[5]!.subscriptionId;
  initial[5]!.resolve([eventFrame(late, firstHit), eose(late)]);
  const retrySub = fixture.calls[8]!.subscriptionId;
  retry.resolve([eventFrame(retrySub, retryHit), eose(retrySub)]);
  for (const index of [6, 7]) initial[index]!.resolve([eose(fixture.calls[index]!.subscriptionId)]);
  assert.deepEqual(await operation, [firstHit, retryHit]);
  assert.equal(fixture.calls.length, 9);
  assert.deepEqual(fixture.cancelled, []);
});

test('abort cancels an active retry and slow initial read without dispatching the queued retries', async () => {
  const relayC = 'wss://relay-c.example.org', relayD = 'wss://relay-d.example.org';
  const controller = new AbortController();
  const retry = deferred<string[]>(), slow = deferred<string[]>();
  const fixture = harness((url, _wire, sub, index) => {
    if (url === relayC) return slow.promise;
    if (url === relayB) return [eose(sub)];
    if (index < 4) return Promise.reject(Error('initial failure'));
    controller.abort();
    return retry.promise;
  });
  await assert.rejects(createNativePublishedRelayLookup(fixture.port, 100).query(
    coordinate, [relayA, relayB, relayC, relayD], null, controller.signal, true), NativePublishedRelayError);
  assert.equal(fixture.calls.length, 5);
  assert.deepEqual(fixture.cancelled, [fixture.calls[2]!.id, fixture.calls[4]!.id]);
  for (const [wait, index] of [[retry, 4], [slow, 2]] as const) wait.resolve([eose(fixture.calls[index]!.subscriptionId)]);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(fixture.calls.length, 5);
});

test('synchronous cancellation during allocation or native dispatch stops the Discover pump', async () => {
  for (const point of ['allocation', 'dispatch']) {
    const controller = new AbortController();
    const wait = deferred<string[]>();
    const fixture = harness(() => {
      if (point === 'dispatch') controller.abort();
      return wait.promise;
    }, {
      newInstanceId() {
        if (point === 'allocation') controller.abort();
        return ids[0]!;
      },
    });
    await assert.rejects(createNativePublishedRelayLookup(fixture.port).query(
      coordinate, [relayA, relayB], null, controller.signal, true), NativePublishedRelayError);
    const dispatched = point === 'dispatch' ? 1 : 0;
    assert.equal(fixture.calls.length, dispatched);
    assert.deepEqual(fixture.cancelled, dispatched ? [fixture.calls[0]!.id] : []);
  }
});

test('Discover reports a persistently incomplete empty response as a failure', async () => {
  const fixture = harness((url, _request, sub) => url === relayA
    ? Promise.reject(new Error('unreachable'))
    : [eose(sub)]);
  await assert.rejects(createNativePublishedRelayLookup(fixture.port).query(coordinate, [relayA, relayB],
    null, new AbortController().signal, true), NativePublishedRelayError);
  assert.deepEqual(fixture.calls.map(call => call.url), [relayA, relayB, relayA]);
});

test('Discover keeps a matched EOSE reply at the deadline and cancels only the outstanding peer', async () => {
  const hit = event('a'.repeat(64)), late = deferred<string[]>();
  const fixture = harness((url, _wire, sub) => url === relayA ? [eventFrame(sub, hit), eose(sub)] : late.promise);
  const lookup = createNativePublishedRelayLookup(fixture.port, 5);
  const result = await lookup.query(coordinate, [relayA, relayB], null, new AbortController().signal, true);
  const pending = fixture.calls[1]!;
  assert.deepEqual(fixture.cancelled, [pending.id]);
  late.resolve([eventFrame(pending.subscriptionId, event('b'.repeat(64))), eose(pending.subscriptionId)]);
  await Promise.resolve();
  assert.deepEqual(result, [hit]);
  assert.equal(fixture.calls.length, 2);
});

test('the shared deadline rejects incomplete, empty, unattempted and ordinary lookup cases', async () => {
  const relays = Array.from({length: 6}, (_, index) => `wss://relay-${index}.example.org`);
  for (const {destinations, discovery, response} of [
    {destinations: [relayA, relayB], discovery: true as const, response: 'incomplete'},
    {destinations: [relayA, relayB], discovery: true as const, response: 'empty'},
    {destinations: relays, discovery: true as const, response: 'complete'},
    {destinations: [relayA, relayB], discovery: undefined, response: 'complete'},
  ]) {
    const wait = deferred<string[]>();
    const fixture = harness((url, _wire, sub) => {
      if (url !== destinations[0]) return wait.promise;
      if (response === 'empty') return [eose(sub)];
      const frame = eventFrame(sub, event('a'.repeat(64)));
      return response === 'complete' ? [frame, eose(sub)] : [frame];
    });
    await assert.rejects(createNativePublishedRelayLookup(fixture.port, 5).query(
      coordinate, destinations, null, new AbortController().signal, discovery), NativePublishedRelayError);
    if (destinations === relays) assert.equal(fixture.calls.length, 5);
    assert.deepEqual(fixture.cancelled, fixture.calls.slice(1).map(call => call.id));
  }
});

test('a relay whose operation ID was rejected does not count as an attempted peer', async () => {
  const wait = deferred<string[]>();
  let index = 0;
  const fixture = harness((url, _wire, sub) => url === relayA
    ? [eventFrame(sub, event('a'.repeat(64))), eose(sub)] : wait.promise, {
    newInstanceId() { return [ids[0]!, 'invalid', ids[1]!][index++]!; },
  });
  const relayC = 'wss://relay-c.example.org';
  await assert.rejects(createNativePublishedRelayLookup(fixture.port, 5).query(
    coordinate, [relayA, relayB, relayC], null, new AbortController().signal, true), NativePublishedRelayError);
  assert.deepEqual(fixture.calls.map(call => call.url), [relayA, relayC]);
  assert.deepEqual(fixture.cancelled, [fixture.calls[1]!.id]);
});

test('Discover abort after a completed reply cannot return its candidates', async () => {
  const controller = new AbortController();
  const wait = deferred<string[]>();
  const fixture = harness((url, _wire, sub) => url === relayA
    ? [eventFrame(sub, event('a'.repeat(64))), eose(sub)] : wait.promise);
  const operation = createNativePublishedRelayLookup(fixture.port, 50).query(coordinate, [relayA, relayB], null, controller.signal, true);
  await Promise.resolve();
  controller.abort();
  await assert.rejects(operation, NativePublishedRelayError);
  assert.deepEqual(fixture.cancelled, [fixture.calls[1]!.id]);
});

test('Discover uses the existing fan-out for the bounded union of both roles', async () => {
  const fixture = harness((_url, _request, sub) => [eose(sub)]);
  const lookup = createNativePublishedRelayLookup(fixture.port);
  const combined = Array.from({ length: 32 }, (_, index) => `wss://r${index}.example.org`);
  const signal = new AbortController().signal;
  assert.deepEqual(await lookup.query(coordinate, combined, null, signal, true), []);
  assert.equal(fixture.calls.length, 32);
  await assert.rejects(lookup.query(coordinate, [...combined, 'wss://extra.example.org'], null, signal, true),
    NativePublishedRelayError);
  await assert.rejects(lookup.query(coordinate, [relayA], 'c'.repeat(64), signal, true), NativePublishedRelayError);
  assert.equal(fixture.calls.length, 32);
});

test('requires matching subscription envelopes and EOSE, and rejects CLOSED or malformed frames', async () => {
  for (const reply of [
    (sub: string) => [JSON.stringify(['EOSE', 'wrong-id'])],
    (sub: string) => [JSON.stringify(['CLOSED', sub, 'denied'])],
    (_sub: string) => ['not-json'],
    (sub: string) => [eventFrame(sub, event('a'.repeat(64)))],
  ]) {
    const fixture = harness((_url, _request, sub) => reply(sub));
    await assert.rejects(createNativePublishedRelayLookup(fixture.port).query(coordinate, [relayA], null, new AbortController().signal), NativePublishedRelayError);
  }
});

test('ignores bounded NOTICE before EOSE and keeps successful events from other relays when one fails', async () => {
  const fixture = harness((url, _request, sub) => {
    if (url === relayA) return Promise.reject(new Error('one relay unavailable'));
    return [JSON.stringify(['NOTICE', 'temporarily busy']), eventFrame(sub, event('e'.repeat(64))), eose(sub)];
  });
  const result = await createNativePublishedRelayLookup(fixture.port).query(coordinate, [relayA, relayB], null, new AbortController().signal);
  assert.deepEqual(result, [event('e'.repeat(64))]);
});

test('rejects when every selected relay fails', async () => {
  const fixture = harness(() => Promise.reject(new Error('unavailable')));
  await assert.rejects(createNativePublishedRelayLookup(fixture.port).query(coordinate, [relayA, relayB], null,
    new AbortController().signal), NativePublishedRelayError);
});

test('keeps operation IDs unique for the entire lookup even after completion', async () => {
  let calls = 0;
  const port: NativePublishedRelayPort = {
    newInstanceId: () => ids[0]!,
    async queryPublishedRelay(_id, _url, _request, sub) { calls++; return [eose(sub)]; },
    cancelPublishedRelay() {},
    revokeAllPublishedRelay() {},
  };
  const events = await createNativePublishedRelayLookup(port).query(coordinate, [relayA, relayB], null, new AbortController().signal);
  assert.deepEqual(events, []);
  assert.equal(calls, 1);
});

test('enforces the shared 32 event and 2 MiB candidate budgets across relays', async () => {
  const tooMany = harness((_url, _request, sub, index) => [
    ...Array.from({ length: index === 0 ? 17 : 16 }, (_, n) => eventFrame(sub, event(`${index}${String(n).padStart(63, '0')}`))), eose(sub),
  ]);
  await assert.rejects(createNativePublishedRelayLookup(tooMany.port).query(coordinate, [relayA, relayB], null, new AbortController().signal), NativePublishedRelayError);

  const tooLarge = harness((_url, _request, sub, index) => [
    ...Array.from({ length: 16 }, (_, n) => eventFrame(sub, event(`${index}${String(n).padStart(63, '0')}`, 'x'.repeat(65_600)))), eose(sub),
  ]);
  await assert.rejects(createNativePublishedRelayLookup(tooLarge.port).query(coordinate, [relayA, relayB], null, new AbortController().signal), NativePublishedRelayError);
});

test('matches native 64 text-message and 2 MiB raw-envelope limits before parsing', async () => {
  const tooManyMessages = harness((_url, _request, sub) => [
    ...Array.from({ length: 64 }, () => JSON.stringify(['NOTICE', 'busy'])), eose(sub),
  ]);
  await assert.rejects(createNativePublishedRelayLookup(tooManyMessages.port).query(coordinate, [relayA], null,
    new AbortController().signal), NativePublishedRelayError);

  const tooManyRawBytes = harness((_url, _request, sub) => {
    const frames = [
      ...Array.from({ length: 32 }, (_, index) => eventFrame(sub, event(`${String(index).padStart(64, '0')}`, 'x'.repeat(65_400)))), eose(sub),
    ];
    assert.ok(frames.every(frame => new TextEncoder().encode(frame).byteLength <= MAX_RELAY_FRAME_BYTES));
    assert.ok(frames.reduce((sum, frame) => sum + new TextEncoder().encode(frame).byteLength, 0) > 2 * 1024 * 1024);
    return frames;
  });
  await assert.rejects(createNativePublishedRelayLookup(tooManyRawBytes.port).query(coordinate, [relayA], null,
    new AbortController().signal), NativePublishedRelayError);
});

test('one shared deadline cancels all native operations and rejects late completion', async () => {
  const waits = [deferred<string[]>(), deferred<string[]>()];
  const fixture = harness((_url, _request, _sub, index) => waits[index]!.promise);
  const pending = createNativePublishedRelayLookup(fixture.port, 5).query(coordinate, [relayA, relayB], null, new AbortController().signal);
  await assert.rejects(pending, NativePublishedRelayError);
  assert.deepEqual(fixture.cancelled.sort(), fixture.calls.map(call => call.id).sort());
  for (let index = 0; index < waits.length; index++) waits[index]!.resolve([eose(fixture.calls[index]!.subscriptionId)]);
  await new Promise(resolve => setTimeout(resolve, 0));
});


test('optional AUTH announcement does not prevent published manifest lookup', async () => {
  const h = harness((_url, _request, sub) => [JSON.stringify(['AUTH', 'challenge']), eventFrame(sub, event('e'.repeat(64))), eose(sub)]);
  const result = await createNativePublishedRelayLookup(h.port).query(coordinate, [relayA], null, new AbortController().signal);
  assert.equal(result.length, 1);
});
