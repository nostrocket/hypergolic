import test from 'node:test';
import assert from 'node:assert/strict';
import {createSessionCheckpoint} from '../../src/runtime/session-checkpoint.ts';
import type {CloseCheckEvent} from '../../src/shell/close-check.ts';

const event = (id: string, generation = 'g1', state: CloseCheckEvent['state'] = 'clean'): CloseCheckEvent =>
  ({type: 'close-check', id, generation, sessionId: 'card', state});

test('only the last background checkpoint for this generation can qualify a card', () => {
  const checkpoint = createSessionCheckpoint(null, () => assert.fail('unexpected restore'));
  assert.equal(checkpoint.request(true, () => 'one'), null);
  checkpoint.ready('g1');
  const first = checkpoint.request(true, () => 'one')!;
  assert.equal(checkpoint.receive(event('manual-close')), false);
  assert.equal(checkpoint.receive(event(first.id, 'stale')), false);
  assert.equal(checkpoint.receive(event(first.id, 'g1', 'dirty')), true);
  assert.equal(checkpoint.saved(), null);
  const second = checkpoint.request(true, () => 'two')!;
  assert.equal(checkpoint.receive(event(second.id)), true);
  assert.deepEqual(checkpoint.saved(), second);
  assert.equal(checkpoint.request(false, () => 'three'), null);
  assert.equal(checkpoint.saved(), null);
  assert.equal(checkpoint.receive(event(second.id)), false);
});

test('remount restores only its committed receipt, preserving it across an unsuccessful restore', () => {
  let restores = 0;
  const checkpoint = createSessionCheckpoint('resume-saved', () => restores++);
  checkpoint.ready('g2');
  const request = () => checkpoint.request(false, () => assert.fail('restore does not create a save'))!;
  const first = request();
  assert.deepEqual(first, {generation: 'g2', id: 'restore-saved'});
  assert.equal(checkpoint.receive(event(first.id, 'g1')), false);
  assert.equal(checkpoint.receive(event(first.id, 'g2', 'unknown')), true);
  assert.equal(checkpoint.restoring(), true);
  assert.equal(checkpoint.receive(event(request().id, 'g2')), true);
  assert.equal(restores, 1);
  assert.equal(checkpoint.restoring(), false);
  assert.equal(checkpoint.receive(event(first.id, 'g2')), false);
  assert.equal(checkpoint.saved(), null);
});

test('only a matched clean receipt carries the native editing intent into the exact restore', () => {
  for (const editing of [true, false, undefined]) {
    const save = createSessionCheckpoint(null, () => assert.fail());
    save.ready('g1');
    const request = save.request(true, () => 'original')!;
    assert.equal(save.receive({...event(request.id, 'old'), editing: true}), false);
    assert.equal(save.saved(), null);
    assert.equal(save.receive({...event(request.id, 'g1', 'unknown'), editing: true}), true);
    assert.equal(save.saved(), null);
    save.request(true, () => 'original');
    assert.equal(save.receive({...event(request.id), ...(editing === undefined ? {} : {editing})}), true);
    const saved = save.saved()!;
    const restored = createSessionCheckpoint(saved.id, () => {}, saved.editing);
    restored.ready('g2');
    assert.deepEqual(restored.request(false, () => assert.fail()), {
      id: 'restore-original', generation: 'g2', ...(editing === undefined ? {} : {editing}),
    });
    restored.receive(event('restore-original', 'g2'));
    assert.equal(restored.restoring(), false);
    assert.equal(restored.saved(), null);
  }
});

test('navigation samples the prior keyboard before the sheet hides it and drops the sample on reactivation', () => {
  const card = createSessionCheckpoint(null, () => assert.fail());
  card.recordNavigationKeyboard(true);
  card.ready('g1');
  assert.deepEqual(card.request(true, () => 'initial'), {id: 'resume-initial', generation: 'g1'});
  card.recordNavigationKeyboard(true);
  assert.equal(card.request(true, () => 'leaving')?.editing, true);
  assert.equal(card.request(true, () => 'retry')?.editing, true);
  card.request(false, () => assert.fail());
  assert.equal(card.request(true, () => 'unobserved')?.editing, undefined);
  card.recordNavigationKeyboard(false);
  assert.equal(card.request(true, () => 'dismissed')?.editing, false);
});
