import test from 'node:test';
import assert from 'node:assert/strict';
import {createNotificationSettings} from '../../src/presentation/notify-settings.ts';
import type {RoutingNativeState} from '../../src/routing/routing-port.ts';
import type {TrustedApp, TrustedUser} from '../../src/storage/ports.ts';
import {setup} from './harness.ts';
test('trusted Settings revokes only saved exact channel for the captured identity',async t=>{
 const h=await setup(t);await h.allow();await h.dispatch(h.source,{type:'notify.channel.register',channelId:'messages',label:'Messages'}).promise;await h.allow('messages');
 const identity={sessionAuthority:()=>({user:h.source.user,epoch:0,assertActive(){}})},settings=createNotificationSettings(identity,h.native,h.broker);
 const rows=await settings.list();assert.equal(rows.length,2);await assert.rejects(settings.revoke({...rows[0]!,appId:'unsaved'}));
 assert.deepEqual(await settings.revoke(rows.find(row=>row.channel==='messages')!),[{publisher:h.source.publisher,appId:h.source.appId,channel:''}]);
 const send=h.dispatch(h.source,{type:'notify.send',id:'revoked-channel',title:'No',channel:'messages'});await send.promise;assert.equal(send.reply().error,'permission denied');
 const general=h.dispatch(h.source,{type:'notify.send',id:'general',title:'Still allowed'});await general.promise;assert.ok(general.reply().notificationId);
});
test('background, identity, native revision and cancellation fence delayed Settings completions',async()=>{
 for(const mode of ['background','identity','revision','abort']) {
  let state:RoutingNativeState={user:'01'.repeat(32),epoch:0,revision:1,available:true,ownerAvailable:true,foreground:true},release=()=>{},revokes=0;
  const gate=new Promise<void>(resolve=>{release=resolve;}),signal=new AbortController(),row={publisher:'02'.repeat(32),appId:'saved-source',channel:'messages'};
  const identity={sessionAuthority:()=>({user:'01'.repeat(32),epoch:0,assertActive(){}})};
  const broker={async listPermissions(owner:TrustedUser){await gate;owner.assertActive();return [row];},async revoke(owner:TrustedApp){owner.assertActive();revokes++;}};
  const native={state:()=>state,mayDeliver:()=>false,reviewRevision: () => 1, mayReview:()=>false,send:()=>false,subscribe:()=>()=>{},newChannelId:()=>''};
  const service=createNotificationSettings(identity,native,broker),pending=service.revoke(row,{signal:signal.signal});
  if(mode==='background')state={...state,foreground:false,available:false};else if(mode==='identity')state={...state,user:'03'.repeat(32),epoch:1};else if(mode==='revision')state={...state,revision:2};else signal.abort();
  release();await assert.rejects(pending,(error:any)=>error.code==='REVOKED');assert.equal(revokes,0);
 }
});
