import test from 'node:test';
import assert from 'node:assert/strict';
import {finalizeEvent,getPublicKey,type NostrEvent} from 'nostr-tools/pure';
import {createOutboxAuthorResolver,type OutboxAuthorResolver} from '../../src/outbox/author-resolver.ts';
import {createOutboxReadService} from '../../src/outbox/read-service.ts';
import {createNativeRelayQuery} from '../../src/network/native-relay-query.ts';
import {parseOutboxRelayList} from '../../src/outbox/relay-list.ts';
const signed=(input:Parameters<typeof finalizeEvent>[0],secret:Uint8Array)=>JSON.parse(JSON.stringify(finalizeEvent(input,secret))) as NostrEvent;
const key=new Uint8Array(32).fill(42),author=getPublicKey(key);
const signal=()=>new AbortController().signal;
const peers=['wss://network.example.com'];
const request={type:'outbox.query',id:'own-preferences',filters:[{kinds:[31129],authors:[author],limit:128}],options:{authors:[author],limit:128,timeoutMs:8000}};
function transport() {
  let sequence=0;const calls:string[]=[];
  return {calls,newInstanceId:()=>`10000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`,
    async queryOutboxRelay(_token:string,_id:string,relay:string,_wire:string,sub:string){calls.push(relay);return [JSON.stringify(['EOSE',sub])];},cancelPublishedRelay(){}};
}
function reads(resolver:OutboxAuthorResolver) {
  const native=transport();return {native,service:createOutboxReadService(resolver,native,()=>({networkRelays:peers,lookupRelays:['wss://lookup.example.com']}))};
}
for(const cached of [false,true])test(`known absence from ${cached?'fresh negative cache':'complete matching EOSE lookup'} permits complete empty fallback`,async()=>{
  let stored: {event:NostrEvent|null;fetchedAt:number}|null=cached?{event:null,fetchedAt:Date.now()}:null;
  let lookups=0,writes=0;const native=transport();
  const discovery=createNativeRelayQuery({newInstanceId:native.newInstanceId,async queryPublishedRelay(_id,_relay,_wire,sub){lookups++;return [JSON.stringify(['EOSE',sub])];},cancelPublishedRelay(){}},()=>['wss://lookup.example.com','wss://lookup-two.example.com']);
  const resolver=createOutboxAuthorResolver({async read(){return stored;},async write(_user,_author,row){stored=row;writes++;},async close(){}},discovery);
  const h=reads(resolver);const result=await h.service.query(request,author,signal(),()=>{},'exact-query-claim');
  assert.deepEqual(result.events,[]);assert.equal(result.incomplete,false);
  assert.deepEqual(result.plan,{relays:peers,source:'fallback',missingAuthors:[author],incomplete:false});
  assert.equal(lookups,cached?0:2);assert.equal(writes,cached?0:1);assert.deepEqual(h.native.calls,peers);
  await assert.rejects(h.service.resolveRelays({type:'outbox.resolveRelays',id:'write',target:{pubkey:author,direction:'write'}},author,signal(),()=>{}),/relay list unavailable/);
  assert.deepEqual(h.native.calls,peers,'Write diagnostic must not dispatch data');
});

test('failed discovery, stale negative cache, incomplete metadata and invalid signed metadata remain unknown',async()=>{
  for(const mode of ['failed','stale-negative','partial','invalid'] as const){
    let stored=mode==='stale-negative'?{event:null,fetchedAt:Date.now()-2*86400000}:null;
    let writes=0;const n=transport();
    const invalid=signed({kind:10002,created_at:1,tags:[],content:''},key);invalid.sig='0'.repeat(128);
    const discovery=createNativeRelayQuery({newInstanceId:n.newInstanceId,async queryPublishedRelay(_id,relay,_wire,sub){
      if(mode==='failed'||mode==='stale-negative'||mode==='partial'&&relay.endsWith('two.example.com'))throw Error('controlled failure');
      return [...(mode==='invalid'?[JSON.stringify(['EVENT',sub,invalid])]:[]),JSON.stringify(['EOSE',sub])];},cancelPublishedRelay(){}},()=>['wss://lookup.example.com','wss://lookup-two.example.com']);
    const resolver=createOutboxAuthorResolver({async read(){return stored;},async write(){writes++;},async close(){}},discovery);
    const result=await reads(resolver).service.query(request,author,signal(),()=>{},'query');
    assert.equal(result.incomplete,true,mode);assert.equal(result.plan.incomplete,true,mode);assert.deepEqual(result.plan.missingAuthors,[author]);assert.equal(writes,0,mode);
  }
});

test('explicit signed list without write routes remains conservative rather than becoming known absence',async()=>{
  const event=signed({kind:10002,created_at:1,content:'',tags:[['r','wss://inbox.example.com','read']]},key);
  const list=parseOutboxRelayList(event,author);assert.equal(list.write.length,0);
  const h=reads({async resolve(){return {list,source:'nip65',incomplete:false};}});
  const result=await h.service.query(request,author,signal(),()=>{},'query');assert.equal(result.incomplete,true);assert.deepEqual(result.plan.missingAuthors,[author]);
});

test('one known-absent author cannot hide another unresolved author or wide route overflow',async()=>{
  const profiles=Array.from({length:22},(_,i)=>{const secret=new Uint8Array(32);secret[31]=i+1;const pubkey=getPublicKey(secret);return{pubkey,list:parseOutboxRelayList(signed({kind:10002,created_at:1,content:'',tags:[['r',`wss://author${i}.example.com`,'write']]},secret),pubkey)};});
  const missing=profiles[0]!.pubkey,unknown=profiles[1]!.pubkey;
  const unresolved=reads({async resolve(_user,who){if(who===missing)return {list:null,source:'cache',incomplete:false};throw Error('unresolved');}});
  const partial=await unresolved.service.query({...request,filters:[{kinds:[31129],authors:[missing,unknown]}],options:{authors:[missing,unknown]}},author,signal(),()=>{},'query');
  assert.equal(partial.incomplete,true);assert.deepEqual(partial.plan.missingAuthors,[missing,unknown]);
  const resolver:OutboxAuthorResolver={async resolve(_user,who){return {list:who===missing?null:profiles.find(p=>p.pubkey===who)!.list,source:'cache',incomplete:false};}};
  const wide=reads(resolver),result=await wide.service.query({...request,filters:profiles.slice(0,5).map(p=>({kinds:[31129],authors:[p.pubkey],limit:1})),options:{authors:profiles.map(p=>p.pubkey)}},author,signal(),()=>{},'query');
  assert.equal(result.incomplete,true);assert.equal(result.plan.relays.length,16);assert.ok(result.plan.missingAuthors.includes(missing));assert.equal(result.plan.missingAuthors.length,7);assert.equal(wide.native.calls.length,16);
});
