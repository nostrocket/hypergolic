import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {finalizeEvent} from 'nostr-tools/pure';
import {createRelaySubscriptions,type NativeRelayStreamPort} from '../../src/network/relay-subscriptions.ts';
import {createRelaySubscriptionBroker,type NativeRelaySubscriptionPort} from '../../src/runtime/relay-subscription-broker.ts';
import type {NativeRegistration} from '../../src/runtime/capability-protocol.ts';
import {createCapabilityBroker} from '../../src/runtime/capability-broker.ts';
import {NativeLeases} from './native-leases.ts';
import {setup} from '../storage/harness.ts';
const registration:NativeRegistration={sessionId:'feed',generation:'native-one',epoch:1,user:'1'.repeat(64),publisher:'2'.repeat(64),appId:'feed-lab',version:'3'.repeat(64),instanceId:'instance',fixture:'feed-lab',domains:['relay','theme']};
const request=(subId='caller')=>({type:'relay.subscribe',id:'request-'+subId,subId,filters:[{kinds:[1],limit:2}]});
const secret=new Uint8Array(32);secret[31]=1;
const event=()=>JSON.parse(JSON.stringify(finalizeEvent({kind:1,created_at:100,content:'verified broker event',tags:[]},secret)));
function harness(t:TestContext) {
  let next=0,ownerActive=true,foreground=true;
  const rows=new Map<string,{raw:string;claimed:boolean;accepted:boolean;active:boolean}>();
  const closed:string[]=[],messages:unknown[]=[];
  const native:NativeRelaySubscriptionPort={take(token){const row=rows.get(token);if(!row||row.claimed)return null;row.claimed=true;return row.raw;},
    accept(token){const row=rows.get(token);if(!row||!row.claimed||row.accepted||!row.active||!foreground)return false;row.accepted=true;return true;},
    isActive:token=>rows.get(token)?.accepted===true&&rows.get(token)?.active===true,
    mayDeliver:token=>foreground&&native.isActive(token),send(token,response){if(!native.isActive(token))return false;if(!foreground)return 'paused';messages.push(JSON.parse(response));return true;},
    close(token){closed.push(token);const row=rows.get(token);if(row)row.active=false;}};
  const calls:{sub:string;token:string|undefined;frame:(text:string)=>void;stopped:number}[]=[];
  const port:NativeRelayStreamPort={newInstanceId:()=>`00000000-0000-4000-8000-${String(++next).padStart(12,'0')}`,
    open(_id,_url,_request,sub,frame,_failed,token){const call={sub,frame,token,stopped:0};calls.push(call);return()=>call.stopped++;}};
  const manager=createRelaySubscriptions(port,()=>['wss://relay.example.org']);
  const owner={registration,assertActive(){if(!ownerActive)throw new Error('Owner revoked');}};
  const broker=createRelaySubscriptionBroker(native,manager,owner);t.after(()=>{broker.revoke();manager.revokeAll();});
  const admit=(input:unknown=request(),captured=registration)=>{const token='token-'+(++next);rows.set(token,{raw:JSON.stringify({registration:captured,request:JSON.stringify(input)}),claimed:false,accepted:false,active:true});broker.dispatch(token);return token;};
  const frame=(index=0)=>calls[index]!.frame(JSON.stringify(['EVENT',calls[index]!.sub,event()]));
  return{admit,broker,manager,native,rows,calls,closed,messages,owner,frame,setOwner:(active:boolean)=>{ownerActive=active;},setForeground:(active:boolean)=>{foreground=active;}};
}
test('immutable native admission binds the exact owner and accepts a single claim before any WSS operation',t=> {
  const h=harness(t),token=h.admit();assert.equal(h.calls[0]!.token,token);h.frame();assert.equal((h.messages[0] as any).subId,'caller');
  h.broker.dispatch(token);assert.equal(h.calls.length,1);h.broker.revoke();assert.equal(h.calls[0]!.stopped,1);h.frame();assert.equal(h.messages.length,1);
});
test('foreign identity, generation, epoch, version and grants cannot acquire the native stream recipient',t=> {
  const h=harness(t);
  for(const patch of [{user:'4'.repeat(64)},{generation:'native-two'},{epoch:2},{version:'5'.repeat(64)},{domains:['relay']}]) {
    const token=h.admit(request(),{...registration,...patch});assert.ok(h.closed.includes(token));
  }
  assert.equal(h.calls.length,0);assert.deepEqual(h.messages,[]);
});
test('native pause winning the RN race retains intent and does not lose an event to deduplication',t=> {
  const h=harness(t),token=h.admit();h.setForeground(false);h.frame();assert.equal(h.calls[0]!.stopped,1);assert.ok(h.native.isActive(token));assert.deepEqual(h.messages,[]);
  h.setForeground(true);h.manager.setForeground(true);assert.equal(h.calls.length,2);h.frame(1);assert.equal(h.messages.length,1);h.frame();assert.equal(h.messages.length,1);
});
test('native revocation stops live socket intent even when no frame or identity callback reaches RN',async t=> {
  const h=harness(t),token=h.admit();h.rows.get(token)!.active=false;
  await new Promise(resolve=>setTimeout(resolve,40));assert.equal(h.calls[0]!.stopped,1);h.frame();assert.deepEqual(h.messages,[]);
  h.manager.setForeground(false);h.manager.setForeground(true);assert.equal(h.calls.length,1);
});
test('owner revocation while suspended denies reconnect and old-generation delivery',t=> {
  const h=harness(t);h.admit();h.manager.setForeground(false);h.setOwner(false);h.manager.setForeground(true);assert.equal(h.calls.length,1);h.frame();assert.deepEqual(h.messages,[]);
});
test('ordinary native close shares the immutable owner and cannot enter storage or expose a public acknowledgement',async t=> {
  const h=harness(t),db=await setup(t),ordinary=new NativeLeases();h.admit();
  const broker=createCapabilityBroker(db.database,ordinary,h.owner,undefined,input=>h.broker.close(input));t.after(()=>broker.revoke());
  const token=ordinary.add(registration,{type:'relay.close',id:'original-close',subId:'caller'});await broker.dispatch(token);
  assert.equal(h.calls[0]!.stopped,1);assert.equal(ordinary.results.get(token),null);
  assert.equal(db.sqlite.raw().prepare('SELECT count(*) AS count FROM saved_strings').get()!.count,0);h.frame();assert.deepEqual(h.messages,[]);
});
test('explicit close while suspended removes reconnect intent before native cancellation',t=> {
  const h=harness(t),token=h.admit();h.manager.setForeground(false);h.broker.close({type:'relay.close',id:'close-original',subId:'caller'});
  assert.ok(h.closed.includes(token));h.manager.setForeground(true);assert.equal(h.calls.length,1);h.frame();assert.deepEqual(h.messages,[]);
});
test('duplicate caller admission and denied native acceptance are closed without replacing the existing native recipient',t=> {
  const h=harness(t);const first=h.admit(),second=h.admit();assert.ok(h.closed.includes(second));assert.ok(h.native.isActive(first));assert.equal(h.calls.length,1);
  h.setForeground(false);const denied=h.admit(request('new'));assert.ok(h.closed.includes(denied));assert.equal(h.calls.length,1);
});
