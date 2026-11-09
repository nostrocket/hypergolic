import assert from 'node:assert/strict';
import {test} from 'node:test';
import {finalizeEvent, getPublicKey} from 'nostr-tools/pure';
import {parseRelayQuery, QUERY_LIMITS} from '../../src/network/relay-query-contract.ts';
import {parseRelaySubscribe} from '../../src/network/relay-subscription-contract.ts';
import {parseOutboxQuery} from '../../src/outbox/query-contract.ts';
import {createOutboxReadService} from '../../src/outbox/read-service.ts';
import {parseOutboxSubscribe} from '../../src/outbox/subscription-contract.ts';
import type {NativePublishedRelayPort} from '../../src/napplets/native-published-relay.ts';

const key = new Uint8Array(32).fill(36);
const author = getPublicKey(key);
const relay = 'wss://relay.wavefunc.live';
const request = {type:'outbox.query', id:'station-search', filters:[{kinds:[31237],limit:48,search:'café jazz'}],
  options:{relays:[relay],timeoutMs:8000,limit:200}};
const signal = () => new AbortController().signal;
const station = (created_at: number, content = '', kind = 31237) =>
  finalizeEvent({kind,created_at,tags:[['d','jazz'],['name','Jazz Café']],content},key);
type Query = NativePublishedRelayPort['queryPublishedRelay'];

function harness(reply: Query, networkRelays = ['wss://nos.lol']) {
  const destinations: string[] = [], cancelled: string[] = [];
  let discovery = 0;
  const service = createOutboxReadService({async resolve() {discovery++; throw Error('unexpected discovery');}}, {
    newInstanceId: () => '00000000-0000-4000-8000-000000000001',
    queryOutboxRelay(token, id, url, wire, sub) {assert.equal(token,'search-token');destinations.push(url); return reply(id,url,wire,sub);},
    cancelPublishedRelay(id) {cancelled.push(id);},
  }, () => ({networkRelays,lookupRelays:['wss://relay.damus.io']}));
  return {query:(value:unknown = request, active = signal()) => service.query(value,author,active,()=>{},'search-token'),
    destinations,cancelled,discovery:()=>discovery};
}
const frames = (sub:string, events:readonly unknown[] = []) =>
  [...events.map(event => JSON.stringify(['EVENT',sub,event])), JSON.stringify(['EOSE',sub])];

test('Funclet-shaped Outbox search uses only its explicit peer and preserves rank across deduplication', async () => {
  const first = station(1), second = station(2);
  const h = harness(async (_id,_relay,wire,sub) => {
    assert.deepEqual(JSON.parse(wire),['REQ',sub,{kinds:[31237],limit:48,search:'café jazz'}]);
    return frames(sub,[first,first,second]);
  });
  const result = await h.query();
  assert.deepEqual(h.destinations,[relay]);
  assert.equal(h.discovery(),0);
  assert.deepEqual(result.events.map(({event}) => event.id),[first.id,second.id]);
  assert.deepEqual(result.events[0]?.sidecar?.relayHints,[relay]);
  assert.equal(result.incomplete,false);
  const limited = await h.query({...request,options:{...request.options,limit:1}});
  assert.deepEqual(limited.events.map(({event}) => event.id),[first.id]);
});

test('search preserves the 16-relay route union boundary before sending to the nominated relay', async () => {
  const network = Array.from({length:16},(_,i) => `wss://network${i}.nostr.net`);
  const outside = harness(async () => {throw Error('unexpected dispatch');},network);
  await assert.rejects(outside.query(),{message:'policy denied'});
  assert.deepEqual(outside.destinations,[]);
  assert.equal(outside.discovery(),0);

  const included = harness(async (_id,_relay,_wire,sub) => frames(sub),[relay,...network.slice(1)]);
  const result = await included.query();
  assert.equal(result.incomplete,false);
  assert.deepEqual(included.destinations,[relay]);
  assert.equal(included.discovery(),0);
});

test('search respects the per-filter limit and retains a ranked prefix under the existing byte budget', async () => {
  const ranked = Array.from({length:10},(_,i) => station(i+1,'x'.repeat(60_000)));
  const h = harness(async (_id,_relay,_wire,sub) => frames(sub,ranked));
  const limited = await h.query({...request,filters:[{...request.filters[0]!,limit:2}]});
  assert.deepEqual(limited.events.map(({event}) => event.id),ranked.slice(0,2).map(event => event.id));
  assert.equal(limited.incomplete,false);
  const result = await h.query();
  assert.deepEqual(result.events.map(({event}) => event.id),ranked.slice(0,8).map(event => event.id));
  assert.equal(result.incomplete,true);
  assert.ok(result.events.reduce((bytes,{event}) => bytes + Buffer.byteLength(JSON.stringify(event)),0) <= QUERY_LIMITS.resultBytes);
});

test('search input bounds and wire size are checked before dispatch, and structured-only operations reject search', async () => {
  const maximumTerm = '🦋'.repeat(256);
  assert.equal(parseOutboxQuery({...request,filters:[{search:maximumTerm}]}).filters[0]?.search,maximumTerm);
  for (const search of ['', ' \t\n', '🦋'.repeat(257), '\ud800', null, ['jazz'], 42]) {
    assert.throws(() => parseOutboxQuery({...request,filters:[{search}]}));
  }
  for (const relays of [[], [relay,relay], [relay,'wss://nos.lol'], ['wss://127.0.0.1']]) {
    assert.throws(() => parseOutboxQuery({...request,options:{...request.options,relays}}));
  }
  assert.throws(() => parseOutboxQuery({...request,filters:[...request.filters,{kinds:[1]}]}));
  const tooWide = {...request,filters:[{search:maximumTerm,'#a':Array(8).fill('a'.repeat(1024))}]};
  const h = harness(async () => {throw Error('unexpected dispatch');});
  await assert.rejects(h.query(tooWide),{message:'invalid filter'});
  assert.deepEqual(h.destinations,[]);
  assert.equal(h.discovery(),0);
  assert.throws(() => parseRelayQuery({type:'relay.query',id:request.id,filters:request.filters}));
  assert.throws(() => parseRelaySubscribe({type:'relay.subscribe',id:request.id,subId:'stations',filters:request.filters}));
  assert.throws(() => parseOutboxSubscribe({...request,type:'outbox.subscribe',subId:'stations'}));
});

test('search fails closed on altered signatures and mismatching structural filters', async () => {
  const first = station(1), second = station(2);
  for (const event of [{...first,sig:'0'.repeat(128)}, {...first,content:'different'}, station(3,'',1)]) {
    const h = harness(async (_id,_relay,_wire,sub) => frames(sub,[event,second]));
    await assert.rejects(h.query());
    assert.deepEqual(h.destinations,[relay]);
  }
  const wrongTag = harness(async (_id,_relay,_wire,sub) => frames(sub,[first]));
  await assert.rejects(wrongTag.query({...request,filters:[{...request.filters[0]!,'#d':['another-station']}]}));
});

test('search distinguishes matched empty EOSE from relay failure and revokes a pending reply without fallback', async () => {
  const empty = harness(async (_id,_relay,_wire,sub) => frames(sub));
  const result = await empty.query();
  assert.deepEqual(result.events,[]);
  assert.equal(result.incomplete,false);
  const closed = harness(async (_id,_relay,_wire,sub) => [JSON.stringify(['CLOSED',sub,'unsupported'])]);
  await assert.rejects(closed.query());
  assert.deepEqual(closed.destinations,[relay]);

  const controller = new AbortController();
  let release!: (frames:string[]) => void;
  let started!: (sub:string) => void;
  const dispatched = new Promise<string>(resolve => {started=resolve;});
  const pending = harness(async (_id,_relay,_wire,sub) =>
    new Promise(resolve => {release=resolve; started(sub);}));
  const query = pending.query(request,controller.signal);
  const sub = await dispatched;
  controller.abort();
  await assert.rejects(query);
  release(frames(sub,[station(1)]));
  assert.equal(pending.cancelled.length,1);
  assert.deepEqual(pending.destinations,[relay]);
});
