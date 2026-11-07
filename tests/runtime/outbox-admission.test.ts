import assert from 'node:assert/strict';
import test from 'node:test';
import {canDeferCapability, type NativeRegistration} from '../../src/runtime/capability-protocol.ts';
import {createCapabilityBroker} from '../../src/runtime/capability-broker.ts';
import type {OutboxReadService} from '../../src/outbox/read-service.ts';
import {NativeLeases} from './native-leases.ts';
import {deferred,hex,setup} from '../storage/harness.ts';

const registration: NativeRegistration = {sessionId:'outbox-admission',generation:'outbox-generation',epoch:0,
  user:hex(1),publisher:hex(2),appId:'outbox-admission',version:hex(3),instanceId:'outbox-admission',fixture:'published',domains:['outbox']};
const requests = [
  {type:'outbox.query',id:'directory',filters:[{kinds:[31237],limit:48}],options:{relays:['wss://relay.wavefunc.live'],timeoutMs:8000,limit:200}},
  {type:'outbox.getEvent',id:'event',eventId:hex(4),options:{author:hex(2)}},
  {type:'outbox.resolveRelays',id:'plan',target:{pubkey:hex(2),direction:'read'}},
  {type:'outbox.query',id:'another-query',filters:[{kinds:[1],limit:1}]},
];
const plan = {relays:['wss://relay.example.com/'],source:'fallback' as const,missingAuthors:[],incomplete:false};

test('only the three Outbox reads join the existing deferred-read profile',()=>{
  for(const {type} of requests) assert.equal(canDeferCapability(type),true,type);
  for(const type of ['outbox.publish','outbox.subscribe','outbox.close','outbox.query.result','outbox.resolveRelays.extra',
    'relay.publish','common.follow','media.session.create']) assert.equal(canDeferCapability(type),false,type);
});

for(const stopped of ['none','native-expired','owner-revoked','broker-revoked'] as const) test(`Outbox-only admission holds two, queues two and fences ${stopped}`,async t=>{
  const {database}=await setup(t), native=new NativeLeases(), release=deferred();
  const calls:string[]=[], seen:unknown[]=[];
  let ownerActive=true;
  const enter=async (request:unknown,user:string,signal:AbortSignal,active:()=>void,_nativeToken?:string)=>{
    active();assert.equal(user,registration.user);assert.equal(signal.aborted,false);
    const row=request as {type:string;id:string};calls.push(row.id);seen.push(request);await release.promise;active();
    return row;
  };
  const service:OutboxReadService={
    async query(...args){await enter(...args);return {events:[],incomplete:false,plan};},
    async getEvent(...args){await enter(...args);return {error:'not found'};},
    async resolveRelays(...args){await enter(...args);return plan;},
  };
  const broker=createCapabilityBroker(database,native,{registration,assertActive(){if(!ownerActive)throw Error('revoked');}},
    undefined,undefined,undefined,undefined,service);
  const tokens=requests.map(request=>native.add(registration,request));
  const jobs=tokens.map(token=>broker.dispatch(token));
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(calls,['directory','event']);
  // Capture is native-held and independent of the original caller's mutable object.
  const original=requests[2]!;const old=original.id;original.id='mutated-after-take';
  if(stopped==='native-expired')for(const token of tokens.slice(2))native.revoke(token);
  if(stopped==='owner-revoked')ownerActive=false;
  if(stopped==='broker-revoked')broker.revoke();
  release.resolve();await Promise.all(jobs);original.id=old;
  if(stopped==='none'){
    assert.deepEqual(calls,['directory','event','plan','another-query']);
    assert.equal((seen[2] as {id:string}).id,'plan');
    for(const [index,request]of requests.entries())assert.deepEqual(native.results.get(tokens[index]!),
      request.type==='outbox.query'?{type:request.type+'.result',id:request.id,events:[]}:
        request.type==='outbox.getEvent'?{type:request.type+'.result',id:request.id,error:'not found'}:
          {type:request.type+'.result',id:request.id,plan:{relays:plan.relays,source:plan.source}});
  }else{assert.equal(calls.length,2);for(const token of tokens.slice(2))assert.equal(native.results.get(token),null);}
  assert.equal(native.finishCalls,4);
});

test('Outbox broker overflow stays bounded and requires its own exact native grant/snapshot',async t=>{
  const {database}=await setup(t),native=new NativeLeases(),release=deferred();let calls=0;
  const service:OutboxReadService={async query(){calls++;await release.promise;return {events:[],incomplete:false,plan};}};
  const broker=createCapabilityBroker(database,native,{registration,assertActive(){}},undefined,undefined,undefined,undefined,service);
  const tokens=Array.from({length:5},(_,i)=>native.add(registration,{...requests[0],id:'burst-'+i}));
  const pending=tokens.map(token=>broker.dispatch(token));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,2);assert.deepEqual(native.results.get(tokens[4]!),{type:'outbox.query.result',id:'burst-4',events:[],error:'policy denied'});
  release.resolve();await Promise.all(pending);assert.equal(calls,4);
  for(const domains of [[],['relay']]){
    const denied={...registration,domains};const isolated=createCapabilityBroker(database,native,{registration:denied,assertActive(){}},undefined,undefined,undefined,undefined,service);
    const token=native.add(denied,requests[0]);await isolated.dispatch(token);assert.equal(native.results.get(token),null);
  }
  const mismatch=native.add({...registration,generation:'replacement'},requests[0]);await broker.dispatch(mismatch);
  assert.equal(native.results.get(mismatch),null);assert.equal(calls,4);
});
