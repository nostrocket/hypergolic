import assert from 'node:assert/strict';
import test from 'node:test';
import { createCapabilityBroker } from '../../src/runtime/capability-broker.ts';
import type { NativeRegistration } from '../../src/runtime/capability-protocol.ts';
import { hex, setup } from '../storage/harness.ts';
import { NativeLeases } from './native-leases.ts';

test('standard list preparation accepts an ordinary published caller with both grants and authenticates its captured owner',async t=>{
  const {database}=await setup(t), native=new NativeLeases();
  const caller:NativeRegistration={sessionId:'independent',generation:'generation',epoch:1,user:hex(1),publisher:hex(2),appId:'ordinary-catalog',
    version:hex(3),instanceId:'instance',fixture:'published',domains:['lists','relay']};
  const coordinate='35129:'+hex(2)+':example';
  const input={type:'lists.prepareRecommendation',id:'list-1',coordinate,create:true};
  const calls:unknown[]=[];
  const service={async prepareAddition(target:string,create:boolean){calls.push([target,create]);return {status:'missing'};},bind(){return null;}};
  for(const [grants,epoch,works] of [[['lists','relay'],1,true],[['relay'],1,false],[[],1,false],[['lists','relay'],2,false]] as const){
    const registration={...caller,domains:grants};
    const broker=createCapabilityBroker(database,native,{registration,assertActive(){}},undefined,undefined,undefined,undefined,undefined,undefined,service);
    const token=native.add({...registration,epoch},input);await broker.dispatch(token);
    assert.deepEqual(native.results.get(token),works?{type:'lists.prepareRecommendation.result',id:'list-1',result:{status:'missing'}}:null);
  }
  assert.deepEqual(calls,[[coordinate,true]]);
});

test('bundled Discover cannot invoke its former private relay methods', async t => {
  const {database} = await setup(t);
  const native = new NativeLeases();
  const registration: NativeRegistration = {
    sessionId: 'discover', generation: 'generation', epoch: 1, user: hex(1), publisher: hex(2),
    appId: 'napplet-discovery', version: hex(3), instanceId: 'instance', fixture: 'napplet-discovery',
    domains: ['lists', 'relay'],
  };
  const broker = createCapabilityBroker(database, native, {registration, assertActive() {}});
  for (const type of ['relay.catalogPage', 'relay.catalogRecommendation']) {
    const token = native.add(registration, {type, id: 'old'});
    await broker.dispatch(token);
    assert.equal(native.results.get(token), null);
  }
});
