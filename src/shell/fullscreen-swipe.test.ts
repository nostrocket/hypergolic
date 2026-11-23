import assert from 'node:assert/strict';
import test from 'node:test';
import {finishFullscreenSwipe, startFullscreenSwipe} from './fullscreen-swipe.ts';

const touch = (pageX: number, pageY = 80, timestamp = 100) => ({identifier: 1, pageX, pageY, timestamp});

test('either safe-area edge reveals its own control after a deliberate inward swipe', () => {
  const left = startFullscreenSwipe(touch(70), 1, 52, 790);
  const right = startFullscreenSwipe(touch(775), 1, 52, 790);
  assert.equal(finishFullscreenSwipe(left, touch(135, 86, 420)), 'left');
  assert.equal(finishFullscreenSwipe(right, touch(708, 72, 430)), 'right');
});

test('corner taps, interior drags, vertical motion and multiple fingers stay in the game', () => {
  const start = startFullscreenSwipe(touch(30), 1, 0, 840);
  for (const end of [touch(30), touch(80), touch(5), touch(90, 160), touch(120, 80, 1100), {...touch(150), identifier: 2}]) {
    assert.equal(finishFullscreenSwipe(start, end), null);
  }
  assert.equal(startFullscreenSwipe(touch(400), 1, 0, 840), null);
  assert.equal(startFullscreenSwipe(touch(10), 2, 0, 840), null);
  assert.equal(finishFullscreenSwipe(null, touch(140)), null);
});
