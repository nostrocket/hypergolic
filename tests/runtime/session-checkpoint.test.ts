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
