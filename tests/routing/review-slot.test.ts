import assert from 'node:assert/strict';
import test from 'node:test';
import {RoutingReviewService} from '../../src/routing/routing-review.ts';
import {ReviewSlot} from '../../src/shell/review-slot.ts';
import {reviewReady, setup} from './harness.ts';

const origin = {sessionId: 'caller-view', generation: 'source-generation', epoch: 0};
const signing = {id: 'sign', origin};
const upload = {id: 'upload', origin};
const route = {id: 'route', origin};

function source() {
  let snapshot: {current: typeof signing | null; focusedSessionId: string | null} =
    {current: null, focusedSessionId: origin.sessionId};
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {listeners.delete(listener);};
    },
    show(current: typeof signing | null, focusedSessionId: string | null = origin.sessionId) {
      snapshot = {current, focusedSessionId};
      for (const listener of listeners) listener();
    },
  };
}

function openSlot(t: {after(action: () => void): void}) {
  const approvals = source(), uploads = source();
  let epoch: number | null = 0, refresh = () => {};
  const slot = new ReviewSlot(approvals, uploads, () => epoch, listener => {
    refresh = listener;
    return () => {refresh = () => {};};
  });
  t.after(() => slot.dispose());
  return {slot, approvals, uploads, changeEpoch(next: number | null) {epoch = next; refresh();}};
}

test('Upload-first Intent fails with its own result and a fresh retry owns the slot without an effect', async t => {
  const {slot, uploads} = openSlot(t);
  const h = await setup(t, undefined, ['inc'], new RoutingReviewService(slot));
  uploads.show(upload);
  const invoke = (id: string) => h.dispatch(h.source, {type: 'intent.invoke', id, request: {archetype: 'note'}});
  const blocked = invoke('blocked');
  await blocked.promise;
  assert.deepEqual(blocked.reply(), {type: 'intent.invoke.result', id: 'blocked',
    result: {ok: false, handled: false, archetype: 'note', action: 'open', error: 'review busy'}});
  assert.equal(h.reviews.getSnapshot(), null);
  assert.ok(slot.owns('upload', upload.id));
  uploads.show(null);

  const retry = invoke('retry');
  const review = await reviewReady(h.reviews);
  assert.ok(slot.owns('routing', review.id));
  uploads.show(upload);
  assert.ok(slot.owns('routing', review.id));
  h.reviews.decide('stale-review', {allow: true});
  assert.ok(slot.owns('routing', review.id));
  h.reviews.decide(review.id, {allow: false});
  await retry.promise;
  assert.equal(retry.reply().result.error, 'user cancelled');
  assert.ok(slot.owns('upload', upload.id));
  assert.deepEqual(h.activated, []);
  assert.deepEqual(h.sent, []);
});

test('in-flight signing and its receipt retain the exact slot until dismissal, including same-owner handoff', t => {
  const {slot, approvals, uploads} = openSlot(t);
  approvals.show(signing);
  assert.ok(slot.holdApproval(signing));
  assert.equal(slot.holdApproval(signing), false);
  approvals.show(null);
  uploads.show(upload);
  assert.ok(slot.owns('approval', signing.id));
  assert.equal(slot.reserveRouting(route), false);
  slot.releaseApproval('stale-signing');
  assert.ok(slot.owns('approval', signing.id));

  slot.setForeground(false);
  assert.equal(slot.getSnapshot(), null);
  assert.equal(slot.reserveRouting(route), false);
  slot.setForeground(true);
  assert.ok(slot.owns('approval', signing.id));
  slot.releaseApproval(signing.id);
  assert.ok(slot.owns('upload', upload.id));
});

test('focus, close, identity epoch and background clear the matching presentation claim', t => {
  const {slot, approvals, changeEpoch} = openSlot(t);
  approvals.show(signing);
  assert.ok(slot.holdApproval(signing));
  approvals.show(null, 'different-view');
  assert.equal(slot.getSnapshot(), null);

  assert.ok(slot.reserveRouting(route));
  slot.close('different-view');
  assert.ok(slot.owns('routing', route.id));
  slot.close(origin.sessionId);
  assert.equal(slot.getSnapshot(), null);

  assert.ok(slot.reserveRouting(route));
  slot.setForeground(false);
  slot.setForeground(true);
  assert.equal(slot.getSnapshot(), null);
  assert.ok(slot.reserveRouting(route));
  changeEpoch(null);
  changeEpoch(1);
  assert.equal(slot.getSnapshot(), null);
  assert.equal(slot.reserveRouting(route), false);
  assert.ok(slot.reserveRouting({...route, origin: {...origin, epoch: 1}}));
});


test('blurred requests cannot observe an unrelated focused review', async t => {
  const {slot, uploads} = openSlot(t);
  const reviews = new RoutingReviewService(slot);
  const h = await setup(t, undefined, ['inc'], reviews);
  h.setFocus(h.target.generation);
  const anotherUpload = {id: 'another-upload', origin: h.target};
  for (const current of [null, anotherUpload]) {
    uploads.show(current);
    const result = h.dispatch(h.source, {type: 'intent.invoke', id: current ? 'busy' : 'empty',
      request: {archetype: 'absent'}});
    await result.promise;
    assert.equal(result.reply().result.error, 'no handler');
    const topic = reviews.ask({kind: 'topic', origin: h.source, topic: 'example'}, () => {}, () => false);
    assert.equal(reviews.getSnapshot(), null);
    reviews.cancelAll();
    assert.deepEqual(await topic, {allow: false});
  }
  assert.deepEqual(h.activated, []);
  assert.deepEqual(h.sent, []);
});
