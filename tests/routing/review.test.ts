import test from 'node:test';
import assert from 'node:assert/strict';
import {RoutingReviewService,type RoutingReviewRequest} from '../../src/routing/routing-review.ts';
import type {NativeRegistration} from '../../src/runtime/capability-protocol.ts';
const origin:NativeRegistration={user:'01'.repeat(32),epoch:0,publisher:'03'.repeat(32),appId:'caller',version:'04'.repeat(32),sessionId:'caller-view',generation:'caller-generation',instanceId:'caller-view',fixture:'published',domains:['inc']};
const topic:RoutingReviewRequest={kind:'topic',origin,topic:'exact-topic'};
test('blurred approvals have no effect and the exact live request can be reviewed on return', async()=>{
 const service=new RoutingReviewService();let focused=true;const result=service.ask(topic,()=>{},()=>focused),id=service.getSnapshot()!.id;focused=false;service.decide(id,{allow:true});assert.equal(service.getSnapshot(),null);focused=true;service.refresh();assert.equal(service.getSnapshot()!.id,id);service.decide(id,{allow:true});assert.deepEqual(await result,{allow:true});service.decide(id,{allow:true});assert.equal(service.getSnapshot(),null);
});
test('an expired native request loses its presentation and cannot be approved later',async()=>{
 const service=new RoutingReviewService();let live=true;const result=service.ask(topic,()=>{if(!live)throw Error('revoked');},()=>true),id=service.getSnapshot()!.id;live=false;service.refresh();assert.equal(service.getSnapshot(),null);service.decide(id,{allow:true});assert.deepEqual(await result,{allow:false});
});
test('pending limits bound each source and the process; cancellation resolves every retained request once',async()=>{
 const service=new RoutingReviewService(),pending:Promise<unknown>[]=[];
 for(let index=0;index<4;index++)pending.push(service.ask(topic,()=>{},()=>true));assert.deepEqual(await service.ask(topic,()=>{},()=>true),{allow:false});
 const other={...topic,origin:{...origin,generation:'other-generation'}};for(let index=0;index<4;index++)pending.push(service.ask(other,()=>{},()=>false));
 assert.deepEqual(await service.ask({...topic,origin:{...origin,generation:'third-generation'}},()=>{},()=>false),{allow:false});service.cancelAll();assert.deepEqual(await Promise.all(pending),Array.from({length:8},()=>({allow:false})));assert.equal(service.getSnapshot(),null);
});
test('an observer exception cannot interrupt revocation or retain a grant',async()=>{
 const service=new RoutingReviewService();service.subscribe(()=>{throw Error('broken presentation');});const result=service.ask(topic,()=>{},()=>true);service.cancelAll();assert.deepEqual(await result,{allow:false});assert.equal(service.getSnapshot(),null);
});
test('closing either endpoint dismisses its pending channel review',async()=>{
 const service=new RoutingReviewService(),peer={...origin,generation:'peer-generation',appId:'peer'};const result=service.ask({kind:'channel',origin,peer},()=>{},()=>true);service.close(peer.generation);assert.deepEqual(await result,{allow:false});assert.equal(service.getSnapshot(),null);
});
