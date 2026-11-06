import test from 'node:test';
import assert from 'node:assert/strict';
import {configMenuTarget} from '../../src/shell/config-menu-target.ts';
import {ReviewSlot} from '../../src/shell/review-slot.ts';
import {bundledDescriptor, resolveBundledSession} from '../../src/shell/fixtures.ts';
import {schema, setup} from './config-harness.ts';
import {tick} from './harness.ts';

test('menu opens the registered Config editor after native focus returns and pushes only an explicit save', async t => {
  const h = await setup(t);
  const descriptor = {id: h.source.sessionId, publisher: h.source.publisher, appId: h.source.appId,
    version: h.source.version, title: 'Touch game', source: 'published' as const};
  const menuTarget = () => configMenuTarget(h.broker.getSnapshot().menu, descriptor);
  assert.equal(menuTarget(), null);
  const touchSchema = {type: 'object', properties: {touchButtons: {type: 'boolean', default: false}}};
  const denied = h.dispatch({type: 'config.registerSchema', id: 'denied', schema: touchSchema}, {...h.source, domains: []});
  await denied.promise;
  assert.equal(menuTarget(), null);
  await h.register(touchSchema);
  await h.dispatch({type: 'config.subscribe'}).promise;
  assert.equal(configMenuTarget(h.broker.getSnapshot().menu, {...descriptor, version: '04'.repeat(32)}), null);
  const target = menuTarget()!;
  assert.equal(target.origin.generation, h.source.generation);
  h.focus('');
  const gate = h.pauseRead();
  let read = false;
  void gate.entered.then(() => {read = true;});
  const menu = h.broker.openFromMenu(target, new AbortController().signal, () => {});
  try {
    await tick();
    assert.equal(read, false);
    assert.equal(h.broker.getSnapshot().review, null);
    h.focus(h.source.generation);
    await gate.entered;
  } finally {gate.release();}
  assert.equal(await menu, true);
  const original = h.broker.getSnapshot().review!;
  assert.deepEqual(original.ordinary, {touchButtons: false});
  h.broker.closeReview(original.id);
  assert.deepEqual(h.sent.map(row => row.message.values), [{touchButtons: false}]);
  assert.equal(await h.broker.openFromMenu(target, new AbortController().signal, () => {}), true);
  await h.broker.commit(h.broker.getSnapshot().review!.id, {touchButtons: true}, {});
  assert.deepEqual(h.sent.map(row => row.message.values), [{touchButtons: false}, {touchButtons: true}]);
  assert.deepEqual(await h.get(), {touchButtons: true});
});

for (const interruption of ['menu cancellation', 'identity change', 'close', 'schema replacement', 'focus round trip'] as const) {
  test('pending Config menu handoff is revoked by ' + interruption, async t => {
    const h = await setup(t);
    await h.register();
    const target = h.broker.getSnapshot().menu[0]!;
    h.focus('');
    const intent = new AbortController();
    const result = assert.rejects(h.broker.openFromMenu(target, intent.signal, () => {}), {code: 'REVOKED'});
    if (interruption === 'menu cancellation') intent.abort();
    if (interruption === 'identity change') h.synchronizeRoutingOwner('05'.repeat(32), 1, true);
    if (interruption === 'close') h.close();
    if (interruption === 'schema replacement') await h.register(schema, 2);
    if (interruption === 'focus round trip') {h.focus(h.source.generation); h.focus('');}
    h.focus(h.source.generation);
    await result;
    assert.equal(h.broker.getSnapshot().review, null);
    if (interruption === 'schema replacement') {
      await assert.rejects(h.broker.openFromMenu(target, new AbortController().signal, () => {}), {code: 'REVOKED'});
      const fresh = h.broker.getSnapshot().menu[0]!;
      assert.notEqual(fresh, target);
      assert.equal(await h.broker.openFromMenu(fresh, new AbortController().signal, () => {}), true);
    }
  });
}

test('a Config menu editor claims the review slot only when ready and releases it on cancel or schema replacement', async t => {
  const empty = {getSnapshot: () => ({current: null}), subscribe: () => () => {}};
  const slot = new ReviewSlot(empty, empty, () => 0, () => () => {});
  t.after(() => slot.dispose());
  const h = await setup(t, undefined, slot);
  await h.register();
  const target = h.broker.getSnapshot().menu[0]!;
  const gate = h.pauseRead();
  const open = h.broker.openFromMenu(target, new AbortController().signal, () => {});
  const route = {id: 'route', origin: h.source};
  try {
    await gate.entered;
    assert.ok(slot.reserveRouting(route));
  } finally {gate.release();}
  assert.equal(await open, false);
  assert.ok(slot.owns('routing', route.id));
  slot.releaseRouting(route.id);
  assert.equal(await h.broker.openFromMenu(target, new AbortController().signal, () => {}), true);
  const first = h.broker.getSnapshot().review!;
  assert.ok(slot.owns('config', first.id));
  assert.equal(slot.reserveRouting(route), false);
  h.broker.closeReview(first.id);
  assert.equal(slot.getSnapshot(), null);
  assert.equal(await h.broker.openFromMenu(target, new AbortController().signal, () => {}), true);
  const second = h.broker.getSnapshot().review!;
  await h.register(schema, 2);
  assert.equal(h.broker.getSnapshot().review, null);
  assert.equal(slot.getSnapshot(), null);
  await assert.rejects(h.broker.commit(second.id, {theme: 'light', nested: {level: 2}}, {}), {code: 'REVOKED'});
  assert.deepEqual(await h.get(), {theme: 'dark', nested: {level: 2}});
});

test('a menu handoff without a native focus event times out and leaves a fresh editor available', async t => {
  const h = await setup(t);
  await h.register();
  t.mock.timers.enable({apis: ['setTimeout']});
  const target = h.broker.getSnapshot().menu[0]!;
  h.focus('');
  const result = assert.rejects(h.broker.openFromMenu(target, new AbortController().signal, () => {}), {code: 'REVOKED'});
  t.mock.timers.tick(4_000);
  await result;
  assert.equal(h.broker.getSnapshot().review, null);
  h.focus(h.source.generation);
  await h.dispatch({type: 'config.openSettings'}).promise;
  assert.ok(h.broker.getSnapshot().review);
});

test('a Save queued behind a schema registration cannot write through its superseded review', async t => {
  const h = await setup(t);
  await h.register();
  await h.broker.open(h.source.generation);
  const review = h.broker.getSnapshot().review!;
  const gate = h.pauseRead();
  const registration = h.register(schema, 2);
  await gate.entered;
  const result = assert.rejects(h.broker.commit(review.id, {theme: 'light', nested: {level: 2}}, {}), {code: 'REVOKED'});
  gate.release();
  await Promise.all([registration, result]);
  assert.equal(h.broker.getSnapshot().review, null);
  assert.deepEqual(await h.get(), {theme: 'dark', nested: {level: 2}});
});

test('bundled Config menu entries match the resolved fixture and exact session even for shared HTML', async t => {
  const h = await setup(t);
  const current = bundledDescriptor('routing-lab', 1);
  const peer = bundledDescriptor('routing-lab-peer', 1);
  const registration = {...h.source, ...resolveBundledSession(current), sessionId: current.id};
  await h.register(schema, 1, registration);
  const {menu} = h.broker.getSnapshot();
  assert.equal(configMenuTarget(menu, current)?.origin.fixture, 'routing-lab');
  assert.equal(configMenuTarget(menu, peer), null);
  assert.equal(configMenuTarget(menu, {...current, version: '09'.repeat(32)}), null);
});
