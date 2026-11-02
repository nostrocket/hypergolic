import test from 'node:test';
import assert from 'node:assert/strict';
import {deferred} from '../storage/harness.ts';
import {setup} from './harness.ts';

function pausePermissionRead(h: Awaited<ReturnType<typeof setup>>) {
  const entered = deferred(), release = deferred();
  h.sqlite.onStep = sql => {
    if (!sql.startsWith('SELECT 1 FROM notify_permissions WHERE')) return;
    h.sqlite.onStep = undefined;
    entered.resolve();
    return release.promise;
  };
  return {entered: entered.promise, release: release.resolve};
}

test('permission lookup latency does not consume the admitted toast or card lifetime', async t => {
  const h = await setup(t);
  await h.allow();
  const gate = pausePermissionRead(h);
  const sent = h.dispatch(h.source, {type: 'notify.send', id: 'slow-read', title: 'Delayed permitted alert'});
  try {
    await gate.entered;
    h.advance(10_000); // Within the owning native 25-second request lease.
    assert.equal(h.broker.getSnapshot().cards.length, 0);
  } finally { gate.release(); }
  await sent.promise;
  const id = sent.reply().notificationId;
  assert.ok(id);
  assert.equal(h.broker.getSnapshot().cards[0]!.created, 11_000);
  assert.equal(h.broker.getSnapshot().toast?.id, id);
  h.advance(7_999);
  assert.equal(h.broker.getSnapshot().toast?.id, id);
  h.advance(1);
  assert.equal(h.broker.getSnapshot().toast, null);
  assert.equal(h.broker.getSnapshot().cards.length, 1);
  assert.equal(h.sent.length, 0);
  h.advance(291_999);
  assert.equal(h.broker.getSnapshot().cards[0]!.id, id);
  h.advance(1);
  assert.equal(h.broker.getSnapshot().cards.length, 0);
  assert.deepEqual(h.sent.map(row => row.message), [{type: 'notify.dismissed', notificationId: id, reason: 'timeout'}]);
});

test('a four-request burst allowed by the native per-session bound cannot overflow six existing cards', async t => {
  const h = await setup(t);
  await h.allow();
  for (let index = 0; index < 6; index++) {
    const sent = h.dispatch(h.source, {type: 'notify.send', id: 'existing-' + index, title: 'Existing alert'});
    await sent.promise;
    assert.ok(sent.reply().notificationId);
  }
  const existing = h.broker.getSnapshot().cards.map(card => card.id);
  const gate = pausePermissionRead(h);
  let allocated = 0;
  const nextId = h.native.newChannelId;
  h.native.newChannelId = () => { allocated++; return nextId(); };
  const burst = Array.from({length: 4}, (_, index) => h.dispatch(h.source, {
    type: 'notify.send', id: 'native-size-burst-' + index, title: 'Concurrent admitted request',
  }));
  try { await gate.entered; assert.equal(h.broker.getSnapshot().cards.length, 6); }
  finally { gate.release(); }
  await Promise.all(burst.map(send => send.promise));
  assert.equal(burst.filter(send => send.reply().notificationId).length, 2);
  assert.equal(burst.filter(send => send.reply().error === 'rate limited').length, 2);
  assert.equal(allocated, 2);
  assert.equal(h.broker.getSnapshot().cards.length, 8);
  assert.deepEqual(h.broker.getSnapshot().cards.slice(0, 6).map(card => card.id), existing);
});

test('authority loss during the actual permission read creates no card, ID or reply and a fresh recipient still works', async t => {
  for (const mode of ['close', 'expire', 'background', 'identity', 'revoke']) {
    const h = await setup(t);
    await h.allow();
    const gate = pausePermissionRead(h);
    let allocated = 0;
    const nextId = h.native.newChannelId;
    h.native.newChannelId = () => { allocated++; return nextId(); };
    const sent = h.dispatch(h.source, {type: 'notify.send', id: 'pending-' + mode, title: 'Must not survive authority loss'});
    let revoked: Promise<void> | undefined;
    try {
      await gate.entered;
      if (mode === 'close') { h.revoke(h.source.generation); h.broker.close(h.source.generation); }
      if (mode === 'expire') h.expire(sent.token);
      if (mode === 'background') h.lifecycle({available: false, foreground: false});
      if (mode === 'identity') h.lifecycle({user: '08'.repeat(32), epoch: 1});
      if (mode === 'revoke') revoked = h.broker.revoke({...h.source, assertActive() {}}, '');
    } finally { gate.release(); }
    await Promise.all([sent.promise, revoked]);
    assert.equal(sent.reply(), undefined, mode);
    assert.equal(h.broker.getSnapshot().cards.length, 0, mode);
    assert.equal(h.broker.getSnapshot().toast, null, mode);
    assert.equal(allocated, 0, mode);
    assert.equal(h.sent.length, 0, mode);
    if (mode === 'background') h.lifecycle({available: true, foreground: true});
    const state = h.native.state();
    const fresh = {...h.peer, user: state.user, epoch: state.epoch};
    await h.permissions.grant({...fresh, assertActive() {}}, '');
    const positive = h.dispatch(fresh, {type: 'notify.send', id: 'fresh-' + mode, title: 'Independent positive control'});
    await positive.promise;
    assert.ok(positive.reply().notificationId, mode);
    assert.equal(allocated, 1, mode);
    assert.equal(h.broker.getSnapshot().cards[0]!.origin.generation, fresh.generation, mode);
  }
});
