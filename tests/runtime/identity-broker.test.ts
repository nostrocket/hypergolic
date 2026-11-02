import assert from 'node:assert/strict';
import test from 'node:test';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { createCapabilityBroker } from '../../src/runtime/capability-broker.ts';
import { createIdentityDataService } from '../../src/identity/identity-service.ts';
import { openIdentityCache } from '../../src/identity/identity-cache.ts';
import type { NativeRegistration } from '../../src/runtime/capability-protocol.ts';
import { NativeLeases } from './native-leases.ts';
import { setup, hex, deferred } from '../storage/harness.ts';
const secret = new Uint8Array(32); secret[31] = 1;
const config: NativeRegistration = {user:getPublicKey(secret), publisher:hex(2), appId:'state-lab', version:hex(3), instanceId:'one', sessionId:'one', generation:'generation', epoch:0, fixture:'state-lab', domains:['identity','storage','theme']};
const wire = {type:'identity.getProfile', id:'request'};
test('original native correlation and captured identity reach the profile resolver and native reply', async t => {
  const {sqlite,database}=await setup(t), cache=await openIdentityCache(sqlite,'android'), native=new NativeLeases();
  const signed=JSON.parse(JSON.stringify(finalizeEvent({kind:0,content:'{"name":"Known profile"}',tags:[],created_at:10},secret)));
  const service=createIdentityDataService(cache,{async query(filters){assert.deepEqual(filters[0]!.authors,[config.user]);return [{event:signed}];}});
  const broker=createCapabilityBroker(database,native,{registration:config,assertActive(){}},undefined,undefined,undefined,service);
  const token=native.add(config,wire);await broker.dispatch(token);
  assert.deepEqual(native.results.get(token),{type:'identity.getProfile.result',id:wire.id,profile:{name:'Known profile'}});
});
for(const cause of ['native','broker','identity']) test(`pending profile ${cause} revocation denies a late reply`,async t=>{
  const {sqlite,database}=await setup(t),cache=await openIdentityCache(sqlite,'android'),native=new NativeLeases(),held=deferred();let called=false,live=true,aborted=false;
  const service=createIdentityDataService(cache,{async query(_,signal){called=true;signal.addEventListener('abort',()=>{aborted=true;},{once:true});await held.promise;return [];}});
  const broker=createCapabilityBroker(database,native,{registration:config,assertActive(){if(!live)throw Error('revoked');}},undefined,undefined,undefined,service);
  const token=native.add(config,wire),pending=broker.dispatch(token);
  while(!called)await new Promise(resolve=>setImmediate(resolve));
  if(cause==='native')native.revoke(token);else if(cause==='broker')broker.revoke();else live=false;
  await pending;held.resolve();assert.equal(aborted,true);assert.equal(native.results.get(token),null);
});
test('forged ownership and missing identity grant never invoke the data resolver',async t=>{
  const {database}=await setup(t),native=new NativeLeases();let calls=0;
  const service={async read(){calls++;throw Error('unexpected');}};
  for(const [owner,captured,request] of [[config,{...config,generation:'foreign'},wire],[{...config,domains:['storage']},{...config,domains:['storage']},wire],[config,config,{...wire,user:hex(9)}]] as const){
    const broker=createCapabilityBroker(database,native,{registration:owner,assertActive(){}},undefined,undefined,undefined,service);
    const token=native.add(captured,request);await broker.dispatch(token);assert.equal(native.results.get(token),null);
  }
  assert.equal(calls,0);
});
