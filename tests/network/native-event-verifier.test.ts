import test from 'node:test';
import assert from 'node:assert/strict';
import {finalizeEvent, verifyEvent, type NostrEvent} from 'nostr-tools/pure';
import {createNativeEventVerifier, type PublicVerificationModule} from '../../src/network/native-event-verifier.ts';
import {captureQueryEvent, parseQueryFilters, verifyQueryEvent} from '../../src/network/relay-query-contract.ts';
import {createNativeRelayQuery} from '../../src/network/native-relay-query.ts';
const secret=new Uint8Array(32);secret[31]=1;
const event=()=>JSON.parse(JSON.stringify(finalizeEvent({kind:1,created_at:100,tags:[['proofmode','p'.repeat(11000)]],content:'\ud800'},secret))) as NostrEvent;
const id='00000000-0000-4000-8000-000000000001';
const filters=parseQueryFilters([{kinds:[1]}]);
const ok=(operationId:string,count=1)=>JSON.stringify({operationId,results:Array(count).fill(true)});
test('exact capture preserves synchronous outcomes except deferred Schnorr and freezes all public fields',()=>{
  const original=event(),captured=captureQueryEvent(original,filters);
  assert.deepEqual(captured,verifyQueryEvent(original,filters));assert.equal(Reflect.ownKeys(captured).length,7);
  assert(Object.isFrozen(captured)&&Object.isFrozen(captured.tags)&&Object.isFrozen(captured.tags[0]));
  for(const bad of [{...original,id:'0'.repeat(64)},{...original,content:'changed'},{...original,tags:[['x','\ud800']]}]){
    assert.throws(()=>captureQueryEvent(bad,filters));assert.throws(()=>verifyQueryEvent(bad,filters));
  }
  const invalid={...original,sig:'0'.repeat(128)};assert.doesNotThrow(()=>captureQueryEvent(invalid,filters));assert.throws(()=>verifyQueryEvent(invalid,filters));
});
test('public adapter captures exact immutable tuples and rejects every non-correlated or non-true response',async()=>{
  const raw=event(),captured=captureQueryEvent(raw,filters),cancelled:string[]=[];
  const module:PublicVerificationModule={async verifyPublicSignatures(operation,wire,budget){
    assert.equal(operation,id);assert.equal(budget,123);assert.deepEqual(JSON.parse(wire),[[captured.pubkey,captured.id,captured.sig]]);
    raw.tags[0]![1]='mutated';return ok(operation);
  },cancelPublicSignatures:operation=>{cancelled.push(operation);}};
  await createNativeEventVerifier(module,()=>id)([captured],new AbortController().signal,()=>{},123);
  assert.equal(captured.tags[0]![1]!.length,11000);assert.deepEqual(cancelled,[]);
  for(const response of ['null','{}',`{"operationId":"${id}","results":[false],"results":[true]}`,ok('foreign'),ok(id,0),ok(id,2),JSON.stringify({operationId:id,results:[false]}),JSON.stringify({operationId:id,results:['true']}),JSON.stringify({operationId:id,results:[true],extra:true})]){
    module.verifyPublicSignatures=async()=>response;
    await assert.rejects(createNativeEventVerifier(module,()=>id)([captured],new AbortController().signal,()=>{},100));
  }
});
test('aborted or stale adapters reject before dispatch and ignore uncooperative late completion',async()=>{
  let calls=0,resolve!:(value:string)=>void;const cancelled:string[]=[];
  const module:PublicVerificationModule={verifyPublicSignatures(){calls++;return new Promise(r=>{resolve=r;});},cancelPublicSignatures:value=>{cancelled.push(value);}};
  const captured=captureQueryEvent(event(),filters);
  const verify=createNativeEventVerifier(module,()=>id),controller=new AbortController();controller.abort();
  await assert.rejects(verify([captured],controller.signal,()=>{},100));assert.equal(calls,0);
  const active=new AbortController();let stale=false;
  const pending=verify([captured],active.signal,()=>{if(stale)throw Error('stale');},100);active.abort();
  await assert.rejects(pending);assert(cancelled.includes(id));stale=true;resolve(ok(id));await new Promise(r=>setImmediate(r));assert.equal(calls,1);
});
test('query timeout cannot retain old async verification rows, hints, or dispatch its next peer',async()=>{
  const framesEvent=event();let next=0,oldRelease! :()=>void,held=false;
  const peers:string[]=[];
  const port={newInstanceId:()=>`00000000-0000-4000-8000-${String(++next).padStart(12,'0')}`,
    cancelPublishedRelay(){},async queryPublishedRelay(_id:string,url:string,_wire:string,sub:string){peers.push(url);return[JSON.stringify(['EVENT',sub,framesEvent]),JSON.stringify(['EOSE',sub])];}};
  const service=createNativeRelayQuery(port,()=>['wss://one.example.com','wss://two.example.com'],30,{outbox:true,allowPartialOnLimit:true,
    verifyBatch:async()=>{held=true;await new Promise<void>(r=>{oldRelease=r;});}});
  const old=service.queryDetailed(filters,new AbortController().signal,()=>{});await assert.rejects(old);assert(held);assert.equal(peers.length,1);
  const fresh=createNativeRelayQuery(port,()=>['wss://fresh.example.com'],100,{outbox:true,
    verifyBatch:async()=>{throw Error('native slots still draining');}});
  await assert.rejects(fresh.queryDetailed(filters,new AbortController().signal,()=>{}));
  oldRelease();await new Promise(r=>setImmediate(r));assert.equal(peers.length,2,'old query never dispatches second peer');
});
test('one-shot query rejects invalid signature batch, preserves peer order and empty EOSE',async()=>{
  let next=0,verifications=0;const original=event();
  const port={newInstanceId:()=>`00000000-0000-4000-8000-${String(++next).padStart(12,'0')}`,cancelPublishedRelay(){},
    async queryPublishedRelay(_id:string,url:string,_wire:string,sub:string){return url.includes('empty')?[JSON.stringify(['EOSE',sub])]:[JSON.stringify(['EVENT',sub,{...original,sig:'0'.repeat(128)}]),JSON.stringify(['EOSE',sub])];}};
  const verifier=createNativeEventVerifier({async verifyPublicSignatures(operation,wire){verifications++;const tuples=JSON.parse(wire) as string[][];return JSON.stringify({operationId:operation,results:tuples.map(()=>verifyEvent({...original,sig:'0'.repeat(128)}))});},cancelPublicSignatures(){}},()=>id);
  const service=createNativeRelayQuery(port,()=>['wss://invalid.example.com','wss://empty.example.com'],100,{outbox:true,verifyBatch:verifier});
  const result=await service.queryDetailed(filters,new AbortController().signal,()=>{});assert.deepEqual(result.events,[]);assert.equal(result.incomplete,true);assert.equal(verifications,1);
});
test('late verified second peer cannot mutate an already returned partial snapshot or its hints',async()=>{
  const first=event(),second=JSON.parse(JSON.stringify(finalizeEvent({kind:1,created_at:101,tags:[],content:'later peer'},secret))) as NostrEvent;
  let next=0,verified=0,release! :()=>void;const peers:string[]=[];
  const port={newInstanceId:()=>`00000000-0000-4000-8000-${String(++next).padStart(12,'0')}`,cancelPublishedRelay(){},
    async queryPublishedRelay(_id:string,url:string,_wire:string,sub:string){peers.push(url);return[JSON.stringify(['EVENT',sub,url.includes('one')?first:second]),JSON.stringify(['EOSE',sub])];}};
  const service=createNativeRelayQuery(port,()=>['wss://one.example.com','wss://two.example.com','wss://three.example.com'],40,{outbox:true,allowPartialOnLimit:true,
    verifyBatch:async()=>{if(++verified===2)await new Promise<void>(r=>{release=r;});}});
  const partial=await service.queryDetailed(filters,new AbortController().signal,()=>{});
  assert.equal(partial.incomplete,true);assert.deepEqual(partial.events.map(row=>row.event.id),[first.id]);
  const snapshot=JSON.stringify(partial);assert(Object.isFrozen(partial.relayHints?.[first.id]));
  const fresh=createNativeRelayQuery(port,()=>['wss://fresh.example.com'],100,{outbox:true,verifyBatch:async()=>{}});
  assert.equal((await fresh.queryDetailed(filters,new AbortController().signal,()=>{})).events[0]!.event.id,second.id);
  release();await new Promise(r=>setImmediate(r));assert.equal(JSON.stringify(partial),snapshot);assert.equal(peers.length,3);
});
test('stale caller binding after asynchronous verification cannot deliver rows or dispatch another peer',async()=>{
  let next=0,calls=0,stale=false,release!:()=>void,entered!:()=>void;
  const waiting=new Promise<void>(r=>{entered=r;});
  const port={newInstanceId:()=>`00000000-0000-4000-8000-${String(++next).padStart(12,'0')}`,cancelPublishedRelay(){},
    async queryPublishedRelay(_id:string,_url:string,_wire:string,sub:string){calls++;return[JSON.stringify(['EVENT',sub,event()]),JSON.stringify(['EOSE',sub])];}};
  const service=createNativeRelayQuery(port,()=>['wss://one.example.com','wss://two.example.com'],100,{outbox:true,
    verifyBatch:async()=>{entered();await new Promise<void>(r=>{release=r;});}});
  const pending=service.queryDetailed(filters,new AbortController().signal,()=>{if(stale)throw Error('generation or identity revoked');});
  await waiting;stale=true;release();await assert.rejects(pending);assert.equal(calls,1);
});
