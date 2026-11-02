import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createCapabilityBroker} from '../../src/runtime/capability-broker.ts';
import type {NativeRegistration} from '../../src/runtime/capability-protocol.ts';
import type {OutboxReadService} from '../../src/outbox/read-service.ts';
import {NativeLeases} from '../runtime/native-leases.ts';
import {setup, hex, deferred} from '../storage/harness.ts';
const registration = (patch: Partial<NativeRegistration> = {}): NativeRegistration => ({sessionId:'feed-1',generation:'generation-1',epoch:0,user:hex(1),publisher:hex(2),appId:'feed-lab',version:hex(3),instanceId:'feed-1',fixture:'feed-lab',domains:['outbox','relay'],...patch});
const request = (id = 'outbox-1') => ({type:'outbox.query',id,filters:[{kinds:[1]}]});
function bind(database: Parameters<typeof createCapabilityBroker>[0], native: NativeLeases, owner: NativeRegistration, service: OutboxReadService, active = () => {}) {
  return createCapabilityBroker(database,native,{registration:owner,assertActive:active},undefined,undefined,undefined,undefined,service);
}
const result = {events:[],incomplete:true,plan:{relays:['wss://nos.lol'],source:'fallback' as const,missingAuthors:[],incomplete:true}};
test('attested query uses captured identity and returns original correlation with incomplete evidence', async t => {
  const {database} = await setup(t), native = new NativeLeases(), owner = registration();
  const broker = bind(database,native,owner,{async query(input,user,_signal,active){assert.equal(user,owner.user); assert.equal((input as {id:string}).id,'outbox-1');active();return result;}});
  const token = native.add(owner,request()); await broker.dispatch(token);
  assert.deepEqual(native.results.get(token),{type:'outbox.query.result',id:'outbox-1',events:[],incomplete:true});
});
test('both outbox and relay grants, exact generation and namespace are required before routing', async t => {
  const {database} = await setup(t), native = new NativeLeases(); let calls = 0;
  const service = {async query(){calls++;return result;}};
  for (const patch of [{domains:['outbox']},{domains:['relay']},{generation:'foreign'},{user:hex(5)}]) {
    const owner = registration(), captured = registration(patch);
    const broker = bind(database,native, patch.domains ? captured : owner,service);
    const token = native.add(captured,request());await broker.dispatch(token);assert.equal(native.results.get(token),null);
  }
  assert.equal(calls,0);
});
test('malformed query gives required empty events with canonical error and zero routing calls', async t => {
  const {database} = await setup(t),native = new NativeLeases(),owner=registration();let calls=0;
  const broker=bind(database,native,owner,{async query(){calls++;return result;}});
  const token=native.add(owner,{...request(),user:hex(9)});await broker.dispatch(token);
  assert.deepEqual(native.results.get(token),{type:'outbox.query.result',id:'outbox-1',events:[],error:'invalid filter'});assert.equal(calls,0);
});
test('correlation replay is denied without another discovery or read', async t => {
  const {database}=await setup(t),native=new NativeLeases(),owner=registration();let calls=0;
  const broker=bind(database,native,owner,{async query(){calls++;return result;}});
  const a=native.add(owner,request()),b=native.add(owner,request());await broker.dispatch(a);await broker.dispatch(b);
  assert.equal(calls,1);assert.deepEqual(native.results.get(b),{type:'outbox.query.result',id:'outbox-1',events:[],error:'policy denied'});
});
test('native or broker revocation aborts outstanding Outbox and prevents stale reply', async t => {
  const {database}=await setup(t);
  for(const kind of ['native','broker']) {
    const native=new NativeLeases(),owner=registration(),started=deferred();let aborted=false;
    const broker=bind(database,native,owner,{async query(_input,_user,signal){started.resolve();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Error('cancelled'));},{once:true}));}});
    const token=native.add(owner,request(kind)),work=broker.dispatch(token);await started.promise;
    if(kind==='native') native.revoke(token);else broker.revoke();
    await work;assert.equal(aborted,true);assert.equal(native.results.get(token),null);
  }
});

for(const operation of ['outbox.getEvent','outbox.resolveRelays'] as const) test(`${operation} is native identity-bound and replay denied with canonical correlation`, async t => {
  const {database}=await setup(t),native=new NativeLeases(),owner=registration();let calls=0;
  const service={async query(){throw Error('wrong method');},async getEvent(_input:unknown,user:string){assert.equal(user,owner.user);calls++;return {error:'not found',incomplete:true as const};},async resolveRelays(_input:unknown,user:string){assert.equal(user,owner.user);calls++;return result.plan;}};
  const broker=bind(database,native,owner,service);
  const input=operation==='outbox.getEvent'?{type:operation,id:'new-read',eventId:hex(8)}:{type:operation,id:'new-read',target:{pubkey:hex(8)}};
  const a=native.add(owner,input),b=native.add(owner,input);await broker.dispatch(a);await broker.dispatch(b);
  assert.equal(calls,1);assert.deepEqual(native.results.get(b),{type:operation+'.result',id:'new-read',error:'policy denied'});
  assert.equal((native.results.get(a) as {type:string}).type,operation+'.result');
});
