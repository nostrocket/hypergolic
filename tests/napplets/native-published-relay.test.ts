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
