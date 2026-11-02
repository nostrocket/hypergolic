import assert from 'node:assert/strict';
import test from 'node:test';
import {finalizeEvent,getPublicKey,type NostrEvent} from 'nostr-tools/pure';
import {openIdentityCache} from '../../src/identity/identity-cache.ts';
import {openIdentityListAccess} from '../../src/identity/identity-permissions.ts';
import {createIdentityDataService} from '../../src/identity/identity-service.ts';
import {IDENTITY_LIMITS} from '../../src/identity/identity-contract.ts';
import {queryMatches,RelayQueryError} from '../../src/network/relay-query-contract.ts';
import {DiskSQLite,deferred,hex} from '../storage/harness.ts';
import type {NativeRegistration} from '../../src/runtime/capability-protocol.ts';
const secret=new Uint8Array(32);secret[31]=1;
const user=getPublicKey(secret);
const registration:NativeRegistration={user,publisher:hex(2),appId:'signed-app',version:hex(3),instanceId:'one',sessionId:'one',generation:'generation',epoch:0,fixture:'published',domains:['identity']};
const signal=()=>new AbortController().signal;
const active=()=>{};
function signed(kind:number,tags:string[][],created_at=10):NostrEvent{return JSON.parse(JSON.stringify(finalizeEvent({kind,tags,created_at,content:'encrypted payload is never exposed'},secret))) as NostrEvent;}
async function setup(t:{after(fn:()=>void):void}){
 const sqlite=new DiskSQLite();t.after(()=>sqlite.cleanup());const cache=await openIdentityCache(sqlite,'android');
 const access=await openIdentityListAccess(sqlite,'android',{replace(){}},()=>user);return {sqlite,cache,access};
}
async function reviewed(access:Awaited<ReturnType<typeof openIdentityListAccess>>,allow:boolean){
 for(let n=0;n<100&&!access.getSnapshot().review;n++)await new Promise(resolve=>setImmediate(resolve));
 assert.ok(access.getSnapshot().review,'trusted review must precede sensitive access');await access.decide(access.getSnapshot().review!.id,allow);
}
test('fresh cached public mutes require separate approval; denial cannot query or expose stored tags',async t=>{
 const {cache,access}=await setup(t);await cache.write(user,'mutes',{fetchedAt:1000,events:[signed(10000,[['p',hex(9)]])]},active,signal());
 let queries=0;const service=createIdentityDataService(cache,{async query(){queries++;return [];}},()=>1001,access);
 const read=service.read({type:'identity.getMutes',id:'denied'},registration,signal(),active);await reviewed(access,false);
 assert.deepEqual(await read,{type:'identity.getMutes.result',id:'denied',pubkeys:[],error:'public list access denied'});assert.equal(queries,0);
 const allowed=service.read({type:'identity.getMutes',id:'approved'},registration,signal(),active);await reviewed(access,true);
 assert.deepEqual(await allowed,{type:'identity.getMutes.result',id:'approved',pubkeys:[hex(9)]});assert.equal(queries,0);
 const unavailable=createIdentityDataService(cache,{async query(){throw Error('must not query');}},()=>1001);
 assert.match(String((await unavailable.read({type:'identity.getMutes',id:'no-permission-port'},registration,signal(),active)).error),/requires approval/);
});
test('cold offline categorized cache stays bound to remembered permission and Settings revocation blocks its next read',async t=>{
 const {sqlite,cache,access}=await setup(t);await cache.write(user,'bookmarks',{fetchedAt:1,events:[signed(10003,[['e',hex(9)]])]},active,signal());
 const initial=access.authorize(registration,signal(),active);await reviewed(access,true);(await initial)();await access.close();await cache.close();
 const reopened=await openIdentityCache(sqlite,'android'),permission=await openIdentityListAccess(sqlite,'android',{replace(){}},()=>user);
 const offline=createIdentityDataService(reopened,{async query(){throw new RelayQueryError();}},()=>IDENTITY_LIMITS.freshMs+2,permission);
 const request={type:'identity.getList',id:'cold',listType:'bookmarks'} as const;
 assert.deepEqual(await offline.read(request,registration,signal(),active),{type:'identity.getList.result',id:'cold',entries:[hex(9)]});
 await permission.revoke(permission.getSnapshot().grants[0]!);const read=offline.read({...request,id:'revoked'},registration,signal(),active);await reviewed(permission,false);
 assert.deepEqual((await read).entries,[]);assert.equal((await read).error,'public list access denied');
});
test('permission revocation aborts a pending relay read and reapproval cannot release its late signed data',async t=>{
 const {cache,access}=await setup(t);const approval=access.authorize(registration,signal(),active);await reviewed(access,true);(await approval)();
 const held=deferred();let started=false,cancelled=false;
 const service=createIdentityDataService(cache,{async query(_filters,querySignal){started=true;querySignal?.addEventListener('abort',()=>{cancelled=true;},{once:true});await held.promise;return [{event:signed(10000,[['p',hex(9)]])}];}},()=>1000,access);
 const read=service.read({type:'identity.getMutes',id:'late'},registration,signal(),active);
 while(!started)await new Promise(resolve=>setImmediate(resolve));
 await access.revoke(access.getSnapshot().grants[0]!);assert.equal(cancelled,true);
 const result=await read;assert.deepEqual(result.pubkeys,[]);assert.ok(result.error);
 const again=access.authorize(registration,signal(),active);await reviewed(access,true);(await again)();held.resolve();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(await cache.read(user,'mutes',active,signal()),null);
});
test('accepted badge bundle cold-reopens, falls back only on availability failure, refreshes signed definitions and clears on signed empty acceptance',async t=>{
 const {sqlite,cache}=await setup(t);let now=1,offline=false;
 const address='30009:'+user+':one';const award=signed(8,[['a',address],['p',user]]),root=signed(10008,[['a',address],['e',award.id]]);
 let definition=signed(30009,[['d','one'],['name','First']]),source=[root,award,definition];
 const queries={async query(filters:Parameters<typeof queryMatches>[1][]|readonly Parameters<typeof queryMatches>[1][]){if(offline)throw new RelayQueryError();return source.filter(event=>filters.some(filter=>queryMatches(event,filter))).map(event=>({event}));}};
 const first=createIdentityDataService(cache,queries,()=>now);const request={type:'identity.getBadges',id:'badges'} as const;
 assert.deepEqual((await first.read(request,registration,signal(),active)).badges,[{id:definition.id,awardedBy:user,name:'First'}]);await cache.close();
 const cold=await openIdentityCache(sqlite,'android');now+=IDENTITY_LIMITS.freshMs;offline=true;
 const service=createIdentityDataService(cold,queries,()=>now);assert.equal((await service.read(request,registration,signal(),active)).error,undefined);
 offline=false;definition=signed(30009,[['d','one'],['name','Updated']],20);source=[root,award,definition];
 assert.deepEqual((await service.read(request,registration,signal(),active)).badges,[{id:definition.id,awardedBy:user,name:'Updated'}]);
 now+=IDENTITY_LIMITS.freshMs;source=[signed(10008,[],30),award,definition];assert.deepEqual((await service.read(request,registration,signal(),active)).badges,[]);
});
test('fresh partial accepted badge evidence is explicit error and cannot silently replace a valid offline bundle',async t=>{
 const {cache}=await setup(t);const address='30009:'+user+':one',award=signed(8,[['a',address],['p',user]]),definition=signed(30009,[['d','one']]);
 await cache.write(user,'badges',{fetchedAt:1,events:[signed(10008,[['a',address],['e',award.id]]),award,definition]},active,signal());
 const partial=signed(10008,[['a',address]],20);const service=createIdentityDataService(cache,{async query(){return [{event:partial}];}},()=>IDENTITY_LIMITS.freshMs+2);
 const result=await service.read({type:'identity.getBadges',id:'partial'},registration,signal(),active);assert.deepEqual(result.badges,[]);assert.equal(result.error,'incomplete accepted badge pair');
 assert.equal((await cache.read(user,'badges',active,signal()))!.events[0]!.created_at,10);
});
test('invalid native relay frames are not mistaken for availability failure when an older signed cache exists',async t=>{
 const {cache}=await setup(t);const {createNativeRelayQuery}=await import('../../src/network/native-relay-query.ts');
 const value=signed(3,[['p',hex(9)]]);await cache.write(user,'follows',{fetchedAt:1,events:[value]},active,signal());
 const queries=createNativeRelayQuery({newInstanceId:()=> '12345678-1234-4123-8123-123456789abc',cancelPublishedRelay(){},async queryPublishedRelay(_id,_url,_wire,subscription){return [JSON.stringify(['EVENT',subscription,{...value,sig:'0'.repeat(128)}]),JSON.stringify(['EOSE',subscription])];}},()=>['wss://relay.example.org']);
 const service=createIdentityDataService(cache,queries,()=>IDENTITY_LIMITS.freshMs+2);
 const result=await service.read({type:'identity.getFollows',id:'invalid-native'},registration,signal(),active);assert.deepEqual(result.pubkeys,[]);assert.equal(result.error,'identity data unavailable');
 assert.equal((await cache.read(user,'follows',active,signal()))!.events[0]!.id,value.id);
});
