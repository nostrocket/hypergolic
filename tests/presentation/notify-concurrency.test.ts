import test from 'node:test';
import assert from 'node:assert/strict';
import {NOTIFY_LIMITS} from '../../src/presentation/notify-contract.ts';
import {setup} from './harness.ts';

test('concurrent permission reads cannot exceed one source card limit', async t => {
  const h = await setup(t);
  await h.allow();
  let allocated = 0;
  const nextId = h.native.newChannelId;
  h.native.newChannelId = () => { allocated++; return nextId(); };
  const sends = Array.from({length: 20}, (_, index) => h.dispatch(h.source, {
    type: 'notify.send', id: 'burst-' + index, title: 'Concurrent test', priority: 'urgent',
  }));
  await Promise.all(sends.map(send => send.promise));
  const replies = sends.map(send => send.reply());
  assert.equal(replies.filter(reply => reply.notificationId).length, NOTIFY_LIMITS.perSource);
  assert.equal(replies.filter(reply => reply.error === 'rate limited').length, 20 - NOTIFY_LIMITS.perSource);
  assert.equal(h.broker.getSnapshot().cards.length, NOTIFY_LIMITS.perSource);
  assert.equal(allocated, NOTIFY_LIMITS.perSource);
  assert.equal(new Set(replies.filter(reply => reply.notificationId).map(reply => reply.notificationId)).size, allocated);
  assert.equal(h.sent.length, 0);
  h.advance(300_000);
  assert.equal(h.broker.getSnapshot().cards.length, 0);
  assert.equal(h.sent.filter(row => row.message.type === 'notify.dismissed' && row.message.reason === 'timeout').length, allocated);
  const fresh = h.dispatch(h.source, {type: 'notify.send', id: 'after-window', title: 'Fresh notification'});
  await fresh.promise;
  assert.ok(fresh.reply().notificationId);
  assert.equal(h.broker.getSnapshot().cards.length, 1);
});

test('concurrent independent sources share the global card bound after asynchronous permission reads', async t => {
  const h = await setup(t);
  const sources = Array.from({length: 5}, (_, index) => ({
    ...h.source, appId: 'burst-app-' + index, generation: 'burst-generation-' + index,
    sessionId: 'burst-view-' + index, instanceId: 'burst-view-' + index,
  }));
  for (const source of sources) await h.permissions.grant({...source, assertActive() {}}, '');
  let allocated = 0;
  const nextId = h.native.newChannelId;
  h.native.newChannelId = () => { allocated++; return nextId(); };
  const sends = sources.flatMap(source => Array.from({length: 8}, (_, index) => h.dispatch(source, {
    type: 'notify.send', id: source.appId + '-' + index, title: 'Independent concurrent test',
  })));
  await Promise.all(sends.map(send => send.promise));
  const replies = sends.map(send => send.reply());
  const cards = h.broker.getSnapshot().cards;
  assert.equal(cards.length, NOTIFY_LIMITS.cards);
  assert.equal(replies.filter(reply => reply.notificationId).length, NOTIFY_LIMITS.cards);
  assert.equal(replies.filter(reply => reply.error === 'rate limited').length, sends.length - NOTIFY_LIMITS.cards);
  assert.equal(allocated, NOTIFY_LIMITS.cards);
  for (const source of sources) assert(cards.filter(card => card.origin.generation === source.generation).length <= NOTIFY_LIMITS.perSource);
  h.broker.dismiss(cards[0]!.id);
  const fresh = h.dispatch(sources[4]!, {type: 'notify.send', id: 'after-global-release', title: 'Released slot'});
  await fresh.promise;
  assert.ok(fresh.reply().notificationId);
  assert.equal(h.broker.getSnapshot().cards.length, NOTIFY_LIMITS.cards);
});
