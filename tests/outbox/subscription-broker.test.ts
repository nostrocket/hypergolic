import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {finalizeEvent} from 'nostr-tools/pure';
import {createOutboxSubscriptionBroker} from '../../src/outbox/subscription-broker.ts';
import {createOutboxSubscriptions} from '../../src/outbox/subscriptions.ts';
import type {NativeRelayStreamPort} from '../../src/network/relay-subscriptions.ts';
import type {NativeRelaySubscriptionPort} from '../../src/runtime/relay-subscription-broker.ts';
import type {NativeRegistration} from '../../src/runtime/capability-protocol.ts';
const registration:NativeRegistration={sessionId:'outbox',generation:'native-outbox',epoch:1,user:'1'.repeat(64),publisher:'2'.repeat(64),appId:'feed-lab',version:'3'.repeat(64),instanceId:'instance',fixture:'feed-lab',domains:['outbox','relay']};
const request=(subId='live')=>({type:'outbox.subscribe',id:'request-'+subId,subId,filters:{kinds:[1],limit:8},options:{limit:32,timeoutMs:1000}});
const flush=(ms=10)=>new Promise(resolve=>setTimeout(resolve,ms));
function harness(t:TestContext) {
  let next=0,capacity=true,ownerActive=true,foreground=true,lookups=0;
  const rows=new Map<string,{raw:string;claimed:boolean;accepted:boolean;active:boolean}>(),closed:string[]=[],messages:any[]=[],calls:{sub:string;token?:string;frame:(text:string)=>void;stopped:number}[]=[];
  const native:NativeRelaySubscriptionPort={take(token){const row=rows.get(token);if(!row||row.claimed)return null;row.claimed=true;return row.raw;},accept(token){const row=rows.get(token);if(!row||!row.claimed||row.accepted||!row.active||!foreground)return false;row.accepted=true;return true;},isActive:token=>rows.get(token)?.accepted===true&&rows.get(token)?.active===true,mayDeliver:token=>foreground&&native.isActive(token),canSend:()=>capacity,send(token,response){assert.ok(capacity);if(!native.isActive(token))return false;if(!foreground)return 'paused';messages.push(JSON.parse(response));return true;},close(token){closed.push(token);const row=rows.get(token);if(row)row.active=false;}};
  const port:NativeRelayStreamPort={newInstanceId:()=>`00000000-0000-4000-8000-${String(++next).padStart(12,'0')}`,open(_id,_url,_wire,sub,frame,_fail,token){const call={sub,frame,token,stopped:0};calls.push(call);return()=>{call.stopped++;};}};
  const manager=createOutboxSubscriptions(port,{async query(){throw Error('wrong method');},async plan(_input,_user,_signal,active){active();lookups++;return {relays:['wss://one.nostr.net'],source:'cache',missingAuthors:[],incomplete:false};}});
  const broker=createOutboxSubscriptionBroker(native,manager,{registration,assertActive(){if(!ownerActive)throw Error('owner changed');}});t.after(()=>{broker.revoke();manager.revokeAll();});
  const admit=(input:unknown=request(),captured=registration)=>{const token='token-'+(++next);rows.set(token,{raw:JSON.stringify({registration:captured,request:JSON.stringify(input)}),claimed:false,accepted:false,active:true});broker.dispatch(token);return token;};
  const key=new Uint8Array(32);key[31]=3;
  const event=(content:string)=>calls[0]!.frame(JSON.stringify(['EVENT',calls[0]!.sub,JSON.parse(JSON.stringify(finalizeEvent({kind:1,created_at:1,content,tags:[]},key)))]));
  const eose=()=>calls[0]!.frame(JSON.stringify(['EOSE',calls[0]!.sub]));
  return {broker,manager,native,rows,calls,messages,closed,admit,event,eose,lookups:()=>lookups,setCapacity(value:boolean){capacity=value;},setOwner(value:boolean){ownerActive=value;},setForeground(value:boolean){foreground=value;}};
}
test('Outbox one-use native capture requires exact identity, namespace and both grants before metadata or WSS',async t=> {
  const h=harness(t);
  for(const patch of [{user:'4'.repeat(64)},{epoch:2},{generation:'other'},{version:'5'.repeat(64)},{domains:['outbox']},{domains:['relay']}])h.admit(request(),{...registration,...patch});
  await flush();assert.equal(h.lookups(),0);assert.equal(h.calls.length,0);
  const token=h.admit();await flush();assert.equal(h.calls[0]?.token,token);h.broker.dispatch(token);await flush();assert.equal(h.calls.length,1);
});
test('native revocation winning before metadata dispatch prevents discovery without waiting for the watcher',async t=> {
  const h=harness(t),token=h.admit();h.rows.get(token)!.active=false;await flush();assert.equal(h.lookups(),0);assert.equal(h.calls.length,0);
});
test('bounded delivery queue waits for native renderer capacity and preserves event order with private completion',async t=> {
  const h=harness(t);h.admit();await flush();h.setCapacity(false);h.event('one');h.event('two');h.eose();assert.equal(h.messages.length,0);
  h.setCapacity(true);await flush(35);assert.deepEqual(h.messages.map(m=>m.type),['outbox.event','outbox.event','relay.eose']);assert.deepEqual(h.messages.slice(0,2).map(m=>m.result.event.content),['one','two']);
});
test('delivery overflow terminates explicitly after acknowledgements recover rather than growing or losing native authority',async t=> {
  const h=harness(t);h.admit();await flush();h.setCapacity(false);h.eose();for(let i=0;i<33;i++)h.event('live-'+i);
  assert.equal(h.calls[0]!.stopped,1);assert.equal(h.messages.length,0);h.setCapacity(true);await flush(35);
  assert.deepEqual(h.messages,[{type:'outbox.closed',subId:'live',reason:'outbox delivery limit'}]);
});
test('close and owner changes erase queued events and prohibit future reconnect',async t=> {
  for(const mode of ['close','owner']) {
    const h=harness(t);h.admit();await flush();h.setCapacity(false);h.event('pending');
    if(mode==='close')h.broker.close({type:'outbox.close',id:'original-close',subId:'live'});else h.setOwner(false);
    await flush(35);h.setCapacity(true);await flush(35);assert.equal(h.messages.length,0);assert.equal(h.calls[0]!.stopped,1);
    h.manager.setForeground(false);h.manager.setForeground(true);await flush();assert.equal(h.calls.length,1);
  }
});
