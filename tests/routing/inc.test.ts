import test from 'node:test';
import assert from 'node:assert/strict';
import {setup, reviewReady} from './harness.ts';
async function channel(h: Awaited<ReturnType<typeof setup>>) {
  await h.register(h.source); await h.register(h.target);
  const before = h.sent.length;
  const call = h.dispatch(h.source, {type: 'inc.channel.open', id: 'open', target: h.target.appId});
  const review = await reviewReady(h.reviews); assert.equal(review.request.kind, 'channel');
  assert.equal(h.sent.length, before); h.reviews.decide(review.id, {allow: true}); await call.promise;
  assert.equal(call.reply().type, 'inc.channel.open.result'); assert.equal(call.reply().peer, h.target.appId);
  assert.deepEqual(h.sent[before], {generation: h.target.generation, message: {type: 'inc.channel.opened', channelId: call.reply().channelId, peer: h.source.appId}});
  return call.reply().channelId as string;
}
test('topics are exact, approved, sender-attested, independent and never echo to the emitter', async t => {
 const h=await setup(t);await h.register(h.target);await h.subscribeTarget();
 const sent=h.dispatch(h.source,{type:'inc.emit',topic:'napplet:note/open',payload:{literal:'+',nested:[null,false,3]}});await sent.promise;assert.equal(sent.reply(),null);
 assert.deepEqual(h.sent,[{generation:h.target.generation,message:{type:'inc.event',topic:'napplet:note/open',sender:h.source.appId,payload:{literal:'+',nested:[null,false,3]}}}]);
 await h.dispatch(h.target,{type:'inc.emit',topic:'napplet:note/open',payload:'no echo'}).promise;assert.equal(h.sent.length,1);
 await h.dispatch(h.source,{type:'inc.emit',topic:'napplet:note/open/extra',payload:'not exact'}).promise;assert.equal(h.sent.length,1);
 await h.dispatch(h.target,{type:'inc.unsubscribe',topic:'napplet:note/open'}).promise;
 await h.dispatch(h.source,{type:'inc.emit',topic:'napplet:note/open',payload:'unsubscribed'}).promise;assert.equal(h.sent.length,1);
});
test('query transposition preserves text and plus before cross-view routing', async t => {
 const h=await setup(t);await h.register(h.target);await h.subscribeTarget();
 await h.dispatch(h.source,{type:'inc.emit',topic:'napplet:note/open?literal=a+b&flag=false&number=3'}).promise;
 assert.deepEqual(h.sent[0]?.message.payload,{literal:'a+b',flag:'false',number:'3'});
 await h.dispatch(h.source,{type:'inc.emit',topic:'napplet:note/open?literal=a&literal=b'}).promise;assert.equal(h.sent.length,1);
});
test('channel target notification precedes opener result; list and symmetric messages use the same opaque id', async t => {
 const h=await setup(t),id=await channel(h);
 for(const endpoint of [h.source,h.target]) {const list=h.dispatch(endpoint,{type:'inc.channel.list',id:'list'});await list.promise;assert.deepEqual(list.reply().channels,[{id,peer:endpoint===h.source?h.target.appId:h.source.appId}]);}
 const send=h.dispatch(h.source,{type:'inc.channel.emit',channelId:id,payload:null});await send.promise;assert.equal(send.reply(),null);
 assert.deepEqual(h.sent[1],{generation:h.target.generation,message:{type:'inc.channel.event',channelId:id,sender:h.source.appId,payload:null}});
 await h.dispatch(h.target,{type:'inc.channel.broadcast',payload:{reply:true}}).promise;assert.deepEqual(h.sent[2],{generation:h.source.generation,message:{type:'inc.channel.event',channelId:id,sender:h.target.appId,payload:{reply:true}}});
 assert.equal(h.reviews.getSnapshot(),null);
});
test('unknown, ambiguous, inactive and rejected peers never create a channel', async t => {
 const h=await setup(t);await h.register(h.source);
 const missing=h.dispatch(h.source,{type:'inc.channel.open',id:'missing',target:h.target.appId});await missing.promise;assert.equal(missing.reply().error,'peer unavailable');
 await h.register(h.target);h.targetReady(false);const notReady=h.dispatch(h.source,{type:'inc.channel.open',id:'not-ready',target:h.target.appId});await notReady.promise;assert.equal(notReady.reply().error,'peer unavailable');h.targetReady(true);
 const denied=h.dispatch(h.source,{type:'inc.channel.open',id:'denied',target:h.target.appId});const review=await reviewReady(h.reviews);h.reviews.decide(review.id,{allow:false});await denied.promise;assert.equal(denied.reply().error,'user denied');assert.equal(h.sent.length,0);
 await h.register({...h.target,generation:'other-handler-generation',sessionId:'other-handler-view',instanceId:'other-handler-view'});
 const ambiguous=h.dispatch(h.source,{type:'inc.channel.open',id:'ambiguous',target:h.target.appId});await ambiguous.promise;assert.equal(ambiguous.reply().error,'peer unavailable');assert.equal(h.sent.length,0);
});
test('peer removal while channel review is open prevents notification and success', async t => {
 const h=await setup(t);await h.register(h.source);await h.register(h.target);
 const call=h.dispatch(h.source,{type:'inc.channel.open',id:'open',target:h.target.appId});const review=await reviewReady(h.reviews);h.broker.close(h.target.generation);h.reviews.decide(review.id,{allow:true});await call.promise;
 assert.equal(call.reply().error,'routing unavailable');assert.equal(h.sent.length,0);
});
test('explicit and endpoint close are symmetric terminal transitions with no later payload', async t => {
 const h=await setup(t),id=await channel(h);await h.dispatch(h.target,{type:'inc.channel.close',channelId:id}).promise;
 assert.deepEqual(h.sent.slice(1).map(value=>value.message),[{type:'inc.channel.closed',channelId:id,reason:'closed'},{type:'inc.channel.closed',channelId:id,reason:'closed'}]);
 await h.dispatch(h.source,{type:'inc.channel.emit',channelId:id,payload:'late'}).promise;assert.equal(h.sent.length,3);
 const next=await channel(h);h.broker.close(h.target.generation);assert.deepEqual(h.sent.at(-1),{generation:h.source.generation,message:{type:'inc.channel.closed',channelId:next,reason:'peer destroyed'}});
});
test('background delivers no payload backlog, retains only terminal closure and requires a fresh open review', async t => {
 const h=await setup(t),id=await channel(h);h.lifecycle({available:false,foreground:false});
 await h.dispatch(h.source,{type:'inc.channel.emit',channelId:id,payload:'background secret'}).promise;assert.equal(h.sent.length,1);
 h.lifecycle({available:true,foreground:true});assert.deepEqual(h.sent.slice(1).map(value=>value.message.type),['inc.channel.closed','inc.channel.closed']);
 const list=h.dispatch(h.source,{type:'inc.channel.list',id:'list'});await list.promise;assert.deepEqual(list.reply().channels,[]);
 const next=h.dispatch(h.source,{type:'inc.channel.open',id:'new',target:h.target.appId});const review=await reviewReady(h.reviews);assert.equal(review.request.kind,'channel');h.reviews.decide(review.id,{allow:false});await next.promise;
 assert.equal(h.sent.some(value=>value.message.payload==='background secret'),false);
});
test('native push overflow closes a channel and retries only its bounded terminal control record', async t => {
 const h=await setup(t),id=await channel(h);h.denyPush(true);
 await h.dispatch(h.source,{type:'inc.channel.emit',channelId:id,payload:'cannot enqueue'}).promise;
 const list=h.dispatch(h.source,{type:'inc.channel.list',id:'list'});await list.promise;assert.deepEqual(list.reply().channels,[]);
 h.denyPush(false);await h.dispatch(h.source,{type:'inc.channel.list',id:'flush'}).promise;
 assert.deepEqual(h.sent.slice(1).map(value=>value.message),[{type:'inc.channel.closed',channelId:id,reason:'buffer overflow'},{type:'inc.channel.closed',channelId:id,reason:'buffer overflow'}]);
});

test('a third loaded endpoint cannot use an observed channel id to emit, close or join it', async t => {
 const h=await setup(t),id=await channel(h),third={...h.target,appId:'third',generation:'third-generation',sessionId:'third-view',instanceId:'third-view'};await h.register(third);
 for(const message of [{type:'inc.channel.emit',channelId:id,payload:'third-party secret'},{type:'inc.channel.close',channelId:id}]) await h.dispatch(third,message).promise;
 const list=h.dispatch(third,{type:'inc.channel.list',id:'third-list'});await list.promise;assert.deepEqual(list.reply().channels,[]);assert.equal(h.sent.length,1);
 const original=h.dispatch(h.source,{type:'inc.channel.list',id:'original-list'});await original.promise;assert.equal(original.reply().channels[0].id,id);
});
test('native carrier expiry while channel review is displayed revokes the exact approval and recipient', async t => {
 const h=await setup(t);await h.register(h.target);const call=h.dispatch(h.source,{type:'inc.channel.open',id:'expires',target:h.target.appId});const review=await reviewReady(h.reviews);h.expire(call.token);h.reviews.decide(review.id,{allow:true});await call.promise;
 assert.equal(call.reply(),undefined);assert.equal(h.reviews.getSnapshot(),null);assert.equal(h.sent.length,0);
});
test('topic and channel quotas bound a loaded session rather than silently widening permission', async t => {
 const h=await setup(t);await h.register(h.target);h.setFocus(h.target.generation);
 for(let index=0;index<16;index++) {const call=h.dispatch(h.target,{type:'inc.subscribe',id:'sub-'+index,topic:'topic-'+index});const review=await reviewReady(h.reviews);h.reviews.decide(review.id,{allow:true});await call.promise;assert.equal(call.reply().error,undefined);}
 const full=h.dispatch(h.target,{type:'inc.subscribe',id:'full',topic:'topic-16'});await full.promise;assert.equal(full.reply().error,'topic limit reached');assert.equal(h.reviews.getSnapshot(),null);
 h.setFocus(h.source.generation);for(let index=0;index<8;index++) await channel(h);
 const ninth=h.dispatch(h.source,{type:'inc.channel.open',id:'ninth',target:h.target.appId});const review=await reviewReady(h.reviews);h.reviews.decide(review.id,{allow:true});await ninth.promise;assert.equal(ninth.reply().error,'peer unavailable');assert.equal(h.sent.length,8);
});
test('identity/epoch transition cannot reuse old topic permission, channel ids or delayed terminal records', async t => {
 const h=await setup(t),id=await channel(h);await h.subscribeTarget();h.lifecycle({user:'05'.repeat(32),epoch:1,available:true,ownerAvailable:true});
 await h.dispatch(h.source,{type:'inc.emit',topic:'napplet:note/open',payload:'old identity'}).promise;await h.dispatch(h.target,{type:'inc.channel.emit',channelId:id,payload:'old channel'}).promise;assert.equal(h.sent.length,1);
 h.lifecycle({user:h.source.user,epoch:2,available:true,ownerAvailable:true});await h.dispatch(h.source,{type:'inc.channel.list',id:'old-list'}).promise;assert.equal(h.sent.length,1);
});
