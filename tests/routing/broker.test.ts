import {artifact} from './fixtures.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {setup, tick, reviewReady, user} from './harness.ts';
test('availability uses signed retained catalog even before its handler runs', async t => {
  const h = await setup(t), result = h.dispatch(h.source, {type: 'intent.available', id: 'available', archetype: 'note'}); await result.promise;
  assert.equal(result.reply().availability.available, true); assert.equal(result.reply().availability.hasDefault, false);
  assert.deepEqual(result.reply().availability.candidates[0].conventions, ['napplet:note/open', 'napplet:note/edit']);
  assert.equal(h.activated.length, 0); assert.equal(h.sent.length, 0);
});
test('approved dispatch sends exact payload only after actual target subscription readiness', async t => {
  const h = await setup(t); await h.register(h.target); await h.subscribeTarget();
  const payload = {literal: '+', nested: [null, false, 3, {'__proto__': null}], unicode: '⚡'};
  const result = h.dispatch(h.source, {type: 'intent.invoke', id: 'invoke', request: {archetype: 'note', convention: 'napplet:note/open', payload}});
  payload.literal = 'mutated';
  const review = await reviewReady(h.reviews); assert.equal(review.request.kind, 'intent');
  if (review.request.kind !== 'intent') throw Error('Wrong review');
  assert.equal((review.request.request.payload as {literal: string}).literal, '+');
  assert.equal(h.sent.length, 0); h.reviews.decide(review.id, {allow: true}); await result.promise;
  assert.equal(result.reply().result.ok, true); assert.equal(result.reply().result.windowId, h.target.sessionId);
  assert.equal(h.sent.length, 1); assert.equal(h.sent[0]!.generation, h.target.generation); assert.equal(h.sent[0]!.message.type, 'inc.event'); assert.equal(h.sent[0]!.message.sender, 'caller'); assert.equal((h.sent[0]!.message.payload as {literal: string}).literal, '+');
});
test('saved defaults select the exact publisher and still require review on every dispatch', async t => {
  const h = await setup(t); await h.register(h.target); await h.subscribeTarget(); await h.catalog.remember({user, assertActive() {}}, h.b);
  await h.catalog.prefer({user, assertActive() {}}, 'note', {publisher: h.a.manifest.pubkey, appId: 'notes'});
  for (const id of ['first', 'second']) {
    const result = h.dispatch(h.source, {type: 'intent.invoke', id, request: {archetype: 'note', payload: null}});
    const review = await reviewReady(h.reviews); assert.equal(review.request.kind, 'intent');
    if (review.request.kind !== 'intent') throw Error('Wrong review'); assert.equal(review.request.selected!.publisher, h.a.manifest.pubkey);
    h.reviews.decide(review.id, {allow: true}); await result.promise; assert.equal(result.reply().result.ok, true);
  }
  assert.deepEqual(h.activated, [h.a.manifest.pubkey, h.a.manifest.pubkey]);
});
test('explicit dTags shared by publishers fail without arbitrary routing or a chooser', async t => {
  const h = await setup(t); await h.catalog.remember({user, assertActive() {}}, h.b);
  const result = h.dispatch(h.source, {type: 'intent.invoke', id: 'direct', request: {archetype: 'note', handler: 'notes'}});
  await result.promise; assert.equal(result.reply().result.error, 'ambiguous handler'); assert.equal(h.reviews.getSnapshot(), null); assert.equal(h.activated.length, 0);
});
test('forged registration and forged sender fields cannot acquire a route', async t => {
  const h = await setup(t);
  const forged = h.dispatch(h.source, {type: 'intent.available', id: 'forged', archetype: 'note'}, {publisher: h.a.manifest.pubkey}); await forged.promise; assert.equal(forged.reply(), undefined);
  const sender = h.dispatch(h.source, {type: 'inc.emit', topic: 'napplet:note/open', sender: 'forged'}); await sender.promise; assert.equal(sender.reply(), undefined); assert.equal(h.sent.length, 0);
});
test('identity revocation during review neither opens a handler nor discloses the payload', async t => {
  const h = await setup(t), result = h.dispatch(h.source, {type: 'intent.invoke', id: 'pending', request: {archetype: 'note', payload: {private: true}}});
  const review = await reviewReady(h.reviews); h.lifecycle({available: false, ownerAvailable: false});
  h.reviews.decide(review.id, {allow: true}); await result.promise; assert.equal(result.reply(), undefined); assert.equal(h.activated.length, 0); assert.equal(h.sent.length, 0);
});
test('removing a catalog handler during review invalidates the chosen event pin', async t => {
  const h = await setup(t), result = h.dispatch(h.source, {type: 'intent.invoke', id: 'removed', request: {archetype: 'note'}});
  const review = await reviewReady(h.reviews); await h.catalog.remove({user, assertActive() {}}, {publisher: h.a.manifest.pubkey, appId: 'notes'});
  h.reviews.decide(review.id, {allow: true}); await result.promise; assert.equal(result.reply().result.error, 'invoke failed'); assert.equal(h.activated.length, 0);
});
test('replayed internal correlation IDs cannot dispatch a second effect', async t => {
  const h = await setup(t); await h.register(h.target); await h.subscribeTarget();
  const first = h.dispatch(h.source, {type: 'intent.invoke', id: 'first', request: {archetype: 'note'}}, {}, 'same-call'); const review = await reviewReady(h.reviews); h.reviews.decide(review.id, {allow: true}); await first.promise;
  const second = h.dispatch(h.source, {type: 'intent.invoke', id: 'second', request: {archetype: 'note'}}, {}, 'same-call'); await second.promise; assert.equal(second.reply(), undefined); assert.equal(h.sent.length, 1);
});
test('topic allowance survives background without granting background delivery or a backlog', async t => {
  const h = await setup(t); await h.register(h.target); await h.subscribeTarget();
  h.lifecycle({available: false, foreground: false}); assert.equal(h.native.mayDeliver(h.target.generation, h.native.state().revision, 'inc'), false);
  h.lifecycle({available: true, foreground: true});
  const result = h.dispatch(h.source, {type: 'intent.invoke', id: 'resumed', request: {archetype: 'note'}}); const review = await reviewReady(h.reviews); h.reviews.decide(review.id, {allow: true}); await result.promise;
  assert.equal(result.reply().result.ok, true); assert.equal(h.sent.length, 1);
});
test('close cancels a pending review even before native teardown arrives', async t => {
  const h = await setup(t), result = h.dispatch(h.source, {type: 'intent.invoke', id: 'closed', request: {archetype: 'note'}});
  await reviewReady(h.reviews); h.broker.close(h.source.generation); await result.promise;
  assert.equal(result.reply(), undefined); assert.equal(h.sent.length, 0); assert.equal(h.activated.length, 0);
});

test('only compatible candidates participate in automatic choice; defaults never silently fall back', async t => {
  const h=await setup(t);await h.register(h.target);await h.subscribeTarget();
  const editOnly=await artifact(10, 'edit-only', 'note', 1_800_000_000, ['napplet:note/edit']);
  await h.catalog.remember({user,assertActive(){}},editOnly);
  const invoke=()=>h.dispatch(h.source,{type:'intent.invoke',id:'compatible',request:{archetype:'note',action:'open',convention:'napplet:note/open'}});
  const first=invoke(),review=await reviewReady(h.reviews);if(review.request.kind!=='intent')throw Error('Wrong review');
  assert.equal(review.request.candidates.length,1);assert.equal(review.request.selected!.publisher,h.a.manifest.pubkey);h.reviews.decide(review.id,{allow:true});await first.promise;assert.equal(first.reply().result.ok,true);
  await h.catalog.prefer({user,assertActive(){}},'note',{publisher:editOnly.manifest.pubkey,appId:'edit-only'});
  const second=invoke(),preferred=await reviewReady(h.reviews);if(preferred.request.kind!=='intent')throw Error('Wrong review');assert.equal(preferred.request.selected!.appId,'edit-only');h.reviews.decide(preferred.id,{allow:true});await second.promise;assert.equal(second.reply().result.error,'unsupported action');assert.equal(h.activated.length,1);
});
test('catalog changes reach only live same-identity intent recipients, including removed roles', async t=>{
 const h=await setup(t);await h.register(h.source);await h.register(h.target);
 await h.broker.catalogChanged({user,assertActive(){}},['note']);assert.equal(h.sent.length,1);assert.equal(h.sent[0]!.generation,h.source.generation);assert.equal(h.sent[0]!.message.type,'intent.changed');
 await h.catalog.remove({user,assertActive(){}},{publisher:h.a.manifest.pubkey,appId:'notes'});await h.broker.catalogChanged({user,assertActive(){}},['note']);assert.deepEqual(h.sent[1]!.message.availability,{archetype:'note',available:false,candidates:[],hasDefault:false});
 h.lifecycle({user:'05'.repeat(32),epoch:1});await assert.rejects(h.broker.catalogChanged({user,assertActive(){}},['note']));assert.equal(h.sent.length,2);
});
