import test from 'node:test';
import assert from 'node:assert/strict';
import {createOutboxReadService} from '../../src/outbox/read-service.ts';
import {createOutboxSubscriptions} from '../../src/outbox/subscriptions.ts';
import type {NativeRegistration} from '../../src/runtime/capability-protocol.ts';
import type {OutboxAuthorResolution} from '../../src/outbox/author-resolver.ts';
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
const author=(index:number)=>index.toString(16).padStart(64,'0');
const input=(index:number,timeoutMs=1000)=>({type:'outbox.query',id:'query'+index,
  filters:{authors:[author(index)],kinds:[31129],limit:16},options:{timeoutMs}});
const expired=(e:unknown)=>e instanceof Error&&e.message==='relay timeout';
function harness(now?:()=>number) {
  let sequence=0,running=0,peak=0;
  const metadata:{author:string;signal:AbortSignal;finish():void}[]=[],data:string[]=[],controllers:AbortController[]=[];
  const id=()=>`10000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`;
  const service=createOutboxReadService({resolve(_user,who,_purpose,signal){
    running++;peak=Math.max(peak,running);let finished=false;
    return new Promise<OutboxAuthorResolution>(resolve=>metadata.push({author:who,signal,finish(){
      if(finished)return;finished=true;running--;resolve({list:null,source:'cache',incomplete:false});
    }}));
  }},{newInstanceId:id,async queryOutboxRelay(_token,_id,_relay,_wire,sub){data.push(sub);return [JSON.stringify(['EOSE',sub])];},cancelPublishedRelay(){}},()=>({networkRelays:['wss://network.example.com'],lookupRelays:['wss://lookup.example.com']}),now);
  function start(index:number,timeoutMs=1000,check=()=>{},plan=false) {
    const controller=new AbortController();controllers.push(controller);
    const work=plan?service.plan(input(index,timeoutMs),author(99),controller.signal,check):service.query(input(index,timeoutMs),author(99),controller.signal,check,'exact-query-'+index);
    void work.catch(()=>{});return{work,abort:()=>controller.abort()};
  }
  return{service,id,start,metadata,data,peak:()=>peak,stop(){for(const controller of controllers)controller.abort();for(const row of metadata)row.finish();}};
}

test('shared query and subscription planning work waits FIFO while admitted work stays at two',async()=>{
  const h=harness(),jobs=[h.start(1),h.start(2),h.start(3,1000,()=>{},true),h.start(4)];
  try {
    await turn();assert.deepEqual(h.metadata.map(x=>x.author),[author(1),author(2)]);
    h.metadata[0]!.finish();await turn();assert.equal(h.metadata[2]!.author,author(3));
    h.metadata[1]!.finish();await turn();assert.equal(h.metadata[3]!.author,author(4));
    for(const row of h.metadata)row.finish();await Promise.all(jobs.map(x=>x.work));assert.equal(h.peak(),2);assert.equal(h.data.length,3);
  } finally {h.stop();await Promise.allSettled(jobs.map(x=>x.work));}
});

test('eight waiting operations are bounded and cancelling a waiter frees one queue place',async()=>{
  const h=harness(),jobs=Array.from({length:10},(_,i)=>h.start(i+1));
  try {
    await turn();assert.equal(h.metadata.length,2);await assert.rejects(h.start(11).work,expired);
    jobs[2]!.abort();await assert.rejects(jobs[2]!.work,expired);jobs.push(h.start(12));
    h.metadata[0]!.finish();await turn();assert.equal(h.metadata[2]!.author,author(4));assert.equal(h.peak(),2);
    assert.ok(!h.metadata.some(x=>x.author===author(3)||x.author===author(11)));
  } finally {h.stop();await Promise.allSettled(jobs.map(x=>x.work));}
});

test('original deadline includes waiting and expired queued work never starts metadata or transport',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval']});let clock=0;const h=harness(()=>clock),jobs=[h.start(1),h.start(2),h.start(3,10)];
  try {
    await turn();clock=10;t.mock.timers.tick(10);await assert.rejects(jobs[2]!.work,expired);
    h.metadata[0]!.finish();h.metadata[1]!.finish();await Promise.all(jobs.slice(0,2).map(x=>x.work));assert.equal(h.metadata.length,2);assert.equal(h.data.length,2);
  } finally {h.stop();await Promise.allSettled(jobs.map(x=>x.work));t.mock.timers.reset();}
});

test('promotion checks absolute expiry even before the request timer callback runs',async()=>{
  let clock=0;const h=harness(()=>clock),jobs=[h.start(1),h.start(2),h.start(3,10)];
  try {await turn();clock=10;h.metadata[0]!.finish();await assert.rejects(jobs[2]!.work,expired);assert.equal(h.metadata.length,2);}
  finally {h.stop();await Promise.allSettled(jobs.map(x=>x.work));}
});

test('cancelled caller does not release an uncooperative admitted work reservation',async()=>{
  const h=harness(),jobs=[h.start(1),h.start(2),h.start(3)];
  try {
    await turn();jobs[0]!.abort();jobs[1]!.abort();await Promise.all(jobs.slice(0,2).map(x=>assert.rejects(x.work,expired)));
    await turn();assert.equal(h.metadata.length,2);assert.ok(h.metadata.every(x=>x.signal.aborted));
    h.metadata[0]!.finish();await turn();assert.equal(h.metadata.length,3);assert.equal(h.metadata[2]!.author,author(3));assert.equal(h.peak(),2);
    h.metadata[2]!.finish();await jobs[2]!.work;assert.equal(h.data.length,1,'Cancelled admitted work must not resume data effects');
  } finally {h.stop();await Promise.allSettled(jobs.map(x=>x.work));}
});

test('stale exact authority and cancellation between promotion and continuation start no work',async()=>{
  for(const phase of ['promotion','continuation'] as const){
    const h=harness();let deny=false;let queued:ReturnType<typeof h.start>;
    const check=()=>{if(!deny)return;if(phase==='promotion')throw Error('exact source revoked');queueMicrotask(()=>queued.abort());};
    const jobs=[h.start(1),h.start(2)];queued=h.start(3,1000,check);jobs.push(queued);
    try {
      await turn();deny=true;h.metadata[0]!.finish();await assert.rejects(queued.work);await turn();assert.equal(h.metadata.length,2,phase);
      const next=h.start(4);jobs.push(next);await turn();assert.equal(h.metadata[2]!.author,author(4));assert.equal(h.peak(),2);h.metadata[2]!.finish();await next.work;
    } finally {h.stop();await Promise.allSettled(jobs.map(x=>x.work));}
  }
});

for(const mode of ['close','background-resume','revoke'] as const)test(`actual queued subscription ${mode} cannot revive an old planning request`,async()=>{
  const h=harness(),jobs=[h.start(1),h.start(2)],streams:{stopped:number}[]=[],messages:string[]=[];
  const manager=createOutboxSubscriptions({newInstanceId:h.id,open(_id,_url,_wire,sub,frame){const row={stopped:0};streams.push(row);queueMicrotask(()=>frame(JSON.stringify(['EOSE',sub])));return()=>row.stopped++;}},h.service);
  const registration:NativeRegistration={sessionId:'intent',generation:'generation',epoch:0,user:author(99),publisher:'a'.repeat(64),appId:'intent-preferences',version:'b'.repeat(64),instanceId:'intent',fixture:'published',domains:['outbox']};
  const session=manager.session({registration,assertActive(){}});
  try {
    await turn();session.subscribe({type:'outbox.subscribe',id:'live',subId:'own',filters:{authors:[author(3)],kinds:[31129],limit:128},options:{timeoutMs:1000,limit:128}},m=>{messages.push(m.type);return true;},'exact-subscription');
    await turn();assert.equal(h.metadata.length,2);assert.equal(streams.length,0);
    if(mode==='close')session.close({type:'outbox.close',id:'close',subId:'own'});
    else if(mode==='revoke')manager.revokeAll();
    else {manager.setForeground(false);manager.setForeground(true);}
    for(const row of h.metadata)row.finish();await Promise.all(jobs.map(x=>x.work));await turn();
    if(mode==='background-resume'){
      assert.equal(h.metadata.length,3,'Only the fresh foreground revision can plan');h.metadata[2]!.finish();await turn();assert.equal(streams.length,1);assert.ok(!messages.includes('outbox.closed'));
    } else {assert.equal(h.metadata.length,2);assert.equal(streams.length,0);}
  } finally {manager.revokeAll();h.stop();await Promise.allSettled(jobs.map(x=>x.work));}
});

for(const order of ['queries-first','subscription-plan-first'] as const)test(`actual subscription plus two startup queries succeeds with ${order}`,async()=>{
  const h=harness(),jobs:ReturnType<typeof h.start>[]=[],streams:{stopped:number}[]=[],messages:string[]=[];
  const manager=createOutboxSubscriptions({newInstanceId:h.id,open(_id,_url,_wire,sub,frame){const row={stopped:0};streams.push(row);queueMicrotask(()=>frame(JSON.stringify(['EOSE',sub])));return()=>row.stopped++;}},h.service);
  const session=manager.session({registration:{sessionId:'startup',generation:'startup',epoch:0,user:author(99),publisher:'a'.repeat(64),appId:'intent-preferences',version:'b'.repeat(64),instanceId:'startup',fixture:'published',domains:['outbox']},assertActive(){}});
  const subscribe=()=>session.subscribe({type:'outbox.subscribe',id:'sub',subId:'own',filters:{authors:[author(3)],kinds:[31129],limit:128},options:{timeoutMs:1000,limit:128}},m=>{messages.push(m.type);return true;},'exact-subscription');
  try {
    if(order==='queries-first'){jobs.push(h.start(1),h.start(2));subscribe();}
    else {subscribe();await turn();jobs.push(h.start(1),h.start(2));}
    await turn();assert.equal(h.metadata.length,2);assert.equal(streams.length,0);
    for(let wave=0;wave<5;wave++){for(const row of h.metadata)row.finish();await turn();}
    await Promise.all(jobs.map(x=>x.work));assert.equal(streams.length,1);assert.equal(h.metadata.length,3);assert.equal(h.peak(),2);assert.equal(h.data.length,2);assert.ok(!messages.includes('outbox.closed'));
  } finally {manager.revokeAll();h.stop();await Promise.allSettled(jobs.map(x=>x.work));}
});
