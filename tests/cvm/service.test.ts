import test from 'node:test';import assert from 'node:assert/strict';
import {CvmService,type CvmHostPort,type CvmIngress} from '../../src/cvm/cvm-service.ts';
import type {CvmNativeSession} from '../../src/cvm/cvm-session.ts';
const key='a'.repeat(64),scope={endpoint:'source',generation:'generation',sourceRevision:'source-revision',identity:key,epoch:1,publisher:key,appId:'agent',version:key,instance:'instance'};
const row=(token:string,id:string):CvmIngress=>({token,scope,requestId:id,server:{pubkey:key,relays:['wss://relay.damus.io']},message:JSON.stringify({jsonrpc:'2.0',id,method:'tools/list'}),operation:'tools/list',progressTokenJSON:null,options:{initialize:false,payment:'deny',timeoutMs:100},remainingMs:100});
function fixture(){const inputs=new Map([['one',row('one','rpc1')],['two',row('two','rpc2')]]),finished:Array<[string,string|null]>=[],rejected:string[]=[];let current=true,opens=0,approved=0;
 const native:CvmNativeSession={request:async(_p,m)=>({jsonrpc:'2.0',id:m.id!,result:{tools:[]}}),onEvent:()=>()=>{},onClosed:()=>()=>{},close:async()=>{}};
 const host:CvmHostPort={take:t=>inputs.get(t)??null,current:()=>current,approve:t=>{approved++;return 'permit-'+t;},reject:t=>{rejected.push(t);},finish:(t,r)=>{finished.push([t,r]);},event:()=>true,open:async()=>{opens++;return native;}};
 const service=new CvmService(host);return {service,host,finished,rejected,get opens(){return opens;},get approved(){return approved;},revoke:()=>{current=false;}};}
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
test('native source scope survives another card focus; exact approval precedes open and final result',async()=>{const f=fixture(),work=f.service.receive('one');await tick();assert.equal(f.service.getSnapshot().current?.review.message.method,'tools/list');assert.equal(f.opens,0);f.service.decide('one',true);await work;assert.equal(f.opens,1);assert.equal(JSON.parse(f.finished[0][1]!).message.result.tools.length,0);f.service.dispose();});
test('rejected review performs no native open and consumes exact pending request',async()=>{const f=fixture(),work=f.service.receive('one');await tick();f.service.decide('one',false);await work;assert.equal(f.opens,0);assert.equal(f.approved,0);assert.deepEqual(f.rejected,['one']);assert.equal(JSON.parse(f.finished[0][1]!).error,'session closed');f.service.dispose();});
test('source revoked during visible review cannot approve or reopen; fresh deadline cannot revive it',async()=>{const f=fixture(),work=f.service.receive('one');await tick();f.revoke();f.service.decide('one',true);await work;assert.equal(f.approved,0);assert.equal(f.opens,0);assert.equal(f.service.getSnapshot().current,null);f.service.dispose();});
test('closing exact source aborts review and another endpoint does not gain its permit',async()=>{const f=fixture(),work=f.service.receive('one');await tick();f.service.close('unrelated');assert.equal(f.service.getSnapshot().current?.id,'one');f.service.close('source');await work;assert.equal(f.opens,0);assert.equal(f.service.getSnapshot().current,null);f.service.dispose();});
test('native remaining ingress budget covers held review and expired request releases queue',async()=>{const f=fixture();const old=f.host.take;f.host.take=t=>{const r=old(t);return r?{...r,remainingMs:5}:null;};await f.service.receive('one');assert.equal(f.opens,0);assert.equal(f.service.getSnapshot().current,null);assert.equal(JSON.parse(f.finished[0][1]!).error,'relay timeout');f.service.dispose();});

test('same-generation fresh native registration cannot revive an old reviewed endpoint or queued event',async()=>{
 const f=fixture(),original=f.host.take;let revision='source-revision';
 f.host.current=(_generation,sourceRevision)=>sourceRevision===revision;
 f.host.take=token=>{const input=original(token);return input?{...input,scope:{...input.scope,sourceRevision:revision}}:null;};
 const first=f.service.receive('one');await tick();revision='after-background';
 const second=f.service.receive('two');await tick();await first;
 assert.equal(f.service.getSnapshot().current?.id,'two');assert.equal(f.opens,0);
 f.service.decide('two',true);await second;assert.equal(f.opens,1);assert.equal(f.approved,1);
 assert.equal(JSON.parse(f.finished.find(row=>row[0]==='one')![1]!).error,'session closed');f.service.dispose();
});

test('a native event delivery denial cancels the operation instead of silently dropping a notification',async()=>{
 const f=fixture();let event!:(value:unknown,permit?:string)=>void,closed=0;
 f.host.event=()=>false;f.host.open=async()=>({request:async()=>new Promise(()=>{}),onEvent:handler=>{event=handler;return()=>{};},onClosed:()=>()=>{},async close(){closed++;}});
 const work=f.service.receive('one');await tick();f.service.decide('one',true);await tick();
 event({jsonrpc:'2.0',method:'notifications/owned'},'permit-one');await work;
 assert.equal(closed,1);assert.equal(f.finished[0][1],null);assert.equal(JSON.parse(f.finished.at(-1)![1]!).error,'session closed');f.service.dispose();
});

function cleanupFixture(twoSources=false){
 const f=fixture(),finishFailure=new Error('owned finish failure'),rejectFailure=new Error('owned reject failure');
 const originalTake=f.host.take,attempts:string[]=[],signals:AbortSignal[]=[],nativeCloses:string[]=[],unsubscribed:string[]=[];
 let event:(value:unknown,permit?:string)=>void=()=>{};
 f.host.take=token=>{const input=originalTake(token);return input?{...input,remainingMs:1000,options:{...input.options,timeoutMs:1000},
   ...(token==='two'?(twoSources?{scope:{...input.scope,endpoint:'other-source',generation:'other-generation'}}:{message:JSON.stringify({jsonrpc:'2.0',method:'notifications/owned'}),operation:'notifications/owned'}):{})}:null;};
 f.host.finish=(token,response)=>{attempts.push('finish:'+token+':'+(response===null?'null':'response'));if(response===null)throw finishFailure;};
 f.host.reject=token=>{attempts.push('reject:'+token);throw rejectFailure;};
 f.host.open=async permit=>({request:async(_permit,_message,_deadline,signal)=>{signals.push(signal);return new Promise(()=>{});},
   onEvent:handler=>{event=handler;return()=>{unsubscribed.push(permit.token);};},onClosed:()=>()=>{},async close(){nativeCloses.push(permit.token);}});
 return {...f,finishFailure,rejectFailure,attempts,signals,nativeCloses,unsubscribed,event:(value:unknown)=>event(value,'permit-one')};
}
test('finish bridge failure cannot skip other ingress, local abort, native close or pending review cleanup',async()=>{
 const f=cleanupFixture(),first=f.service.receive('one');await tick();f.service.decide('one',true);await tick();
 const second=f.service.receive('two');await tick();
 assert.throws(()=>f.service.close('source'),error=>error===f.finishFailure);
 await Promise.all([first,second]);
 assert.equal(f.signals[0].aborted,true);assert.deepEqual(f.nativeCloses,['permit-one']);assert.deepEqual(f.unsubscribed,['permit-one']);
 assert.ok(f.attempts.includes('finish:one:null'));assert.ok(f.attempts.includes('finish:two:null'));assert.ok(f.attempts.includes('reject:two'));
 assert.ok(f.attempts.includes('finish:one:response'));assert.ok(f.attempts.includes('finish:two:response'));
 assert.equal(f.service.getSnapshot().current,null);assert.deepEqual(f.service.getSnapshot().pendingSessionIds,[]);f.service.dispose();
});
test('denied event delivery still aborts the native operation when finish reporting throws',async()=>{
 const f=cleanupFixture();f.host.event=()=>false;
 const work=f.service.receive('one');await tick();f.service.decide('one',true);await tick();
 assert.doesNotThrow(()=>f.event({jsonrpc:'2.0',method:'notifications/owned'}));await work;
 assert.equal(f.signals[0].aborted,true);assert.deepEqual(f.nativeCloses,['permit-one']);assert.deepEqual(f.service.getSnapshot().pendingSessionIds,[]);f.service.dispose();
});
for(const operation of ['pause','dispose']as const)test(operation+' attempts every source despite one finish bridge failure',async()=>{
 const f=cleanupFixture(true);const first=f.service.receive('one');await tick();f.service.decide('one',true);await tick();
 const second=f.service.receive('two');await tick();f.service.decide('two',true);await tick();
 assert.throws(()=>f.service[operation](),error=>error===f.finishFailure);await Promise.all([first,second]);
 assert.equal(f.signals.length,2);assert.ok(f.signals.every(signal=>signal.aborted));assert.deepEqual(f.nativeCloses,['permit-one','permit-two']);
 assert.ok(f.attempts.includes('finish:one:null'));assert.ok(f.attempts.includes('finish:two:null'));assert.deepEqual(f.service.getSnapshot().pendingSessionIds,[]);
 const before=f.attempts.length;if(operation==='dispose')await f.service.receive('one');else f.service.dispose();assert.equal(f.attempts.length,before);
});
test('expired review still attempts native finish when its abort reporter throws, without an uncaught signal callback',async()=>{
 const f=fixture(),failure=new Error('owned reject failure');let finishAttempts=0;const take=f.host.take;
 f.host.take=token=>{const input=take(token);return input?{...input,remainingMs:5}:null;};
 f.host.reject=()=>{throw failure;};f.host.finish=()=>{finishAttempts++;};
 await f.service.receive('one');assert.equal(finishAttempts,1);assert.equal(f.service.getSnapshot().current,null);
 assert.deepEqual(f.service.getSnapshot().pendingSessionIds,[]);f.service.dispose();
});
