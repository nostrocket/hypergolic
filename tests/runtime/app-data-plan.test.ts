import assert from 'node:assert/strict';
import test from 'node:test';
import {finalizeEvent,getPublicKey,type NostrEvent} from 'nostr-tools/pure';
import {createAppDataPlanner,appDataFailure} from '../../src/app-data/app-data-plan.ts';
import {APP_DATA_PROFILE,deriveAppDataScope,dataTags} from '../../src/app-data/app-data-contract.ts';
import type {NativeRegistration} from '../../src/runtime/capability-protocol.ts';
import {captureEventSnapshot} from '../../src/security/event-snapshot.ts';
import {validateSignedEvent} from '../../src/security/signed-event.ts';
import {deferred} from '../storage/harness.ts';
const secret=new Uint8Array(32).fill(37),user=getPublicKey(secret),publisher='2'.repeat(64),appId='app-data-test';
const scope=deriveAppDataScope({publisher,kind:35129,identifier:appId});
const peers=['wss://one.example.com','wss://two.example.com'];
const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
function origin(patch:Partial<NativeRegistration>={}):NativeRegistration{return {sessionId:'app-data-source',generation:'app-data-generation',epoch:0,
  user,publisher,appId,version:'3'.repeat(64),instanceId:'app-data-instance',fixture:'published',domains:['identity','outbox'],
  appData:{sourceKind:35129,policy:{profile:APP_DATA_PROFILE,scope,maxContentBytes:3072,relays:peers,defaultRelays:[peers[0]!]}},...patch};}
function event(id:string,previous:string|null=null,created_at=1800000100,deleted=false){return {kind:30078,created_at,
  tags:dataTags(scope,'levels',id,'example.level',1),content:JSON.stringify({schema:'example.level',version:1,title:id,previous,deleted,data:deleted?null:{description:'fixture'}})};}
function signed(template:ReturnType<typeof event>):NostrEvent{return clone(finalizeEvent({...clone(template),tags:template.tags.map(row=>[...row])},secret));}
function request(id:string,template=event(id),destinations=peers){return {type:'outbox.publish',id:'wire-'+id,event:template,options:{toOutbox:false,relays:destinations}};}
function fixture(){
  let network=peers.slice(),events:NostrEvent[]=[],incomplete=false,wait:Promise<void>|null=null;
  const queries:Array<{filters:unknown;relays:readonly string[]}>=[],publications:unknown[]=[];
  const planner=createAppDataPlanner({settings:()=>({networkRelays:network,lookupRelays:['wss://lookup.example.com']}),
    async query(filters,relays,_signal,active){active();queries.push({filters,relays});if(wait)await wait;active();return {events:events.map(event=>({event:clone(event)})),incomplete};},
    async publication(value,selected,_signal,active){active();assert.equal(selected,user);publications.push(value);
      const input=value as ReturnType<typeof request>;const snapshot=captureEventSnapshot(input.event,user,input.options.relays);
      return {requestId:input.id,event:snapshot,destinations:snapshot.destinations.map(relay=>({relay,sources:[{kind:'explicit' as const}]})),requiredInboxes:[],ownSource:'skipped',ancillary:null};},
  },()=>1800000100000);
  return {planner,queries,publications,setEvents(value:NostrEvent[]){events=value;},setPartial(value:boolean){incomplete=value;},setNetwork(value:string[]){network=value;},setWait(value:Promise<void>|null){wait=value;}};
}
const active=()=>{},signal=()=>new AbortController().signal;
test('complete current-record reads precede presentation; raw Relay remains independent of Outbox',async()=>{
  const f=fixture(),plan=await f.planner.plan(request('new'),origin(),signal(),active);
  assert.equal(plan.context.policy.scope,scope);assert.equal(plan.publication.ancillary,null);
  assert.deepEqual(f.queries[0]!.relays,peers.map(peer=>peer+'/'));assert.deepEqual(f.queries[0]!.filters,[{kinds:[30078],authors:[user],'#d':[plan.record.identifier],limit:1}]);
  f.planner.release(plan);
  const raw=await f.planner.plan({type:'relay.publish',id:'raw',event:event('raw')},origin({domains:['identity','relay']}),signal(),active);
  assert.equal(raw.route,'relay');assert.equal(f.publications.length,1);f.planner.release(raw);
});
test('claimed malformed/foreign-scope/ungranted records and unconfigured destinations never reach review or signing',async()=>{
  const f=fixture();
  await assert.rejects(f.planner.plan(request('none'),origin({appData:undefined} as unknown as Partial<NativeRegistration>),signal(),active));
  const bad=event('malformed');bad.tags=bad.tags.filter(tag=>tag[0]!=='L'&&tag[0]!=='l');
  await assert.rejects(f.planner.plan(request('malformed',bad),origin(),signal(),active));
  const foreign={...event('foreign'),tags:dataTags('f'.repeat(64),'levels','foreign','example.level',1)};
  await assert.rejects(f.planner.plan(request('foreign',foreign),origin(),signal(),active));assert.equal(f.queries.length,0);
  await assert.rejects(f.planner.plan(request('peer',event('peer'),['wss://foreign.example.com']),origin(),signal(),active));assert.equal(f.queries.length,0);
});
test('partial lookups and changed settings fail closed, releasing only settled preparation',async()=>{
  const f=fixture();f.setPartial(true);await assert.rejects(f.planner.plan(request('partial'),origin(),signal(),active));
  f.setPartial(false);const gate=deferred();f.setWait(gate.promise);
  const pending=f.planner.plan(request('settings'),origin(),signal(),active);await new Promise(resolve=>setImmediate(resolve));
  f.setNetwork([peers[1]!,peers[0]!]);gate.resolve();await assert.rejects(pending);
  f.setWait(null);f.setNetwork(peers);const plan=await f.planner.plan(request('settings'),origin(),signal(),active);f.planner.release(plan);
});
test('newest invalid or tombstone revision never falls back to an older compatible creation',async()=>{
  const f=fixture(),base=signed(event('latest',null,1800000080));
  const invalid=signed({...event('latest',base.id,1800000090),content:'{"invalid":true}'});
  f.setEvents([base,invalid]);await assert.rejects(f.planner.plan(request('latest',event('latest',base.id)),origin(),signal(),active));
  const tombstone=signed(event('latest',base.id,1800000090,true));f.setEvents([base,tombstone]);
  await assert.rejects(f.planner.plan(request('latest',event('latest',base.id)),origin(),signal(),active));
  const restore=await f.planner.plan(request('latest',event('latest',tombstone.id)),origin(),signal(),active);f.planner.release(restore);
});
test('lost ACK retry reuses exact signed bytes only when the newest overall required-peer revision permits it',async()=>{
  const f=fixture(),input=request('retry'),first=await f.planner.plan(input,origin(),signal(),active);
  const exact=validateSignedEvent(first.publication.event,signed(input.event));f.planner.signed(first,exact);f.planner.release(first);
  f.setEvents([{...exact,tags:exact.tags.map(row=>[...row])}]);const retry=await f.planner.plan({...input,id:'new-wire-id'},origin(),signal(),active);
  assert.deepEqual(f.planner.cached(retry),exact);await f.planner.revalidate(retry,signal(),active);f.planner.release(retry);
  const competing=signed(event('retry',exact.id,1800000101));f.setEvents([{...exact,tags:exact.tags.map(row=>[...row])},competing]);
  await assert.rejects(f.planner.plan(input,origin(),signal(),active));
});
test('account plus record locks span loaded instances; different records progress; actual approved work retains the lock until settlement',async()=>{
  const f=fixture(),plan=await f.planner.plan(request('lock'),origin(),signal(),active);
  await assert.rejects(f.planner.plan(request('lock'),origin({sessionId:'another-source',generation:'another-generation',instanceId:'another-instance'}),signal(),active));
  const other=await f.planner.plan(request('other'),origin(),signal(),active);f.planner.release(other);
  const done=f.planner.retain(plan);f.planner.release(plan);
  await assert.rejects(f.planner.plan(request('lock'),origin(),signal(),active));assert.throws(()=>f.planner.cached(plan));done();
  const after=await f.planner.plan(request('lock'),origin(),signal(),active);f.planner.release(after);
});
test('A to B to A and generation replacement never inherit a previous cached signing result',async()=>{
  const f=fixture(),input=request('epoch'),plan=await f.planner.plan(input,origin(),signal(),active);
  f.planner.signed(plan,validateSignedEvent(plan.publication.event,signed(input.event)));f.planner.release(plan);
  const later=await f.planner.plan(input,origin({epoch:2,generation:'replacement-generation'}),signal(),active);
  assert.equal(f.planner.cached(later),null);f.planner.release(later);
  f.planner.close('app-data-source');const closed=await f.planner.plan(input,origin(),signal(),active);assert.equal(f.planner.cached(closed),null);f.planner.release(closed);
});
test('revocation after review and settings change after signing cannot pass final revalidation',async()=>{
  const f=fixture(),plan=await f.planner.plan(request('late'),origin(),signal(),active);let current=true;
  const guard=()=>{if(!current)throw Error('APPROVAL_DENIED');};current=false;
  await assert.rejects(f.planner.revalidate(plan,signal(),guard));current=true;
  f.planner.signed(plan,validateSignedEvent(plan.publication.event,signed(event('late'))));f.setNetwork([peers[1]!]);
  await assert.rejects(f.planner.revalidate(plan,signal(),guard));f.planner.release(plan);
});
test('failure mapping never probes rejected prototypes or leaks unknown native diagnostics',()=>{
  let inspected=0;const rejected=new Proxy({}, {getPrototypeOf(){inspected++;throw Error('private');},getOwnPropertyDescriptor(){throw Error('private');}});
  assert.equal(appDataFailure(rejected),'app-data-failed');assert.equal(inspected,0);
  assert.equal(appDataFailure(Error('private native text')),'app-data-failed');assert.equal(appDataFailure(Error('app-data-conflict')),'app-data-conflict');
});
