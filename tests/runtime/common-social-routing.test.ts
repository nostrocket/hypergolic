import test from 'node:test';
import assert from 'node:assert/strict';
import {finalizeEvent,getPublicKey} from 'nostr-tools/pure';
import {npubEncode} from 'nostr-tools/nip19';
import {createNativeCommonSocialPlanner} from '../../src/common/native-social-plan.ts';
import {parseOutboxRelayList} from '../../src/outbox/relay-list.ts';
import {captureEventSnapshot} from '../../src/security/event-snapshot.ts';
const key=new Uint8Array(32).fill(4),user=getPublicKey(key);
const signed=(kind:number,tags:string[][])=>JSON.parse(JSON.stringify(finalizeEvent({kind,created_at:1,content:'',tags},key)));
const own=signed(10002,[['r','wss://own.example.org','write']]),basis=signed(3,[]);
for(const grants of [['relay'],['outbox'],['relay','outbox']])test('Common social selected read/publication routes: '+grants.join('+'),async()=>{
  const readHosts:string[]=[],publicationKinds:number[]=[],purposes:string[]=[];let next=0;
  const native={newInstanceId:()=>`00000000-0000-4000-8000-${String(++next).padStart(12,'0')}`,
    async queryPublishedRelay(_id:string,url:string,_wire:string,sub:string){readHosts.push(new URL(url).hostname);return [JSON.stringify(['EVENT',sub,basis]),JSON.stringify(['EOSE',sub])];},cancelPublishedRelay(){},revokeAllPublishedRelay(){}};
  const planner=createNativeCommonSocialPlanner(native,{async resolve(_user,_author,purpose){purposes.push(purpose);return {list:parseOutboxRelayList(own,user),source:'nip65',incomplete:false};}},()=>({networkRelays:['wss://network.example.org'],lookupRelays:['wss://lookup.example.org']}),
    {async plan(input:unknown){const value=input as {id:string;event:{kind:number}};publicationKinds.push(value.event.kind);const event=captureEventSnapshot(value.event,user,['wss://own.example.org']);return {requestId:value.id,event,destinations:[{relay:event.destinations[0]!,sources:[{kind:'own',author:user}]}],requiredInboxes:[],ownSource:'nip65',ancillary:own};}},async()=>true);
  const registration={sessionId:'session',generation:'generation',epoch:1,user,publisher:'2'.repeat(64),appId:'common',version:'3'.repeat(64),instanceId:'instance',fixture:'published',domains:['common','identity',...grants],commonProfile:'social-v1' as const};
  const plan=await planner.plan({type:'common.follow',id:'intent',pubkeys:[npubEncode('5'.repeat(64))]},registration,new AbortController().signal,()=>{});
  const outbox=grants.includes('outbox');assert.deepEqual(readHosts,[outbox?'own.example.org':'network.example.org']);assert.deepEqual(publicationKinds,outbox?[3]:[]);assert.deepEqual(purposes,outbox?['read']:[]);
  assert.equal(plan.route,outbox?'outbox':'relay');assert.equal(new URL(plan.publication!.event.destinations[0]!).hostname,outbox?'own.example.org':'network.example.org');assert.equal(plan.publication!.ancillary,null);assert.deepEqual(registration.domains,['common','identity',...grants]);planner.release(plan);
});
