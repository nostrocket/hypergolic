import assert from 'node:assert/strict';
import {test} from 'node:test';
import {finalizeEvent, getPublicKey} from 'nostr-tools/pure';
import {parseRelayQuery, OUTBOX_QUERY_COUNTS} from '../../src/network/relay-query-contract.ts';
import {createOutboxReadService} from '../../src/outbox/read-service.ts';
import {createNativeRelayQuery} from '../../src/network/native-relay-query.ts';
import {parseOutboxQuery,parseOutboxEvent,parseOutboxResolve} from '../../src/outbox/query-contract.ts';
import {parseOutboxSubscribe} from '../../src/outbox/subscription-contract.ts';
import {parseOutboxRelayList} from '../../src/outbox/relay-list.ts';
import {createOutboxAuthorResolver, type OutboxAuthorResolver} from '../../src/outbox/author-resolver.ts';
const key = new Uint8Array(32).fill(36), author = getPublicKey(key);
const event = JSON.parse(JSON.stringify(finalizeEvent({kind: 1, created_at: 1, tags: [], content: 'disjoint'}, key)));
const list = parseOutboxRelayList(JSON.parse(JSON.stringify(finalizeEvent({kind: 10002, created_at: 1, content: '', tags: [['r','wss://read.nostr.net','read'],['r','wss://write.nostr.net','write']]}, key))), author);
const token = 'claimed-outbox-test-token';
const request = {type:'outbox.query', id:'query-1', filters:{authors:[author],kinds:[1]}};
function harness(resolver: OutboxAuthorResolver, network = ['wss://network.nostr.net']) {
  let sequence = 0;
  const calls: string[] = [], cancelled: string[] = [];
  const native = {newInstanceId: () => '00000000-0000-4000-8000-'+String(++sequence).padStart(12,'0'),
    async queryOutboxRelay(nativeToken: string, _id: string, relay: string, _wire: string, sub: string, _timeoutMs: number) {assert.equal(nativeToken,token);calls.push(relay); return [JSON.stringify(['EVENT',sub,event]),JSON.stringify(['EOSE',sub])];},
    cancelPublishedRelay(id: string) {cancelled.push(id);}};
  return {calls, cancelled, native, service:createOutboxReadService(resolver,native,()=>({networkRelays:network,lookupRelays:['wss://lookup.nostr.net']}))};
}
const signal = () => new AbortController().signal;
test('author query routes to signed write relay independently of configured Network and read role', async () => {
  const h = harness({async resolve(user, selectedAuthor) {assert.equal(user,author); assert.equal(selectedAuthor,author); return {list,source:'nip65',incomplete:false};}});
  const result = await h.service.query(request,author,signal(),()=>{},token);
  assert.deepEqual(h.calls,['wss://write.nostr.net']);
  assert.equal(result.events[0]?.event.id,event.id); assert.equal(result.incomplete,false);
});
test('failed author discovery uses configured Network with truthful incomplete and missing author', async () => {
  const h = harness({async resolve() {throw Error('offline');}});
  const result = await h.service.query(request,author,signal(),()=>{},token);
  assert.deepEqual(h.calls,['wss://network.nostr.net']);
  assert.equal(result.incomplete,true); assert.deepEqual(result.plan.missingAuthors,[author]);
});
test('authorless query uses Network plus bounded validated hints and deduplicates results', async () => {
  const h = harness({async resolve() {throw Error('must not discover');}});
  const result = await h.service.query({...request, filters:{kinds:[1]}, options:{relays:['wss://hint.nostr.net']}},author,signal(),()=>{},token);
  assert.deepEqual(h.calls,['wss://hint.nostr.net','wss://network.nostr.net']);
  assert.equal(result.events.length,1); assert.equal(result.plan.source,'fallback');
});
test('query options are immutable and reject guest authority, private relays and unsupported bounds', () => {
  const input = {...request,options:{authors:[author],relays:['wss://nos.lol'],limit:1,timeoutMs:1000}};
  const selected = parseOutboxQuery(input); input.options.relays[0]='wss://relay.damus.io';
  assert.deepEqual(selected.options.relays,['wss://nos.lol']); assert.ok(Object.isFrozen(selected.options));
  for (const options of [{user:author},{relays:['wss://127.0.0.1']},{limit:-1},{limit:1.5},{limit:Number.MAX_SAFE_INTEGER+1},{timeoutMs:0},{timeoutMs:15001}]) assert.throws(()=>parseOutboxQuery({...request,options}));
  let called = false;
  assert.throws(()=>parseOutboxQuery({...request,options:{get authors() {called=true; return [author];}}})); assert.equal(called,false);
});
test('larger Outbox requests stay bounded on the relay wire and flag saturated results', async () => {
  const h = harness({async resolve(){return {list,source:'nip65',incomplete:false};}});
  const large = {...request,filters:{...request.filters,limit:500},options:{limit:500}};
  const parsed = parseOutboxQuery(large);
  assert.equal(parsed.filters[0]?.limit,500);
  assert.equal(parsed.options.limit,500);
  const raw = parseRelayQuery({type:'relay.query',id:request.id,filters:[large.filters]});
  assert.equal(raw.filters[0]?.limit,32);
  assert.throws(()=>parseOutboxQuery({...large,filters:{...large.filters,limit:1.5}}));

  const fixtures = Array.from({length:OUTBOX_QUERY_COUNTS.events},(_,index) =>
    finalizeEvent({kind:1,created_at:index+1,tags:[],content:'bounded'},key));
  for (const size of [OUTBOX_QUERY_COUNTS.events, 1]) {
    h.native.queryOutboxRelay = async (_token,_id,_relay,wire,sub) => {
      assert.deepEqual(JSON.parse(wire),['REQ',sub,{...request.filters,limit:OUTBOX_QUERY_COUNTS.events}]);
      return [...fixtures.slice(0,size).map(row=>JSON.stringify(['EVENT',sub,row])),JSON.stringify(['EOSE',sub])];
    };
    const result = await h.service.query(parsed,author,signal(),()=>{},token);
    assert.equal(result.events.length,size);
    assert.equal(result.incomplete,size===OUTBOX_QUERY_COUNTS.events);
  }
});
test('routing overflow and revoked source produce zero data relay requests', async () => {
  const many = parseOutboxRelayList(JSON.parse(JSON.stringify(finalizeEvent({kind:10002,created_at:1,content:'',tags:Array.from({length:16},(_,i)=>['r',`wss://relay${i}.nostr.net`,'write'])},key))),author);
  const h = harness({async resolve(){return {list:many,source:'nip65',incomplete:false};}});
  await assert.rejects(h.service.query({...request,options:{relays:['wss://extra.nostr.net']}},author,signal(),()=>{},token)); assert.equal(h.calls.length,0);
  await assert.rejects(h.service.query(request,author,signal(),()=>{throw Error('revoked');},token)); assert.equal(h.calls.length,0);
});
test('total deadline cancels hanging discovery before data query', async () => {
  const h = harness({async resolve(){return new Promise(()=>{});}});
  await assert.rejects(h.service.query({...request,options:{timeoutMs:5}},author,signal(),()=>{},token)); assert.equal(h.calls.length,0);
});


for (const previousList of [false,true]) {
  test(`single-author query reserves time for data with ${previousList ? 'a verified partial route' : 'a cold missing route'}`, async () => {
    const metadata: string[] = [], cancelled: string[] = [];
    let sequence = 0, cacheWrites = 0;
    const discovery = createNativeRelayQuery({
      newInstanceId: () => '10000000-0000-4000-8000-'+String(++sequence).padStart(12,'0'),
      async queryPublishedRelay(_id, relay, wire, sub) {
        metadata.push(relay);
        assert.deepEqual(JSON.parse(wire),['REQ',sub,{authors:[author],kinds:[10002],limit:32}]);
        if (relay === 'wss://slow.nostr.net') return new Promise(() => {});
        const eose = JSON.stringify(['EOSE',sub]);
        return previousList ? [JSON.stringify(['EVENT',sub,list.event]),eose] : [eose];
      },
      cancelPublishedRelay(id) {cancelled.push(id);},
    }, () => ['wss://lookup.nostr.net','wss://slow.nostr.net']);
    const resolver = createOutboxAuthorResolver({
      async read() {return null;}, async write() {cacheWrites++;}, async close() {},
    },discovery);
    const h = harness(resolver);
    const result = await h.service.query({...request,options:{timeoutMs:240}},author,signal(),()=>{},token);
    assert.deepEqual(metadata,['wss://lookup.nostr.net','wss://slow.nostr.net']);
    assert.equal(cancelled.length,1);
    assert.equal(cacheWrites,0);
    assert.deepEqual(h.calls,[previousList ? 'wss://write.nostr.net' : 'wss://network.nostr.net']);
    assert.equal(result.events[0]?.event.id,event.id);
    assert.equal(result.incomplete,true);
    assert.deepEqual(result.plan.missingAuthors,previousList ? [] : [author]);
  });
}

test('the single-author reservation is exclusive to one-shot reads', async () => {
  const budgets: Array<[string, number | undefined]> = [];
  const h = harness({async resolve(_user,_author,purpose,_signal,_active,_refresh,timeoutMs) {
    budgets.push([purpose,timeoutMs]);
    return {list,source:'nip65',incomplete:false};
  }});
  await h.service.plan(request,author,signal(),()=>{});
  await h.service.resolveRelays({type:'outbox.resolveRelays',id:'write-plan',
    target:{pubkey:author,direction:'write'}},author,signal(),()=>{});
  await h.service.query({...request,options:{timeoutMs:200}},author,signal(),()=>{},token);
  assert.deepEqual(budgets.slice(0,2),[['read',undefined],['publication',undefined]]);
  assert.equal(budgets[2]?.[0],'read');
  assert.ok(budgets[2]?.[1] && budgets[2][1] <= 100);
});

test('one-shot data visits the next existing peer after a native deadline without overlapping promises', async () => {
  const h = harness({async resolve(){throw Error('unused');}},['wss://slow.nostr.net','wss://carrier.nostr.net']);
  const trace: string[] = [], attempts: number[] = [];
  let active = 0, peak = 0;
  h.native.queryOutboxRelay = async (_token,_id,relay,_wire,sub,timeoutMs) => {
    active++; peak = Math.max(peak,active);
    trace.push(`start:${relay}`); attempts.push(timeoutMs);
    assert.ok(Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 10_000);
    try {
      if (relay.includes('slow')) return await new Promise((_,reject) => setTimeout(()=>reject(Error('native deadline')),timeoutMs));
      return [JSON.stringify(['EVENT',sub,event]),JSON.stringify(['EOSE',sub])];
    } finally {active--;trace.push(`settled:${relay}`);}
  };
  const result = await h.service.query({...request,filters:{kinds:[1]},options:{timeoutMs:240}},author,signal(),()=>{},token);
  assert.deepEqual(result.events.map(row=>row.event.id),[event.id]);
  assert.equal(result.incomplete,true);
  assert.equal(peak,1);
  assert.equal(active,0);
  assert.deepEqual(trace,['start:wss://slow.nostr.net','settled:wss://slow.nostr.net',
    'start:wss://carrier.nostr.net','settled:wss://carrier.nostr.net']);
  assert.ok(attempts[0]! <= 120);
  assert.ok(attempts[1]! <= 240 - attempts[0]!);
});

test('a six-peer one-shot retains a useful first response instead of dividing time into sixths', async () => {
  const network = Array.from({length:6},(_,i) => `wss://peer${i}.nostr.net`);
  const h = harness({async resolve(){throw Error('unused');}},network);
  const deadlines:number[] = [];
  h.native.queryOutboxRelay = async (_token,_id,relay,_wire,sub,timeoutMs) => {
    h.calls.push(relay);deadlines.push(timeoutMs);
    if (relay === network[0]) return new Promise((resolve,reject) => {
      const nativeDeadline = setTimeout(()=>reject(Error('native deadline')),timeoutMs);
      setTimeout(()=>{
        clearTimeout(nativeDeadline);
        resolve([JSON.stringify(['EVENT',sub,event]),JSON.stringify(['EOSE',sub])]);
      },90);
    });
    return [JSON.stringify(['EOSE',sub])];
  };
  const result = await h.service.query({...request,filters:{kinds:[1]},options:{timeoutMs:240}},author,signal(),()=>{},token);
  assert.equal(result.events[0]?.event.id,event.id);
  assert.deepEqual(h.calls,network);
  assert.ok(deadlines[0]! >= 90 && deadlines[0]! <= 120);
});

test('a fast first Outbox peer remains useful and cancellation never starts a later peer', async () => {
  const h = harness({async resolve(){throw Error('unused');}},['wss://first.nostr.net','wss://later.nostr.net']);
  const deadlines:number[] = [];
  h.native.queryOutboxRelay = async (_token,_id,relay,_wire,sub,timeoutMs) => {
    h.calls.push(relay); deadlines.push(timeoutMs);
    return [JSON.stringify(['EVENT',sub,event]),JSON.stringify(['EOSE',sub])];
  };
  const result = await h.service.query({...request,filters:{kinds:[1]},options:{timeoutMs:240}},author,signal(),()=>{},token);
  assert.equal(result.events[0]?.event.id,event.id);
  assert.deepEqual(h.calls,['wss://first.nostr.net','wss://later.nostr.net']);
  assert.ok(deadlines[0]! <= 120 && deadlines[1]! <= 240);

  const controller = new AbortController();
  let started!: () => void, release!: (frames:string[]) => void;
  const entered = new Promise<void>(resolve=>{started=resolve;});
  h.calls.length = 0;
  h.native.queryOutboxRelay = async (_token,_id,relay,_wire,sub) => {
    h.calls.push(relay);started();
    return new Promise(resolve=>{release=()=>resolve([JSON.stringify(['EVENT',sub,event]),JSON.stringify(['EOSE',sub])]);});
  };
  const pending = h.service.query({...request,filters:{kinds:[1]}},author,controller.signal,()=>{},token);
  await entered;
  controller.abort();
  await assert.rejects(pending);
  release([]);
  await new Promise(resolve=>setTimeout(resolve,5));
  assert.deepEqual(h.calls,['wss://first.nostr.net']);
  assert.equal(h.cancelled.length,1);
});

test('single-author metadata cache waits are bounded without turning revocation into a fallback', async () => {
  let writes = 0;
  const resolver = createOutboxAuthorResolver({
    async read(){return new Promise(()=>{});},async write(){writes++;},async close() {},
  },{async query(){assert.fail('cache stall must not reach discovery');},
    async queryDetailed(){assert.fail('cache stall must not reach discovery');}});
  const h = harness(resolver);
  const result = await h.service.query({...request,options:{timeoutMs:240}},author,signal(),()=>{},token);
  assert.equal(result.events[0]?.event.id,event.id);
  assert.equal(result.incomplete,true);
  assert.equal(writes,0);
  h.calls.length=0;
  const controller = new AbortController();
  const pending = h.service.query({...request,options:{timeoutMs:240}},author,controller.signal,()=>{},token);
  controller.abort();
  await assert.rejects(pending);
  assert.deepEqual(h.calls,[]);
});

test('end-to-end Outbox deadline returns verified partial data instead of losing an earlier complete relay', async () => {
  const routes=parseOutboxRelayList(JSON.parse(JSON.stringify(finalizeEvent({kind:10002,created_at:1,content:'',tags:[['r','wss://write.nostr.net','write'],['r','wss://slow.nostr.net','write']]},key))),author);
  const h=harness({async resolve(){return {list:routes,source:'nip65',incomplete:false};}});
  h.native.queryOutboxRelay=async(_token,_id,relay,_wire,sub)=>{h.calls.push(relay);return relay.includes('slow') ? new Promise(()=>{}) : [JSON.stringify(['EVENT',sub,event]),JSON.stringify(['EOSE',sub])];};
  const result=await h.service.query({...request,options:{timeoutMs:20}},author,signal(),()=>{},token);
  assert.equal(result.events[0]?.event.id,event.id);assert.equal(result.incomplete,true);assert.equal(h.cancelled.length,1);
});

test('observed relay hints merge after deduplication and never include a failed destination', async () => {
  const h=harness({async resolve(){throw Error('unused');}});
  h.native.queryOutboxRelay=async (_token,_id,relay,_wire,sub)=>{h.calls.push(relay);if(relay.includes('failed'))throw Error('offline');return [JSON.stringify(['EVENT',sub,event]),JSON.stringify(['EOSE',sub])];};
  const result=await h.service.query({...request,filters:{ids:[event.id]},options:{relays:['wss://hint.nostr.net','wss://failed.nostr.net']}},author,signal(),()=>{},token);
  assert.equal(result.events.length,1);assert.deepEqual(result.events[0]?.sidecar?.relayHints,['wss://hint.nostr.net','wss://network.nostr.net']);assert.ok(Object.isFrozen(result.events[0]?.sidecar?.relayHints));
  assert.equal(result.incomplete,true);
});
test('authorless Network completion differs from a missing requested-author route', async () => {
  const h=harness({async resolve(){return {list:null,source:'cache',incomplete:false};}});
  assert.equal((await h.service.query({...request,filters:{kinds:[1]}},author,signal(),()=>{},token)).incomplete,false);
  const missing=await h.service.query(request,author,signal(),()=>{},token);
  assert.equal(missing.incomplete,true);assert.deepEqual(missing.plan.missingAuthors,[author]);
});
test('getEvent returns one exact signed id with observed hints, and distinguishes complete absence from partial absence', async () => {
  const h=harness({async resolve(){return {list,source:'cache',incomplete:false};}});
  const input={type:'outbox.getEvent',id:'event-1',eventId:event.id,options:{author}};
  const result=await h.service.getEvent(input,author,signal(),()=>{},token);
  assert.equal(result.result?.event.id,event.id);assert.equal(result.incomplete,undefined);assert.deepEqual(result.result?.sidecar?.relayHints,['wss://write.nostr.net']);
  h.native.queryOutboxRelay=async (_token,_id,relay,_wire,sub)=>{h.calls.push(relay);return [JSON.stringify(['EOSE',sub])];};
  assert.deepEqual(await h.service.getEvent(input,author,signal(),()=>{},token),{error:'not found'});
  assert.deepEqual(await h.service.getEvent({...input,options:{}},author,signal(),()=>{},token),{error:'not found'});
  h.native.queryOutboxRelay = async () => {throw Error('unavailable');};
  await assert.rejects(h.service.getEvent({...input,options:{}},author,signal(),()=>{},token));
  const partial = harness({async resolve(){assert.fail('no author metadata requested');}},
    ['wss://empty.nostr.net','wss://failed.nostr.net']);
  partial.native.queryOutboxRelay = async (_token,_id,relay,_wire,sub) => {
    if (relay === 'wss://failed.nostr.net') throw Error('controlled outage');
    return [JSON.stringify(['EOSE',sub])];
  };
  assert.deepEqual(await partial.service.getEvent({...input,options:{}},author,signal(),()=>{},token),
    {error:'not found',incomplete:true});
});
test('getEvent rejects a signed event for another id rather than delivering it', async () => {
  const h=harness({async resolve(){return {list,source:'cache',incomplete:false};}});
  await assert.rejects(h.service.getEvent({type:'outbox.getEvent',id:'wrong',eventId:'f'.repeat(64),options:{author}},author,signal(),()=>{},token));
});
test('resolveRelays defaults to author writes for reads and requires fresh recipient reads for writes without data transport', async () => {
  const purposes:string[]=[];
  const h=harness({async resolve(_user,_author,purpose){purposes.push(purpose);return {list,source:'nip65',incomplete:false};}});
  const input={type:'outbox.resolveRelays',id:'resolve-1',target:{pubkey:author}};
  assert.deepEqual((await h.service.resolveRelays(input,author,signal(),()=>{})).relays,['wss://write.nostr.net']);
  assert.deepEqual((await h.service.resolveRelays({...input,target:{authors:[author],direction:'write'}},author,signal(),()=>{})).relays,['wss://read.nostr.net']);
  assert.deepEqual(purposes,['read','publication']);assert.equal(h.calls.length,0);
  await assert.rejects(h.service.resolveRelays({...input,target:{}},author,signal(),()=>{}),/no authors/);
});
test('unresolved or incomplete write diagnostic fails and read diagnostic reports explicit fallback missing author', async () => {
  for(const value of [{list:null,source:'cache' as const,incomplete:false},{list,source:'nip65' as const,incomplete:true}]) {
    const h=harness({async resolve(){return value;}}),input={type:'outbox.resolveRelays',id:'resolve-2',target:{pubkey:author,direction:'write'}};
    await assert.rejects(h.service.resolveRelays(input,author,signal(),()=>{}),/relay list unavailable/);assert.equal(h.calls.length,0);
    const read=await h.service.resolveRelays({...input,target:{pubkey:author,direction:'read'}},author,signal(),()=>{});
    assert.equal(read.incomplete,true);
    if(!value.list){assert.deepEqual(read.missingAuthors,[author]);assert.equal(read.source,'fallback');}
  }
});
test('event and relay-plan parsers reject guest authority and malformed alternatives without invoking accessors', () => {
  const input={type:'outbox.getEvent',id:'event',eventId:event.id};
  for(const patch of [{eventId:'a'},{options:{authors:[author]}},{options:{relays:['wss://127.0.0.1']}},{user:author}])assert.throws(()=>parseOutboxEvent({...input,...patch}));
  const target={authors:[author],pubkey:author};
  assert.deepEqual(parseOutboxResolve({type:'outbox.resolveRelays',id:'plan',target}).target,{authors:[author],direction:'read'});
  for(const bad of [{direction:'both'},{owner:author},{authors:Array(1)}])assert.throws(()=>parseOutboxResolve({type:'outbox.resolveRelays',id:'plan',target:bad}));
  let invoked=false;assert.throws(()=>parseOutboxEvent({...input,options:{get author(){invoked=true;return author;}}}));assert.equal(invoked,false);
});

test('valid disjoint relay batches exceeding the global result bound retain newest verified partial events without changing legacy limits',async()=> {
  const routes=parseOutboxRelayList(JSON.parse(JSON.stringify(finalizeEvent({kind:10002,created_at:1,content:'',tags:[['r','wss://first.nostr.net','write'],['r','wss://second.nostr.net','write']]},key))),author);
  const h=harness({async resolve(){return {list:routes,source:'cache',incomplete:false};}});
  h.native.queryOutboxRelay=async(_token,_id,relay,_wire,sub)=>{h.calls.push(relay);const start=relay.includes('first')?1:111;return [...Array.from({length:110},(_,i)=>JSON.stringify(['EVENT',sub,JSON.parse(JSON.stringify(finalizeEvent({kind:1,created_at:start+i,tags:[],content:'bounded-'+(start+i)},key)))])),JSON.stringify(['EOSE',sub])];};
  const result=await h.service.query({...request,options:{limit:2}},author,signal(),()=>{},token);
  assert.deepEqual(result.events.map(row=>row.event.created_at),[220,219]);assert.equal(result.incomplete,true);assert.deepEqual(result.events[0]?.sidecar?.relayHints,['wss://second.nostr.net']);assert.equal(h.calls.length,2);
});

const profileKeys = Array.from({length:33}, (_, index) => new Uint8Array(32).fill(index + 1));
const profileAuthors = profileKeys.map(getPublicKey);
const profileFilters = profileAuthors.map(pubkey => ({authors:[pubkey], kinds:[0], limit:1}));

test('Follow Packs can query 22 independent profiles without losing less recent authors', async () => {
  const filters = profileFilters.slice(0,22);
  const old = profileKeys.slice(0,22).map((key,index) => finalizeEvent({kind:0,created_at:index+1,tags:[],content:'{}'},key));
  const winners = old.map((event,index) => index === 21 ? event :
    finalizeEvent({kind:0,created_at:index+100,tags:[],content:JSON.stringify({name:'profile '+index})},profileKeys[index]!));
  const routes = {...list,write:['wss://first.nostr.net','wss://second.nostr.net']};
  const h = harness({
    async resolve() {assert.fail('wide read must use one discovery batch');},
    async resolveReadBatch(_user, authors, _signal, _active, timeoutMs) {
      assert.deepEqual(authors,profileAuthors.slice(0,22)); assert.ok(timeoutMs <= 7500);
      return new Map(authors.map(author => [author,{list:routes,source:'nip65',incomplete:false}]));
    },
  });
  h.native.queryOutboxRelay = async (_token,_id,relay,wire,sub) => {
    h.calls.push(relay);
    assert.deepEqual(JSON.parse(wire),['REQ',sub,...filters]);
    return [...(relay.includes('first') ? old : winners).map(event => JSON.stringify(['EVENT',sub,event])),JSON.stringify(['EOSE',sub])];
  };
  const result = await h.service.query({...request,filters},author,signal(),()=>{},token);
  assert.deepEqual(result.events.map(row => row.event.id),[...winners].sort((a,b)=>b.created_at-a.created_at).map(event => event.id));
  assert.deepEqual(result.events.find(row => row.event.id === winners[21]!.id)?.sidecar?.relayHints,routes.write);
  assert.deepEqual(h.calls,routes.write); assert.equal(result.incomplete,false);
});

test('wide one-shot count and native REQ byte bounds reject before resolving routes; live and raw stay at four', async () => {
  const h = harness({async resolve() {assert.fail('oversized request must not resolve authors');}});
  assert.equal(parseOutboxQuery({...request,filters:profileFilters.slice(0,32)}).filters.length,32);
  for (const filters of [profileFilters, profileFilters.slice(0,9).map(filter => ({...filter,'#t':['é'.repeat(500)]}))]) {
    await assert.rejects(h.service.query({...request,filters},author,signal(),()=>{},token),/invalid filter/);
  }
  const filters = profileFilters.slice(0,5);
  assert.throws(()=>parseRelayQuery({type:'relay.query',id:request.id,filters}));
  assert.throws(()=>parseOutboxSubscribe({type:'outbox.subscribe',id:request.id,subId:'live',filters}));
  assert.equal(h.calls.length,0);
});

test('wide route overflow retains configured fallback and whole author routes under the 16-peer cap', async () => {
  const network = ['wss://approved.nostr.net'], hint = 'wss://validated-hint.nostr.net';
  const h = harness({
    async resolve() {assert.fail('wide read must use batched discovery');},
    async resolveReadBatch(_user,authors) {
      return new Map(authors.map((author,index) => [author,{
        list:{...list,write:[`wss://author-${index}.nostr.net`]}, source:'nip65', incomplete:false,
      }]));
    },
  },network);
  h.native.queryOutboxRelay = async (_token,_id,relay,_wire,sub) => {
    h.calls.push(relay); return [JSON.stringify(['EOSE',sub])];
  };
  const result = await h.service.query({...request,filters:profileFilters.slice(0,22),options:{relays:[hint]}},author,signal(),()=>{},token);
  assert.deepEqual(h.calls,[hint,...network,...Array.from({length:14},(_,index)=>`wss://author-${index}.nostr.net`)]);
  assert.deepEqual(result.plan.missingAuthors,profileAuthors.slice(14,22));
  assert.equal(result.plan.source,'fallback'); assert.equal(result.incomplete,true);
});

test('wide discovery spends the original deadline and revocation prevents data dispatch', async () => {
  let entered!: () => void;
  const enteredDiscovery = new Promise<void>(resolve => {entered=resolve;});
  const h = harness({
    async resolve() {assert.fail('wide read must use batched discovery');},
    async resolveReadBatch(_user,_authors,signal) {
      entered();
      return new Promise((_,reject) => signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));
    },
  });
  const controller = new AbortController();
  const pending = h.service.query({...request,filters:profileFilters.slice(0,22)},author,controller.signal,()=>{},token);
  await enteredDiscovery; controller.abort();
  await assert.rejects(pending,/relay timeout/);
  await assert.rejects(h.service.query({...request,filters:profileFilters.slice(0,22),options:{timeoutMs:15}},author,signal(),()=>{},token),/relay timeout/);
  assert.deepEqual(h.calls,[]);
});


test('wide authorless reads use configured Network fallback without discovery', async () => {
  const h = harness({
    async resolve() {assert.fail('authorless read must not resolve authors');},
    async resolveReadBatch() {assert.fail('authorless read must not open a discovery batch');},
  });
  const filters = profileFilters.slice(0,22).map(() => ({kinds:[1],limit:1}));
  const result = await h.service.query({...request,filters},author,signal(),()=>{},token);
  assert.equal(result.events[0]?.event.id,event.id);
  assert.deepEqual(result.plan,{relays:['wss://network.nostr.net'],source:'fallback',missingAuthors:[],incomplete:false});
  assert.deepEqual(h.calls,['wss://network.nostr.net']);
});

test('wide planning timeout includes stalled cache reads and leaves time for data fallback', async () => {
  let cacheStarted = false, cacheAborted = false;
  const unused = async () => assert.fail('stalled cache must not start Lookup or write');
  const resolver = createOutboxAuthorResolver({
    async read(_user,_author,_active,signal) {
      cacheStarted = true;
      return new Promise((_,reject) => signal.addEventListener('abort',()=>{
        cacheAborted = true; reject(Error('planning expired'));
      },{once:true}));
    },
    write:unused, close:unused,
  },{query:unused, queryDetailed:unused});
  const h = harness(resolver);
  const profile = finalizeEvent({kind:0,created_at:10,tags:[],content:'{"name":"available"}'},profileKeys[0]!);
  h.native.queryOutboxRelay = async (_token,_id,relay,_wire,sub) => {
    h.calls.push(relay); return [JSON.stringify(['EVENT',sub,profile]),JSON.stringify(['EOSE',sub])];
  };
  const result = await h.service.query({...request,filters:profileFilters.slice(0,22),options:{timeoutMs:100}},author,signal(),()=>{},token);
  assert.equal(cacheStarted,true); assert.equal(cacheAborted,true);
  assert.equal(result.events[0]?.event.id,profile.id); assert.equal(result.incomplete,true);
  assert.deepEqual(h.calls,['wss://network.nostr.net']);
});

test('the default Outbox read retains a signed root after 68 newer matching child events', async () => {
  const address = `30381:${author}:toy-rocket`;
  const children = Array.from({length:68},(_,index) => finalizeEvent({
    kind:1111,created_at:70-index,content:'child',tags:[['A',address],['t','child']],
  },key));
  const root = finalizeEvent({kind:1111,created_at:1,content:'root',tags:[['A',address],['t','root']]},key);
  const h = harness({async resolve(){throw Error('unexpected author discovery');}});
  h.native.queryOutboxRelay = async (captured,_id,relay,wire,sub) => {
    assert.equal(captured,token);
    assert.equal(relay,'wss://network.nostr.net');
    assert.deepEqual(JSON.parse(wire),['REQ',sub,{kinds:[1111],'#A':[address],limit:200}]);
    return [...children,root].map(event=>JSON.stringify(['EVENT',sub,event])).concat(JSON.stringify(['EOSE',sub]));
  };
  const input = {type:'outbox.query',id:'toy-like',filters:{kinds:[1111],'#A':[address]}};
  const result = await h.service.query(input,author,signal(),()=>{},token);
  assert.equal(result.events.length,69);
  assert.equal(result.events[68]?.event.id,root.id);
  assert.equal(result.plan.source,'fallback');
  assert.equal(result.incomplete,false);
  const stream = parseOutboxSubscribe({...input,type:'outbox.subscribe',subId:'test'});
  assert.equal(stream.filters[0]?.limit,32);
  assert.equal(stream.options.limit,32);
});

test('long advisory relay hints cannot crowd out signed Outbox events', async () => {
  const relay = list.write[0]!;
  const peers = Array.from({length:15},(_,index) => `wss://peer${index}.nostr.net/${'a'.repeat(1900)}`);
  const h = harness({async resolve(){return {list,source:'cache',incomplete:false};}});
  const events = Array.from({length:40},(_,index) => finalizeEvent({
    kind:1,created_at:40-index,content:'bounded hints',tags:[],
  },key));
  h.native.queryOutboxRelay = async (_token,_id,_relay,_wire,sub) =>
    [...events.map(event=>JSON.stringify(['EVENT',sub,event])),JSON.stringify(['EOSE',sub])];
  const result = await h.service.query({...request,options:{relays:peers}},author,signal(),()=>{},token);
  assert.deepEqual(result.events.map(row=>row.event.id),events.map(event=>event.id));
  assert.deepEqual(result.events[0]?.sidecar?.relayHints,[...peers,relay]);
  assert.ok(result.events.some(row=>row.sidecar === undefined));
  assert.ok(Buffer.byteLength(JSON.stringify(result.events)) < 512 * 1024);
  assert.equal(result.incomplete,false);
});

test('the one-shot deadline can expire between signed frames without opening another relay', async t => {
  const first = 'wss://first.nostr.net', second = 'wss://second.nostr.net', third = 'wss://third.nostr.net';
  const routes = {...list,write:[first,second,third]};
  const h = harness({async resolve(){return {list:routes,source:'cache',incomplete:false};}});
  const later = finalizeEvent({kind:1,created_at:2,tags:[],content:'late'},key);
  let clock = 0;
  t.mock.method(performance,'now',()=>clock);
  h.native.queryOutboxRelay = async (_token,_id,relay,_wire,sub) => {
    h.calls.push(relay);
    const frame = JSON.stringify(['EVENT',sub,relay === first ? event : later]);
    const frames = [frame,JSON.stringify(['EOSE',sub])];
    if (relay === second) {
      Object.defineProperty(frames,1,{get(){clock = 1_000; return JSON.stringify(['EOSE',sub]);}});
    }
    return frames;
  };
  const result = await h.service.query({...request,options:{timeoutMs:1000}},author,signal(),()=>{},token);
  assert.deepEqual(h.calls,[first,second]);
  assert.deepEqual(result.events.map(row=>row.event.id),[event.id]);
  assert.equal(result.incomplete,true);
  assert.equal(h.cancelled.length,1);
});


for (const mode of ['complete','empty','failed-peer','missing-eose'] as const) {
  test(`authorless manifest query reports selected Network completion for ${mode}`, async () => {
    const peers = ['wss://first.nostr.net','wss://second.nostr.net'];
    const manifest = finalizeEvent({kind:35129,created_at:10,content:'Test game',tags:[
      ['d','test-game'],['title','Test game'],['z','game'],['x','a'.repeat(64)],
    ]},key);
    const h = harness({async resolve(){assert.fail('no author was requested');}},peers);
    h.native.queryOutboxRelay = async (captured,_id,relay,wire,sub) => {
      assert.equal(captured,token); h.calls.push(relay);
      assert.deepEqual(JSON.parse(wire),['REQ',sub,{kinds:[5129,15129,35129],limit:80}]);
      if (mode === 'failed-peer' && relay === peers[1]) throw Error('controlled outage');
      const frames = mode === 'empty' ? [] : [JSON.stringify(['EVENT',sub,manifest])];
      return mode === 'missing-eose' && relay === peers[1] ? frames : [...frames,JSON.stringify(['EOSE',sub])];
    };
    const result = await h.service.query({type:'outbox.query',id:'manifest-directory',
      filters:[{kinds:[5129,15129,35129],limit:80}],options:{limit:80,timeoutMs:8000}},
      author,signal(),()=>{},token);
    assert.deepEqual(h.calls,peers);
    assert.equal(result.incomplete,mode === 'failed-peer' || mode === 'missing-eose');
    assert.deepEqual(result.plan,{relays:peers,source:'fallback',missingAuthors:[],incomplete:false});
    assert.deepEqual(result.events.map(row=>row.event.id),mode === 'empty' ? [] : [manifest.id]);
  });
}
