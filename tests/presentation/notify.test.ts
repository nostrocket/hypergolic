import test from 'node:test';
import assert from 'node:assert/strict';
import {parseNotifyMessage, captureNotifyPush, captureNotifyReply, captureNotifyRejection} from '../../src/presentation/notify-contract.ts';
import {openNotifyPermissions} from '../../src/presentation/notify-permissions.ts';
import {setup, tick} from './harness.ts';
test('notify parser captures immutable data and rejects foreign authority, accessors, duplicate actions and oversize', () => {
 const input = {type: 'notify.send', id: 'n1', title: '<script>untrusted title</script>', actions: [{id: 'reply', label: 'Reply'}]}, parsed = parseNotifyMessage(input); input.actions[0]!.id = 'changed'; assert.equal((parsed as typeof input).actions[0]!.id, 'reply');
 for (const patch of [{sender:'forged'}, {publisher:'forged'}, {generation:'forged'}, {actions:[{id:'a',label:'A'},{id:'a',label:'B'}]}, {body:'x'.repeat(4097)}, {priority:'system'}]) assert.throws(() => parseNotifyMessage({...input,...patch}));
 assert.throws(() => parseNotifyMessage({type:'notify.send',id:'n1',get title(){throw Error('Getter must not run');}}));
});
test('results and pushes require exact correlation, shape and implemented controls', () => {
 const request=parseNotifyMessage({type:'notify.send',id:'a',title:'A'});assert.deepEqual(captureNotifyReply({type:'notify.send.result',id:'a',notificationId:'n'},request),{type:'notify.send.result',id:'a',notificationId:'n'});
 for(const row of [{type:'notify.send.result',id:'b',notificationId:'n'},{type:'notify.send.result',id:'a',notificationId:'n',error:'failure'},{type:'notify.send.result',id:'a'}])assert.throws(()=>captureNotifyReply(row,request));
 assert.throws(()=>captureNotifyPush({type:'notify.controls',controls:['system']}));assert.throws(()=>captureNotifyPush({type:'notify.action',notificationId:'n',actionId:'a',sender:'forged'}));
});
test('notification needs focused trusted permission and original correlated result', async t=>{
 const h=await setup(t);const denied=h.dispatch(h.source,{type:'notify.send',id:'denied',title:'Title'});await denied.promise;assert.equal(denied.reply().error,'permission denied');assert.equal(h.broker.getSnapshot().cards.length,0);
 await h.allow();const sent=h.dispatch(h.source,{type:'notify.send',id:'sent',title:'Title',body:'Body',actions:[{id:'reply',label:'Reply'}]});await sent.promise;
 assert.equal(sent.reply().notificationId,h.broker.getSnapshot().cards[0]!.id);assert.equal(h.broker.getSnapshot().cards[0]!.origin.publisher,h.source.publisher);
 h.broker.interact(sent.reply().notificationId,'reply');assert.equal(h.sent[0]!.message.type,'notify.action');assert.equal(h.sent[0]!.generation,h.source.generation);assert.equal(h.broker.getSnapshot().cards.length,0);
});
test('general allowance never grants future or existing named channels', async t=>{
 const h=await setup(t);await h.allow();await h.dispatch(h.source,{type:'notify.channel.register',channelId:'messages',label:'Messages'}).promise;
 const denied=h.dispatch(h.source,{type:'notify.send',id:'m',title:'Message',channel:'messages'});await denied.promise;assert.equal(denied.reply().error,'permission denied');
 await h.allow('messages');const sent=h.dispatch(h.source,{type:'notify.send',id:'ok',title:'Message',channel:'messages'});await sent.promise;assert.ok(sent.reply().notificationId);
 const missing=h.dispatch(h.source,{type:'notify.permission.request',id:'unknown',channel:'future'});await missing.promise;assert.equal(missing.reply().granted,false);
});
test('reopened permission persists on disk and remains publisher/app/identity isolated', async t=>{
 const h=await setup(t);await h.allow();const reopened=await openNotifyPermissions(h.sqlite,'ios');const owner={...h.source,assertActive(){}};
 assert.equal(await reopened.has(owner,''),true);for(const patch of [{user:'04'.repeat(32)},{publisher:'05'.repeat(32)},{appId:'other'}])assert.equal(await reopened.has({...owner,...patch},''),false);await reopened.close();
});
test('nonfocused source cannot approve; foreground switching keeps live cards and source callbacks', async t=>{
 const h=await setup(t);h.focus(h.peer.generation);const pending=h.dispatch(h.source,{type:'notify.permission.request',id:'p'});await tick();assert.equal(h.broker.getSnapshot().review,null);h.focus(h.source.generation);const review=await h.review();h.broker.decide(review.id,true);await pending.promise;
 const sent=h.dispatch(h.source,{type:'notify.send',id:'n',title:'Visible'});await sent.promise;h.focus(h.peer.generation);assert.equal(h.broker.getSnapshot().cards.length,1);h.broker.interact(sent.reply().notificationId);assert.equal(h.sent[0]!.message.type,'notify.clicked');assert.equal(h.sent[0]!.generation,h.source.generation);
});
test('unknown/foreign IDs and unknown action cannot affect another source', async t=>{
 const h=await setup(t);await h.allow();const sent=h.dispatch(h.source,{type:'notify.send',id:'n',title:'Own',actions:[{id:'a',label:'A'}]});await sent.promise;
 await h.dispatch(h.peer,{type:'notify.dismiss',notificationId:sent.reply().notificationId}).promise;h.broker.interact(sent.reply().notificationId,'foreign');h.broker.dismiss('unknown');assert.equal(h.broker.getSnapshot().cards.length,1);assert.equal(h.sent.length,0);
 h.broker.dismiss(sent.reply().notificationId);assert.deepEqual(h.sent[0]!.message,{type:'notify.dismissed',notificationId:sent.reply().notificationId,reason:'user'});
});
test('background clears cards/badges and pending reviews; return has no backlog', async t=>{
 const h=await setup(t);await h.allow();await h.dispatch(h.source,{type:'notify.send',id:'n',title:'Transient'}).promise;await h.dispatch(h.source,{type:'notify.badge',count:3}).promise;
 h.lifecycle({available:false,foreground:false});assert.equal(h.broker.getSnapshot().cards.length,0);assert.deepEqual(h.broker.getSnapshot().badges,{});h.lifecycle({available:true,foreground:true});assert.equal(h.broker.getSnapshot().cards.length,0);assert.equal(h.sent.length,0);
 const remembered=h.dispatch(h.source,{type:'notify.permission.request',id:'again'});await remembered.promise;assert.equal(remembered.reply().granted,true);assert.equal(h.broker.getSnapshot().review,null);
});
test('identity change and close revoke pending authority and leave no action recipient', async t=>{
 const h=await setup(t);const pending=h.dispatch(h.source,{type:'notify.permission.request',id:'p'});const review=await h.review();h.lifecycle({user:'08'.repeat(32),epoch:1});h.broker.decide(review.id,true);await pending.promise;assert.equal(pending.reply(),undefined);
});
test('lease expiry and close reject a later UI approval without a persisted grant', async t=>{
 for(const mode of ['expire','close']){const h=await setup(t),pending=h.dispatch(h.source,{type:'notify.permission.request',id:'p'}),review=await h.review();if(mode==='expire')h.expire(pending.token);else h.broker.close(h.source.generation);h.broker.decide(review.id,true);await pending.promise;assert.equal(pending.reply(),undefined);assert.equal(await h.permissions.has({...h.source,assertActive(){}},''),false);}
});
test('flood is bounded and urgent never changes permission, capacity or lifetime', async t=>{
 const h=await setup(t);await h.allow();for(let i=0;i<12;i++){const sent=h.dispatch(h.source,{type:'notify.send',id:'n'+i,title:'Urgent',priority:'urgent'});await sent.promise;if(i<8)assert.ok(sent.reply().notificationId);else assert.equal(sent.reply().error,'rate limited');}
 assert.equal(h.broker.getSnapshot().cards.length,8);h.advance(300_000);assert.equal(h.broker.getSnapshot().cards.length,0);assert.equal(h.sent.filter(row=>row.message.type==='notify.dismissed').length,8);
});
test('Settings revoke fences reviews, clears cards/badges and requires fresh exact review', async t=>{
 const h=await setup(t);await h.allow();await h.dispatch(h.source,{type:'notify.send',id:'n',title:'Old'}).promise;await h.broker.revoke({...h.source,assertActive(){}},'');assert.equal(h.broker.getSnapshot().cards.length,0);
 const denied=h.dispatch(h.source,{type:'notify.send',id:'deny',title:'No'});await denied.promise;assert.equal(denied.reply().error,'permission denied');await h.allow();
});
test('forged registration, missing domain and replayed native correlation cannot create effects', async t=>{
 const h=await setup(t);await h.allow();for(const patch of [{publisher:'04'.repeat(32)},{domains:[]}]){const request=h.dispatch(h.source,{type:'notify.send',id:'forged',title:'No'},patch);await request.promise;assert.equal(request.reply(),undefined);}
 const first=h.dispatch(h.source,{type:'notify.send',id:'one',title:'First'},{},'same');await first.promise;const second=h.dispatch(h.source,{type:'notify.send',id:'two',title:'Second'},{},'same');await second.promise;assert.equal(second.reply(),undefined);assert.equal(h.broker.getSnapshot().cards.length,1);
});

test('badge attribution and toast clock come from captured source; expiry clears toast without clearing centre',async t=>{
 const h=await setup(t);await h.allow();await h.dispatch(h.source,{type:'notify.badge',count:3}).promise;await h.dispatch(h.source,{type:'notify.send',id:'toast',title:'Transient toast'}).promise;
 const snapshot=h.broker.getSnapshot();assert.deepEqual(snapshot.attributedBadges[0]!.origin,h.source);assert.equal(snapshot.attributedBadges[0]!.count,3);assert.equal(snapshot.toast!.title,'Transient toast');
 h.advance(8001);assert.equal(h.broker.getSnapshot().toast,null);assert.equal(h.broker.getSnapshot().cards.length,1);h.lifecycle({foreground:false,available:false});assert.deepEqual(h.broker.getSnapshot().attributedBadges,[]);
});


test('invalid notifications deny only bounded authority-free correlated requests without invoking accessors', () => {
 const request={type:'notify.send',id:'oversized',title:'Test',body:'x'.repeat(4097)};
 assert.deepEqual(captureNotifyRejection(request),{type:'notify.send.result',id:'oversized',error:'invalid notification'});
 assert.deepEqual(captureNotifyRejection({type:'notify.permission.request',id:'p',channel:3}),{type:'notify.permission.result',id:'p',granted:false});
 for (const patch of [{publisher:'forged'},{sender:'forged'},{generation:'forged'},{id:''},{id:'x'.repeat(129)},{id:'control\n'},{body:'x'.repeat(32769)}]) assert.equal(captureNotifyRejection({...request,...patch}),null);
 assert.equal(captureNotifyRejection({type:'notify.permission.request',id:'p',title:'foreign'}),null);
 assert.equal(captureNotifyRejection({type:'notify.action',id:'p'}),null);
 assert.equal(captureNotifyRejection({type:'notify.send',id:'p',get title(){throw Error('Getter must not run');}}),null);
});
