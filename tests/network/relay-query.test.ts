import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent } from 'nostr-tools/pure';
import { createNativeRelayQuery } from '../../src/network/native-relay-query.ts';
import { parseQueryFilters, parseRelayQuery, verifyQueryEvent, selectQueryEvents, QUERY_LIMITS } from '../../src/network/relay-query-contract.ts';

const secret = new Uint8Array(32); secret[31] = 1;
const signed = (content = 'hello', created_at = 100, tags: string[][] = []) => finalizeEvent({ kind: 1, content, created_at, tags }, secret);
const clean = (event: ReturnType<typeof signed>) => JSON.parse(JSON.stringify(event)) as ReturnType<typeof signed>;
function harness(relays = ['wss://one.example.com'], handler?: (url: string, sub: string) => Promise<string[]>) {
  let next = 0;
  const calls: { url: string; wire: string; sub: string; id: string }[] = [], cancelled: string[] = [];
  const port = { newInstanceId: () => '00000000-0000-4000-8000-' + String(++next).padStart(12, '0'),
    cancelPublishedRelay: (id: string) => { cancelled.push(id); },
    queryPublishedRelay: async (id: string, url: string, wire: string, sub: string) => {
      calls.push({ id, url, wire, sub });
      return handler ? handler(url, sub) : [JSON.stringify(['EVENT', sub, signed()]), JSON.stringify(['EOSE', sub])];
    } };
  return { port, calls, cancelled, create: (timeout = 1000) => createNativeRelayQuery(port, () => relays, timeout) };
}
const signal = () => new AbortController().signal;
test('selected core filters are cloned, bounded and match owning request fields', () => {
  const request = parseRelayQuery({ type: 'relay.query', id: 'correlation', filters: [{ kinds: [1] }] });
  assert.deepEqual(request.filters, [{ kinds: [1], limit: 32 }]);
  assert.ok(Object.isFrozen(request.filters[0]!.kinds));
  for (const filters of [[], [{ search: 'extra' }], [{ authors: ['abc'] }], [{ kinds: [] }], [{ limit: -1 }], [{ limit: 1.5 }], [{ limit: '32' }], [{ limit: Number.MAX_SAFE_INTEGER + 1 }], [{ since: 10, until: 1 }], [{ '#e': ['abc'] }], [{ kinds: [65536] }]]) {
    assert.throws(() => parseQueryFilters(filters));
  }
  assert.throws(() => parseRelayQuery({ type: 'relay.query', id: 'x', filters: [{}], relay: 'wss://forged.example.com' }));
});
test('requests for more initial history use the same bounded native query and result profile', async () => {
  const h = harness();
  const request = parseRelayQuery({ type: 'relay.query', id: 'wide', filters: [{ kinds: [1], limit: 160 }] });
  await h.create().query(request.filters, signal(), () => {});
  assert.deepEqual(JSON.parse(h.calls[0]!.wire), ['REQ', h.calls[0]!.sub, { kinds: [1], limit: 32 }]);
  assert.deepEqual(parseQueryFilters([{ limit: 0 }, { limit: 2 }, { limit: Number.MAX_SAFE_INTEGER }]),
    [{ limit: 0 }, { limit: 2 }, { limit: 32 }]);
});
test('filter descriptors, sparse arrays and cached verification cannot bypass validation', () => {
  const filters = parseQueryFilters([{ kinds: [1] }]);
  assert.throws(() => parseQueryFilters([{ get kinds() { throw new Error('must not execute'); } }]));
  assert.throws(() => parseQueryFilters(new Array(1)));
  const cached = signed(); cached.content = 'mutated';
  assert.throws(() => verifyQueryEvent(cached, filters));
  assert.throws(() => verifyQueryEvent({ ...clean(signed()), sig: '0'.repeat(128) }, filters));
  assert.throws(() => verifyQueryEvent(clean(signed()), parseQueryFilters([{ kinds: [0] }])));
});
test('incoming event JSON is bounded exactly across cumulative text, escapes, and Unicode', () => {
  const filters = parseQueryFilters([{ kinds: [1] }]);
  const escapes = '\u0000\b\t\n\v\f\r"\\é雪🚀\u2028\u2029';
  const tags = [['proofmode', 'p'.repeat(11_000)], ['alt', escapes.repeat(200)], [], ['marker', '', 'next']];
  const initial = escapes.repeat(300) + '\ud800' + 'lone' + '\udfff';
  const padding = QUERY_LIMITS.eventBytes - Buffer.byteLength(JSON.stringify(signed(initial, 100, tags)));
  assert.ok(padding > 0);
  const content = initial + 'x'.repeat(padding);
  const exact = clean(signed(content, 100, tags));
  const over = clean(signed(content + 'x', 100, tags));
  const escapedOver = clean(signed(content + '\u0000', 100, tags));
  assert.equal(Buffer.byteLength(JSON.stringify(exact)), 65_536);
  assert.equal(Buffer.byteLength(JSON.stringify(over)), 65_537);
  assert.equal(Buffer.byteLength(JSON.stringify(escapedOver)), 65_542);
  assert.deepEqual(verifyQueryEvent(exact, filters), exact);
  assert.throws(() => verifyQueryEvent(over, filters));
  assert.throws(() => verifyQueryEvent(escapedOver, filters));

  const escapeAmplified = clean(signed('', 100, [['alt', '\u0000'.repeat(11_000)]]));
  assert.ok(Buffer.byteLength(JSON.stringify(escapeAmplified)) > QUERY_LIMITS.eventBytes);
  assert.throws(() => verifyQueryEvent(escapeAmplified, filters));
  assert.throws(() => verifyQueryEvent(clean(signed('x'.repeat(40_000), 100, [['alt', 'y'.repeat(30_000)]])), filters));
  const maximumFilter = { '#t': ['x'.repeat(1024)] };
  assert.deepEqual(parseQueryFilters([maximumFilter]), [{...maximumFilter,limit:32}]);
  assert.throws(() => parseQueryFilters([{ '#t': ['x'.repeat(1025)] }]));
});

test('large incoming tags retain shape, surrogate, hash, and signature checks', () => {
  const filters = parseQueryFilters([{ kinds: [1] }]);
  const large = clean(signed('', 100, [['proofmode', 'p'.repeat(11_000)]]));
  const malformed = ['alt'];
  let getterCalled = false;
  Object.defineProperty(malformed, 1, { enumerable:true, get() { getterCalled=true; return 'side effect'; } });
  for (const candidate of [
    {...large, tags:[malformed]},
    {...large, tags:[['alt', 42]]},
    {...large, tags:[new Array(2)]},
    clean(signed('', 100, [['alt', '\ud800']])),
    {...large, tags: new Array(QUERY_LIMITS.eventBytes)},
    clean(signed('', 100, [Array(65).fill('t')])),
    {...large, tags:[['proofmode','q'.repeat(11_000)]]},
    {...large, sig:'0'.repeat(128)},
  ]) assert.throws(() => verifyQueryEvent(candidate, filters));
  assert.equal(getterCalled,false);
});

test('incoming contact lists use the existing byte budget rather than the former 256-row cap', () => {
  const tags = Array.from({length:880}, (_, index) => ['p', index.toString(16).padStart(64, '0')]);
  const contact = clean(finalizeEvent({kind:3,created_at:100,content:'',tags},secret));
  const filters = parseQueryFilters([{kinds:[3], '#p':[tags[0]![1]!]}]);
  assert.ok(Buffer.byteLength(JSON.stringify(contact)) < QUERY_LIMITS.eventBytes);
  assert.deepEqual(verifyQueryEvent(contact, filters), contact);
  assert.ok(Object.isFrozen(verifyQueryEvent(contact, filters).tags[879]));
  assert.throws(() => verifyQueryEvent({...contact, sig:'0'.repeat(128)}, filters));
  assert.throws(() => verifyQueryEvent({...contact, tags:[...tags, ['p','f'.repeat(64)]]}, filters));
  const over = clean(finalizeEvent({kind:3,created_at:100,content:'',
    tags:Array.from({length:900}, (_, index) => ['p', index.toString(16).padStart(64, '0')])},secret));
  assert.ok(Buffer.byteLength(JSON.stringify(over)) > QUERY_LIMITS.eventBytes);
  assert.throws(() => verifyQueryEvent(over, filters));
});

test('byte-derived row bound handles many short tags and rejects excess rows before reading them', () => {
  const tags = Array.from({length:10_000}, () => ['t']);
  const valid = clean(signed('',100,tags));
  const filters = parseQueryFilters([{kinds:[1]}]);
  assert.deepEqual(verifyQueryEvent(valid,filters), valid);
  const excess = new Array(Math.floor(QUERY_LIMITS.eventBytes / 3) + 1);
  let read = false;
  Object.defineProperty(excess,0,{get(){read=true;throw new Error('row getter executed');}});
  assert.throws(() => verifyQueryEvent({...valid,tags:excess},filters));
  assert.equal(read,false);
});

test('exact ids, tag first values, inclusive timestamps, OR and newest-first per-filter limits', () => {
  const a = clean(signed('old', 100, [['t', 'one', 'ignored']])), b = clean(signed('new', 101, [['t', 'two']]));
  assert.equal(verifyQueryEvent(a, parseQueryFilters([{ ids: [a.id], since: 100, until: 100, '#t': ['one'] }])).id, a.id);
  assert.throws(() => verifyQueryEvent(a, parseQueryFilters([{ '#t': ['ignored'] }])));
  assert.deepEqual(selectQueryEvents([a, b], parseQueryFilters([{ kinds: [1], limit: 1 }])).map(x => x.event.id), [b.id]);
  assert.deepEqual(selectQueryEvents([a, b], parseQueryFilters([{ kinds: [1], limit: 0 }])), []);
  const tie = clean(signed('tie', 101));
  assert.deepEqual(selectQueryEvents([b, tie], parseQueryFilters([{}])).map(x => x.event.id), [b.id, tie.id].sort());
});
test('native query sends host-selected filters and returns exact verified event wrappers', async () => {
  const h = harness(), service = h.create();
  const result = await service.query(parseQueryFilters([{ kinds: [1], limit: 2 }]), signal(), () => {});
  assert.equal(result[0]!.event.id, signed().id);
  assert.deepEqual(Object.keys(result[0]!), ['event']);
  assert.equal(Reflect.ownKeys(result[0]!.event).length, 7);
  assert.deepEqual(JSON.parse(h.calls[0]!.wire), ['REQ', h.calls[0]!.sub, { kinds: [1], limit: 2 }]);
});
test('native query preserves long proof and alt fields alongside later signed events', async () => {
  const proof = clean(signed('proof', 102, [['proofmode','p'.repeat(10_959)]]));
  const description = clean(signed('description', 101, [['alt','é'.repeat(1539)]]));
  const later = clean(signed('later', 100));
  const h = harness(undefined, async (_,sub) => [
    ...[proof,description,later].map(event => JSON.stringify(['EVENT',sub,event])),
    JSON.stringify(['EOSE',sub]),
  ]);
  const result = await h.create().query(parseQueryFilters([{kinds:[1]}]),signal(),()=>{});
  assert.deepEqual(result.map(row => row.event),[proof,description,later]);
});

test('empty EOSE succeeds; failed, missing EOSE, forged, wrong-sub and post-EOSE frames fail', async () => {
  const empty = harness(undefined, async (_, sub) => [JSON.stringify(['EOSE', sub])]);
  assert.deepEqual(await empty.create().query(parseQueryFilters([{}]), signal(), () => {}), []);
  for (const build of [
    (sub: string) => [],
    (sub: string) => [JSON.stringify(['EVENT', sub, signed()])],
    (sub: string) => [JSON.stringify(['EVENT', sub, { ...clean(signed()), sig: '0'.repeat(128) }]), JSON.stringify(['EOSE', sub])],
    (sub: string) => [JSON.stringify(['EOSE', 'foreign'])],
    (sub: string) => [JSON.stringify(['EOSE', sub]), JSON.stringify(['EVENT', sub, signed()])],
    (sub: string) => [JSON.stringify(['CLOSED', sub, 'auth-required'])],
  ]) {
    const h = harness(undefined, async (_, sub) => build(sub));
    await assert.rejects(h.create().query(parseQueryFilters([{}]), signal(), () => {}));
  }
});
test('partial relay failure succeeds only with another complete response; duplicates merge', async () => {
  const h = harness(['wss://bad.example.com', 'wss://one.example.com', 'wss://two.example.com'], async (url, sub) => {
    if (url.includes('bad')) throw new Error('offline');
    return [JSON.stringify(['EVENT', sub, signed()]), JSON.stringify(['EOSE', sub])];
  });
  assert.equal((await h.create().query(parseQueryFilters([{}]), signal(), () => {})).length, 1);
  const bad = harness(undefined, async () => { throw new Error('offline'); });
  await assert.rejects(bad.create().query(parseQueryFilters([{}]), signal(), () => {}));
});
test('private destinations, absent relays, aborted signal and stale owner dispatch no network', async () => {
  for (const destinations of [[], ['ws://one.example.com'], ['wss://127.0.0.1'], ['wss://one.example.com', 'wss://one.example.com']]) {
    const h = harness(destinations);
    await assert.rejects(h.create().query(parseQueryFilters([{}]), signal(), () => {})); assert.equal(h.calls.length, 0);
  }
  const h = harness(), abort = new AbortController(); abort.abort();
  await assert.rejects(h.create().query(parseQueryFilters([{}]), abort.signal, () => {}));
  await assert.rejects(h.create().query(parseQueryFilters([{}]), signal(), () => { throw new Error('revoked'); }));
  assert.equal(h.calls.length, 0);
});
test('abort and total deadline cancel exact native work without waiting for a reply', async () => {
  for (const mode of ['abort', 'deadline']) {
    const h = harness(undefined, async () => new Promise(() => {})), controller = new AbortController();
    const promise = h.create(30).query(parseQueryFilters([{}]), controller.signal, () => {});
    if (mode === 'abort') controller.abort();
    await assert.rejects(promise); assert.deepEqual(h.cancelled, [h.calls[0]!.id]);
  }
});
test('global query concurrency is bounded and released after cancellation', async () => {
  const h = harness(undefined, async () => new Promise(() => {})), service = h.create(), controllers = [new AbortController(), new AbortController()];
  const pending = controllers.map(c => service.query(parseQueryFilters([{}]), c.signal, () => {}));
  await assert.rejects(service.query(parseQueryFilters([{}]), signal(), () => {})); assert.equal(h.calls.length, QUERY_LIMITS.concurrent);
  controllers.forEach(c => c.abort()); await Promise.all(pending.map(p => assert.rejects(p)));
  const next = new AbortController(), work = service.query(parseQueryFilters([{}]), next.signal, () => {}); next.abort(); await assert.rejects(work);
  assert.equal(h.calls.length, 3);
});
test('response event count and aggregate byte limits fail instead of truncating', async () => {
  const events = Array.from({ length: 33 }, (_, i) => signed('event-' + i));
  const h = harness(undefined, async (_, sub) => [...events.map(e => JSON.stringify(['EVENT', sub, e])), JSON.stringify(['EOSE', sub])]);
  await assert.rejects(h.create().query(parseQueryFilters([{}]), signal(), () => {}));
  const many = harness(undefined, async (_, sub) => [...Array.from({ length: 12 }, (_, i) => signed(String(i) + 'x'.repeat(48_000))).map(e => JSON.stringify(['EVENT', sub, e])), JSON.stringify(['EOSE', sub])]);
  await assert.rejects(many.create().query(parseQueryFilters([{}]), signal(), () => {}));
});

test('detailed query preserves partial failure without changing legacy event wrapper', async () => {
  const h = harness(['wss://bad.example.com', 'wss://one.example.com'], async (url, sub) => {
    if (url.includes('bad')) throw Error('offline');
    return [JSON.stringify(['EVENT', sub, signed()]), JSON.stringify(['EOSE', sub])];
  });
  const result = await h.create().queryDetailed(parseQueryFilters([{}]), signal(), () => {});
  assert.equal(result.incomplete, true);
  assert.equal(result.events.length, 1);
  assert.deepEqual(Object.keys(result.events[0]!), ['event']);
});
test('detailed complete empty EOSE is distinct from partial or failed discovery', async () => {
  const h = harness(undefined, async (_, sub) => [JSON.stringify(['EOSE', sub])]);
  assert.deepEqual(await h.create().queryDetailed(parseQueryFilters([{}]), signal(), () => {}), {events: [], incomplete: false});
});


test('detailed total deadline preserves verified partial data and cancels exact pending relay; legacy still rejects', async () => {
  for (const detailed of [false,true]) {
    const h = harness(['wss://one.example.com','wss://slow.example.com'],async (url,sub) => url.includes('slow') ? new Promise(()=>{}) : [JSON.stringify(['EVENT',sub,signed()]),JSON.stringify(['EOSE',sub])]);
    const service=h.create(20), filters=parseQueryFilters([{}]);
    if(detailed){const result=await service.queryDetailed(filters,signal(),()=>{});assert.equal(result.incomplete,true);assert.equal(result.events[0]?.event.id,signed().id);}
    else await assert.rejects(service.query(filters,signal(),()=>{}));
    assert.deepEqual(h.cancelled,[h.calls[1]!.id]);
  }
});
test('external cancellation or native owner revocation cannot return deadline partial data', async () => {
  for(const revoke of [false,true]) {
    const controller=new AbortController();let active=true;
    const h=harness(['wss://one.example.com','wss://slow.example.com'],async(url,sub)=>{
      if(url.includes('slow')){if(revoke)active=false;else controller.abort();return new Promise(()=>{});}
      return [JSON.stringify(['EVENT',sub,signed()]),JSON.stringify(['EOSE',sub])];});
    await assert.rejects(h.create(20).queryDetailed(parseQueryFilters([{}]),controller.signal,()=>{if(!active)throw Error('revoked');}));
  }
});


test('optional AUTH and rotated challenges preserve verified public reads without another outbound request', async () => {
  const h = harness(undefined, async (_, sub) => [
    JSON.stringify(['AUTH', 'challenge-one']), JSON.stringify(['AUTH', 'challenge-two']),
    JSON.stringify(['EVENT', sub, signed()]), JSON.stringify(['EOSE', sub]),
  ]);
  assert.equal((await h.create().query(parseQueryFilters([{}]), signal(), () => {}))[0]!.event.id, signed().id);
  assert.equal(h.calls.length, 1);
  assert.equal(JSON.parse(h.calls[0]!.wire)[0], 'REQ');
  for (const frames of [
    (sub: string) => [JSON.stringify(['AUTH', 'challenge'])],
    (sub: string) => [JSON.stringify(['AUTH', 'challenge']), JSON.stringify(['CLOSED', sub, 'auth-required: denied'])],
    (sub: string) => [...Array.from({length: QUERY_LIMITS.frames}, () => JSON.stringify(['AUTH', 'challenge'])), JSON.stringify(['EOSE', sub])],
  ]) {
    const denied = harness(undefined, async (_, sub) => frames(sub));
    await assert.rejects(denied.create().query(parseQueryFilters([{}]), signal(), () => {}));
    assert.equal(denied.calls.length, 1);
  }
});
