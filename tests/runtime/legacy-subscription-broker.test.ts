import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {finalizeEvent} from 'nostr-tools/pure';
import {createLegacySubscriptionBroker} from '../../src/runtime/legacy-subscription-broker.ts';
import type {NativeRelaySubscriptionPort} from '../../src/runtime/relay-subscription-broker.ts';
import {createRelaySubscriptions,type NativeRelayStreamPort} from '../../src/network/relay-subscriptions.ts';
import type {NativeRegistration} from '../../src/runtime/capability-protocol.ts';
import {NativeLeases} from './native-leases.ts';
const registration:NativeRegistration={sessionId:'legacy',generation:'native-one',epoch:1,user:'1'.repeat(64),publisher:'c2f1ab4e6a577dd8980b57e15986ed92830b95a94f374192235563532b5cac20',appId:'recipe-cards',version:'92d5639e1da2a0b9ac6bbb9d41d67b0026c15ed614e2d553f8ad2e4e4e896ecc',instanceId:'instance',fixture:'published',domains:[],legacyReadOnly:{profile:'legacy-read-only-v1',consent:true,eventId:'b70911af4382baded327ce6af4b595197ff7a4781e3704b9f066a74f68b48a07',htmlHash:'9067048a9ce80d7e79ea76b960acc88aa53645754ec4e7549de1c1525a690194',relays:['wss://relay.example.org']}};
const request=(subId='caller')=>({type:'legacy.subscribe',relay:'wss://relay.example.org',id:'request-'+subId,subId,filters:[{kinds:[1],limit:2}]});
const secret=new Uint8Array(32);secret[31]=1;
function harness(t:TestContext) {
 let next=0,ownerActive=true,foreground=true;
 const rows=new Map<string,{raw:string;claimed:boolean;accepted:boolean;active:boolean}>(),messages:unknown[]=[],closed:string[]=[];
 const native:NativeRelaySubscriptionPort={take(token){const r=rows.get(token);if(!r||r.claimed)return null;r.claimed=true;return r.raw;},
  accept(token){const r=rows.get(token);if(!r||!r.claimed||r.accepted||!r.active||!foreground)return false;r.accepted=true;return true;},
  isActive:token=>rows.get(token)?.accepted===true&&rows.get(token)?.active===true,
  mayDeliver:token=>foreground&&native.isActive(token),send(token,response){if(!native.isActive(token))return false;if(!foreground)return 'paused';messages.push(JSON.parse(response));return true;},
  close(token){closed.push(token);const r=rows.get(token);if(r)r.active=false;}};
 const calls:{sub:string;token:string|undefined;frame:(text:string)=>void;stopped:number}[]=[];
 const port:NativeRelayStreamPort={newInstanceId:()=>`00000000-0000-4000-8000-${String(++next).padStart(12,'0')}`,open(_id,_url,_request,sub,frame,_failed,token){const c={sub,frame,token,stopped:0};calls.push(c);return()=>c.stopped++;}};
 const manager=createRelaySubscriptions(port,()=>['wss://relay.example.org']),capability=new NativeLeases();
 const owner={registration,assertActive(){if(!ownerActive)throw new Error('Owner revoked');}};
 const broker=createLegacySubscriptionBroker(native,capability,manager,owner);t.after(()=>{broker.revoke();manager.revokeAll();});
 const admit=(input:unknown=request(),captured=registration)=>{const token='token-'+(++next);rows.set(token,{raw:JSON.stringify({registration:captured,request:JSON.stringify(input)}),claimed:false,accepted:false,active:true});broker.dispatch(token);return token;};
 const frame=()=>{const c=calls[0]!;c.frame(JSON.stringify(['EVENT',c.sub,finalizeEvent({kind:1,created_at:100,content:'verified',tags:[]},secret)]));};
 return {admit,broker,manager,native,capability,rows,calls,closed,messages,owner,frame,setOwner:(active:boolean)=>{ownerActive=active;}};
}
test('legacy zero-domain source reads through exact native token without generic Relay authority',t=>{
 const h=harness(t),token=h.admit();assert.equal(h.calls[0]!.token,token);h.frame();assert.equal((h.messages[0] as any).subId,'caller');assert.throws(()=>h.manager.session(h.owner));assert.deepEqual(h.owner.registration.domains,[]);
});
test('foreign pin, identity, epoch, generation, grants and consent cannot acquire read effects',t=>{
 const h=harness(t);for(const patch of [{user:'4'.repeat(64)},{generation:'native-two'},{epoch:2},{version:'5'.repeat(64)},{domains:['relay']},{legacyReadOnly:{...registration.legacyReadOnly!,consent:false}},{legacyReadOnly:undefined}]){const token=h.admit(request(),{...registration,...patch} as NativeRegistration);assert.ok(h.closed.includes(token));}assert.equal(h.calls.length,0);
});
test('generic subscribe, EVENT, AUTH, publish, upload and unconfigured peers cannot enter legacy read lane',t=>{
 const h=harness(t);for(const patch of [{type:'relay.subscribe'},{type:'EVENT'},{type:'AUTH'},{type:'relay.publish'},{type:'upload.prepare'},{relay:'wss://foreign.example.org'}])h.admit({...request(),...patch});assert.equal(h.calls.length,0);
});
test('legacy close binds native owner and operation before changing stream intent',t=>{
 const h=harness(t);h.admit();for(const [captured,type] of [[{...registration,user:'4'.repeat(64)},'legacy.close'],[registration,'relay.close'],[registration,'relay.publish']] as const){const token=h.capability.add(captured,{type,id:'close',subId:'caller'});h.broker.dispatchClose(token);assert.equal(h.calls[0]!.stopped,0);}
 const close=h.capability.add(registration,{type:'legacy.close',id:'close',subId:'caller'});h.broker.dispatchClose(close);assert.equal(h.calls[0]!.stopped,1);assert.equal(h.capability.results.get(close),null);h.frame();assert.deepEqual(h.messages,[]);
});
test('native token revocation blocks background reconnect and late delivery',t=>{
 const h=harness(t),token=h.admit();h.manager.setForeground(false);h.rows.get(token)!.active=false;h.manager.setForeground(true);assert.equal(h.calls.length,1);h.frame();assert.deepEqual(h.messages,[]);
});
test('legacy native tokens retain three-stream limit and reject duplicate caller IDs',t=>{
 const h=harness(t);for(const id of ['one','two','three','four','one'])h.admit(request(id));assert.equal(h.calls.length,3);assert.deepEqual(h.owner.registration.domains,[]);
});
