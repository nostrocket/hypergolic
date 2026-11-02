import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createResourceTransfers } from '../../src/resources/resource-transfers.ts';
import { createResourceBroker } from '../../src/resources/resource-broker.ts';
import { createResourceService } from '../../src/resources/resource-service.ts';
import { createResourceAdapter } from '../../runtime/src/resource-adapter.ts';
import { RESOURCE_LIMITS } from '../../src/resources/resource-contract.ts';
import type { NativeRegistration } from '../../src/runtime/capability-protocol.ts';

const registration: NativeRegistration = {sessionId:'resource-lab-1',generation:'generation-1',epoch:0,user:'1'.repeat(64),publisher:'2'.repeat(64),appId:'resource-lab',version:'3'.repeat(64),instanceId:'resource-lab-1',fixture:'resource-lab',domains:['resource','theme']};
const authority = {nativeToken:randomUUID(),assertActive() {}};
function harness(body = new TextEncoder().encode('a'.repeat(3 * 1024 * 1024))) {
  let current = true;
  const active = () => { if (!current) throw Error('revoked'); };
  const transfers = createResourceTransfers(randomUUID);
  const service = createResourceService({ https:async () => body, servers:() => [], sha256:async () => '' });
  const broker = createResourceBroker({service,transfers}, {registration,assertActive:active});
  const requests: unknown[] = [];
  const native = { async request(message: {type:string}) {
    requests.push(message);
    const result = await broker.dispatch(message,{...authority,assertActive:active});
    if (result === null) throw Error('denied');
    return JSON.parse(result);
  } };
  const adapter = createResourceAdapter(native, () => () => current);
  return {broker, adapter, requests, revoke:() => {current=false;broker.revoke();}, finish:()=>broker.revoke()};
}
test('private carrier delivers a real 3 MiB Blob while every native reply stays below the 2 MiB gate',async () => {
  const h = harness();
  try {
    const replies: Readonly<Record<string,unknown>>[]=[];
    await h.adapter({message:{type:'resource.bytes',id:'large',url:'https://assets.public.org/image'},send:reply=>{replies.push(reply);}});
    assert.equal(replies.length,1); const reply=replies[0]!;
    assert.deepEqual(Object.keys(reply).sort(),['blob','id','mime','type']);
    assert.ok(reply.blob instanceof Blob);assert.equal(reply.blob.size,3*1024*1024);assert.equal(reply.mime,reply.blob.type);assert.equal(reply.mime,'text/plain');
    assert.equal(await reply.blob.text(),'a'.repeat(3*1024*1024));
    assert.equal(h.requests.length,13);
    for(const request of h.requests) assert.ok(JSON.stringify(request).length < 2 * 1024 * 1024);
    const last=h.requests.at(-1) as {handle:string;offset:number};
    assert.equal(await h.broker.dispatch({type:'resource.__chunk',id:'replay',handle:last.handle,offset:0},authority),null);
  } finally {h.finish();}
});
test('bulk adapter preserves exact order, canonical per-item errors and complete Blobs',async()=>{
  const h=harness(new TextEncoder().encode('hello'));const replies:Readonly<Record<string,unknown>>[]=[];
  try {
    await h.adapter({message:{type:'resource.bytesMany',id:'many',urls:['https://assets.public.org/a','htree:unsupported','data:,world']},send:reply=>{replies.push(reply);}});
    const items=replies[0]!.items as {url:string;ok:boolean;blob:Blob;mime:string;error?:string}[];
    assert.equal(items.length,3);assert.equal(await items[0]!.blob.text(),'hello');assert.equal(items[1]!.error,'unsupported-scheme');assert.equal(await items[2]!.blob.text(),'world');
    for (const item of items.filter(item=>item.ok)) assert.equal(item.mime,item.blob.type);
    assert.equal(items.some(item=>'transfer' in item),false);
  } finally {h.finish();}
});
test('private handles cannot cross realms, skip a cursor or survive root cancel',()=>{
  const pool=createResourceTransfers(randomUUID); const a=pool.bind(()=>{}),b=pool.bind(()=>{});
  try {
    const value=a.stage('root',{bytes:new Uint8Array(RESOURCE_LIMITS.chunkBytes+1).fill(65),mime:'text/plain'});
    const request={type:'resource.__chunk',id:'chunk',handle:value.handle,offset:0};
    assert.throws(()=>b.read(request));assert.throws(()=>a.read({...request,offset:1}));
    assert.ok(a.read(request).base64);assert.throws(()=>a.read(request));a.cancel('root');
    assert.throws(()=>a.read({...request,offset:RESOURCE_LIMITS.chunkBytes}));
  } finally {a.revoke();b.revoke();}
});
test('revocation and expiry clear staged buffers without relying on an SDK read',()=>{
  let clock=0;let current=true;const pool=createResourceTransfers(randomUUID,()=>clock);
  const realm=pool.bind(()=>{if(!current)throw Error('revoked');});
  const value=realm.stage('root',{bytes:new Uint8Array([65]),mime:'text/plain'});
  clock=15000;assert.throws(()=>realm.read({type:'resource.__chunk',id:'read',handle:value.handle,offset:0}));
  const fresh=realm.stage('next',{bytes:new Uint8Array([65]),mime:'text/plain'});current=false;
  assert.throws(()=>realm.read({type:'resource.__chunk',id:'read',handle:fresh.handle,offset:0}));realm.revoke();
});
test('forged public scope/private metadata fails canonically and cancel emits no SDK acknowledgment',async()=>{
  const h=harness();const replies:Readonly<Record<string,unknown>>[]=[];
  try {
    await h.adapter({message:{type:'resource.bytes',id:'forged',url:'https://assets.public.org/a',transfer:{handle:randomUUID()},scope:'other'},send:reply=>{replies.push(reply);}});
    assert.deepEqual(replies,[{type:'resource.bytes.error',id:'forged',error:'invalid-request'}]);assert.equal(h.requests.length,0);
    await h.adapter({message:{type:'resource.cancel',id:'forged'},send:()=>{assert.fail('cancel must not reply');}});assert.equal(replies.length,1);
  } finally {h.finish();}
});
test('adapter rejects tampered chunks without forwarding a partial Blob',async()=>{
  const replies:Readonly<Record<string,unknown>>[]=[];
  const native={async request(request:{type:string;id?:unknown}) {
    if(request.type==='resource.bytes')return {type:request.type+'.result',id:request.id,transfer:{handle:randomUUID(),length:5,mime:'text/plain'}};
    return {type:request.type+'.result',id:request.id,base64:'QQ=='};
  }};
  await createResourceAdapter(native,()=>()=>true)({message:{type:'resource.bytes',id:'bad',url:'https://assets.public.org/a'},send:reply=>{replies.push(reply);}});
  assert.deepEqual(replies,[{type:'resource.bytes.error',id:'bad',error:'decode-failed'}]);
});
test('cancel during a private read drops all later success/error deliveries',async()=>{
  let release!:(value:any)=>void;let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
  const replies:Readonly<Record<string,unknown>>[]=[];
  const native={async request(request:{type:string;id?:unknown}) {
    if(request.type==='resource.bytes')return {type:request.type+'.result',id:request.id,transfer:{handle:randomUUID(),length:5,mime:'text/plain'}};
    if(request.type==='resource.cancel')throw Error('no ack');
    entered();return new Promise<any>(resolve=>{release=resolve;});
  }};
  const adapter=createResourceAdapter(native,()=>()=>true);
  const run=adapter({message:{type:'resource.bytes',id:'root',url:'https://assets.public.org/a'},send:reply=>{replies.push(reply);}});
  await started;await adapter({message:{type:'resource.cancel',id:'root'},send:reply=>{replies.push(reply);}});
  release({type:'resource.__chunk.result',id:'unused',base64:'aGVsbG8='});await run;assert.deepEqual(replies,[]);
});
