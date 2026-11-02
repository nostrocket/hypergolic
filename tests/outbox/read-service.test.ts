import assert from 'node:assert/strict';
import {test} from 'node:test';
import {finalizeEvent, getPublicKey} from 'nostr-tools/pure';
import {createOutboxReadService} from '../../src/outbox/read-service.ts';
import {parseOutboxQuery,parseOutboxEvent,parseOutboxResolve} from '../../src/outbox/query-contract.ts';
import {parseOutboxRelayList} from '../../src/outbox/relay-list.ts';
import type {OutboxAuthorResolver} from '../../src/outbox/author-resolver.ts';
const key = new Uint8Array(32).fill(36), author = getPublicKey(key);
const event = JSON.parse(JSON.stringify(finalizeEvent({kind: 1, created_at: 1, tags: [], content: 'disjoint'}, key)));
const list = parseOutboxRelayList(JSON.parse(JSON.stringify(finalizeEvent({kind: 10002, created_at: 1, content: '', tags: [['r','wss://read.nostr.net','read'],['r','wss://write.nostr.net','write']]}, key))), author);
const request = {type:'outbox.query', id:'query-1', filters:{authors:[author],kinds:[1]}};
function harness(resolver: OutboxAuthorResolver, network = ['wss://network.nostr.net']) {
  let sequence = 0;
  const calls: string[] = [], cancelled: string[] = [];
  const native = {newInstanceId: () => '00000000-0000-4000-8000-'+String(++sequence).padStart(12,'0'),
    async queryPublishedRelay(_id: string, relay: string, _wire: string, sub: string) {calls.push(relay); return [JSON.stringify(['EVENT',sub,event]),JSON.stringify(['EOSE',sub])];},
    cancelPublishedRelay(id: string) {cancelled.push(id);}};
  return {calls, cancelled, native, service:createOutboxReadService(resolver,native,()=>({networkRelays:network,lookupRelays:['wss://lookup.nostr.net']}))};
}
const signal = () => new AbortController().signal;
test('author query routes to signed write relay independently of configured Network and read role', async () => {
  const h = harness({async resolve(user, selectedAuthor) {assert.equal(user,author); assert.equal(selectedAuthor,author); return {list,source:'nip65',incomplete:false};}});
  const result = await h.service.query(request,author,signal(),()=>{});
  assert.deepEqual(h.calls,['wss://write.nostr.net']);
  assert.equal(result.events[0]?.event.id,event.id); assert.equal(result.incomplete,false);
});
test('failed author discovery uses configured Network with truthful incomplete and missing author', async () => {
  const h = harness({async resolve() {throw Error('offline');}});
  const result = await h.service.query(request,author,signal(),()=>{});
  assert.deepEqual(h.calls,['wss://network.nostr.net']);
  assert.equal(result.incomplete,true); assert.deepEqual(result.plan.missingAuthors,[author]);
});
test('authorless query uses Network plus bounded validated hints and deduplicates results', async () => {
  const h = harness({async resolve() {throw Error('must not discover');}});
  const result = await h.service.query({...request, filters:{kinds:[1]}, options:{relays:['wss://hint.nostr.net']}},author,signal(),()=>{});
  assert.deepEqual(h.calls,['wss://hint.nostr.net','wss://network.nostr.net']);
  assert.equal(result.events.length,1); assert.equal(result.plan.source,'fallback');
});
test('query options are immutable and reject guest authority, private relays and unsupported bounds', () => {
  const input = {...request,options:{authors:[author],relays:['wss://nos.lol'],limit:1,timeoutMs:1000}};
  const selected = parseOutboxQuery(input); input.options.relays[0]='wss://relay.damus.io';
  assert.deepEqual(selected.options.relays,['wss://nos.lol']); assert.ok(Object.isFrozen(selected.options));
  for (const options of [{user:author},{relays:['wss://127.0.0.1']},{limit:33},{timeoutMs:0},{timeoutMs:15001}]) assert.throws(()=>parseOutboxQuery({...request,options}));
  let called = false;
  assert.throws(()=>parseOutboxQuery({...request,options:{get authors() {called=true; return [author];}}})); assert.equal(called,false);
});
test('routing overflow and revoked source produce zero data relay requests', async () => {
  const many = parseOutboxRelayList(JSON.parse(JSON.stringify(finalizeEvent({kind:10002,created_at:1,content:'',tags:Array.from({length:16},(_,i)=>['r',`wss://relay${i}.nostr.net`,'write'])},key))),author);
  const h = harness({async resolve(){return {list:many,source:'nip65',incomplete:false};}});
  await assert.rejects(h.service.query({...request,options:{relays:['wss://extra.nostr.net']}},author,signal(),()=>{})); assert.equal(h.calls.length,0);
  await assert.rejects(h.service.query(request,author,signal(),()=>{throw Error('revoked');})); assert.equal(h.calls.length,0);
});
test('total deadline cancels hanging discovery before data query', async () => {
  const h = harness({async resolve(){return new Promise(()=>{});}});
  await assert.rejects(h.service.query({...request,options:{timeoutMs:5}},author,signal(),()=>{})); assert.equal(h.calls.length,0);
});


test('end-to-end Outbox deadline returns verified partial data instead of losing an earlier complete relay', async () => {
  const routes=parseOutboxRelayList(JSON.parse(JSON.stringify(finalizeEvent({kind:10002,created_at:1,content:'',tags:[['r','wss://write.nostr.net','write'],['r','wss://slow.nostr.net','write']]},key))),author);
  const h=harness({async resolve(){return {list:routes,source:'nip65',incomplete:false};}});
  h.native.queryPublishedRelay=async(_id,relay,_wire,sub)=>{h.calls.push(relay);return relay.includes('slow') ? new Promise(()=>{}) : [JSON.stringify(['EVENT',sub,event]),JSON.stringify(['EOSE',sub])];};
  const result=await h.service.query({...request,options:{timeoutMs:20}},author,signal(),()=>{});
  assert.equal(result.events[0]?.event.id,event.id);assert.equal(result.incomplete,true);assert.equal(h.cancelled.length,1);
});

test('observed relay hints merge after deduplication and never include a failed destination', async () => {
  const h=harness({async resolve(){throw Error('unused');}});
  h.native.queryPublishedRelay=async (_id,relay,_wire,sub)=>{h.calls.push(relay);if(relay.includes('failed'))throw Error('offline');return [JSON.stringify(['EVENT',sub,event]),JSON.stringify(['EOSE',sub])];};
  const result=await h.service.query({...request,filters:{ids:[event.id]},options:{relays:['wss://hint.nostr.net','wss://failed.nostr.net']}},author,signal(),()=>{});
  assert.equal(result.events.length,1);assert.deepEqual(result.events[0]?.sidecar?.relayHints,['wss://hint.nostr.net','wss://network.nostr.net']);assert.ok(Object.isFrozen(result.events[0]?.sidecar?.relayHints));
  assert.equal(result.incomplete,true);
});
test('authorless and successfully missing relay lists report fallback discovery as incomplete', async () => {
  const h=harness({async resolve(){return {list:null,source:'cache',incomplete:false};}});
  assert.equal((await h.service.query({...request,filters:{kinds:[1]}},author,signal(),()=>{})).incomplete,true);
  const missing=await h.service.query(request,author,signal(),()=>{});
  assert.equal(missing.incomplete,true);assert.deepEqual(missing.plan.missingAuthors,[author]);
});
test('getEvent returns one exact signed id with observed hints, and distinguishes complete absence from partial absence', async () => {
  const h=harness({async resolve(){return {list,source:'cache',incomplete:false};}});
  const input={type:'outbox.getEvent',id:'event-1',eventId:event.id,options:{author}};
  const result=await h.service.getEvent(input,author,signal(),()=>{});
  assert.equal(result.result?.event.id,event.id);assert.equal(result.incomplete,undefined);assert.deepEqual(result.result?.sidecar?.relayHints,['wss://write.nostr.net']);
  h.native.queryPublishedRelay=async (_id,relay,_wire,sub)=>{h.calls.push(relay);return [JSON.stringify(['EOSE',sub])];};
  assert.deepEqual(await h.service.getEvent(input,author,signal(),()=>{}),{error:'not found'});
  assert.deepEqual(await h.service.getEvent({...input,options:{}},author,signal(),()=>{}),{error:'not found',incomplete:true});
});
test('getEvent rejects a signed event for another id rather than delivering it', async () => {
  const h=harness({async resolve(){return {list,source:'cache',incomplete:false};}});
  await assert.rejects(h.service.getEvent({type:'outbox.getEvent',id:'wrong',eventId:'f'.repeat(64),options:{author}},author,signal(),()=>{}));
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
  h.native.queryPublishedRelay=async(_id,relay,_wire,sub)=>{h.calls.push(relay);const start=relay.includes('first')?1:33;return [...Array.from({length:32},(_,i)=>JSON.stringify(['EVENT',sub,JSON.parse(JSON.stringify(finalizeEvent({kind:1,created_at:start+i,tags:[],content:'bounded-'+(start+i)},key)))])),JSON.stringify(['EOSE',sub])];};
  const result=await h.service.query({...request,options:{limit:2}},author,signal(),()=>{});
  assert.deepEqual(result.events.map(row=>row.event.created_at),[64,63]);assert.equal(result.incomplete,true);assert.deepEqual(result.events[0]?.sidecar?.relayHints,['wss://second.nostr.net']);assert.equal(h.calls.length,2);
});
