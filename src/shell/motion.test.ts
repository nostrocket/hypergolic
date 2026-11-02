import assert from 'node:assert/strict';
import { test } from 'node:test';
import { absolutePointerDrag, pointerDrag, resolveCardRect } from './motion.ts';
import { cardTransform, handlePosition, handleRelease, overviewGeometry, shouldCloseCard, wantsCardClose } from './motion.ts';

test('tapping either end still opens overview, independent of neighbor availability', () => {
  for (const side of ['left', 'right'] as const) {
    assert.equal(handleRelease(side, { dx: 2, dy: 3, vx: 0, vy: 0 }, 360, false), 'overview');
    assert.equal(handleRelease(side, { dx: 2, dy: 3, vx: 0, vy: 0 }, 360, true), 'overview');
  }
});
test('inward drags switch only to the corresponding existing neighbor', () => {
  assert.equal(handleRelease('left', { dx: 100, dy: 2, vx: 0, vy: 0 }, 360, true), 'switch');
  assert.equal(handleRelease('right', { dx: -100, dy: 2, vx: 0, vy: 0 }, 360, true), 'switch');
  assert.equal(handleRelease('left', { dx: -200, dy: 0, vx: -2, vy: 0 }, 360, true), 'cancel');
  assert.equal(handleRelease('right', { dx: 200, dy: 0, vx: 2, vy: 0 }, 360, true), 'cancel');
  assert.equal(handleRelease('left', { dx: 200, dy: 0, vx: 2, vy: 0 }, 360, false), 'cancel');
});
test('short release, diagonal scrolling and multiple touches cannot accidentally switch', () => {
  assert.equal(handleRelease('left', { dx: 24, dy: 0, vx: 4, vy: 0 }, 360, true), 'cancel');
  assert.equal(handleRelease('left', { dx: 80, dy: 90, vx: 1, vy: 1 }, 360, true), 'cancel');
  assert.equal(handleRelease('left', { dx: 200, dy: 0, vx: 2, vy: 0, touches: 2 }, 360, true), 'cancel');
});
test('drag position follows the finger, caps at one neighbor and returns on reversal', () => {
  assert.equal(handlePosition(1, 3, 'left', 180, 360), 0.5);
  assert.equal(handlePosition(1, 3, 'right', -180, 360), 1.5);
  assert.equal(handlePosition(1, 3, 'left', 1000, 360), 0);
  assert.equal(handlePosition(1, 3, 'right', -1000, 360), 2);
  assert.equal(handlePosition(1, 3, 'left', -30, 360), 1);
  assert.equal(handlePosition(1, 3, 'left', 0, 360), 1);
});
test('end resistance stays bounded without wrapping even on an extreme drag', () => {
  const first = handlePosition(0, 3, 'left', 1e9, 360);
  const last = handlePosition(2, 3, 'right', -1e9, 360);
  assert(first < 0 && first > -28 / 360);
  assert(last > 2 && last < 2 + 28 / 360);
});
test('fast upward gesture can close; horizontal and gentle scrolling do not capture', () => {
  const rapid = { dx: 3, dy: -60, vx: 0, vy: -1 };
  assert.equal(wantsCardClose(rapid), true);
  assert.equal(shouldCloseCard(rapid), true);
  assert.equal(shouldCloseCard({ ...rapid, touches: 2 }), false);
  assert.equal(wantsCardClose({ dx: 2, dy: -100, vx: 0, vy: -0.1 }), false);
  assert.equal(wantsCardClose({ dx: 90, dy: -40, vx: 1, vy: -1 }), false);
  assert.equal(shouldCloseCard({ dx: 100, dy: -80, vx: 1, vy: -1 }), false);
  assert.equal(shouldCloseCard({ dx: 0, dy: -24, vx: 0, vy: -2 }), false);
});
test('two-column destinations preserve each full WebView aspect ratio at phone sizes', () => {
  for (const size of [{ width: 296, height: 530 }, { width: 369, height: 704 }, { width: 650, height: 300 }]) {
    const layout = overviewGeometry(size, 7);
    assert.equal(layout.cards.length, 7);
    for (const [index, rect] of layout.cards.entries()) {
      assert(rect.x >= 0 && rect.x + rect.width <= size.width);
      assert(Math.abs(rect.width / rect.height - size.width / size.height) < 1e-9);
      assert(rect.y + rect.height + layout.captionHeight <= layout.contentHeight);
      if (index % 2 === 1) assert.equal(rect.y, layout.cards[index - 1].y);
      if (index > 1) assert(rect.y > layout.cards[index - 2].y);
    }
  }
});
test('center-origin transform lands exact native view corners on its measured card', () => {
  const size = { width: 369, height: 704 };
  for (const rect of overviewGeometry(size, 3).cards) {
    const transform = cardTransform(size, rect);
    const x = size.width / 2 + transform.x - size.width * transform.scale / 2;
    const y = size.height / 2 + transform.y - size.height * transform.scale / 2;
    assert(Math.abs(x - rect.x) < 1e-9);
    assert(Math.abs(y - rect.y) < 1e-9);
    assert(Math.abs(size.height * transform.scale - rect.height) < 1e-9);
  }
});
test('large text reserves larger captions and empty overview has no phantom card', () => {
  const size = { width: 369, height: 704 };
  assert(overviewGeometry(size, 3, 2).captionHeight > overviewGeometry(size, 3).captionHeight);
  assert.deepEqual(overviewGeometry(size, 0).cards, []);
  assert.equal(overviewGeometry(size, 0).contentHeight, size.height);
});


test('native gesture velocity units preserve release thresholds and remembered multi-touch cancels', () => {
  const event = { translationX: 40, translationY: 0, velocityX: 700, velocityY: -900, numberOfPointers: 1 };
  const drag = pointerDrag(event);
  assert.equal(drag.vx, 0.7);
  assert.equal(drag.vy, -0.9);
  assert.equal(handleRelease('left', drag, 390, true), 'switch');
  assert.equal(handleRelease('left', pointerDrag(event, true), 390, true), 'cancel');
});

test('stale measured card geometry cannot survive a changed row or orientation', () => {
  const expected = { x: 12, y: 72, width: 160, height: 320 };
  const actual = { ...expected, width: 160.2, height: 320.1 };
  assert.equal(resolveCardRect(expected, { expected, actual }), actual);
  const moved = { ...expected, y: 460 };
  assert.equal(resolveCardRect(moved, { expected, actual }), moved);
  const rotated = { ...expected, width: 300, height: 160 };
  assert.equal(resolveCardRect(rotated, { expected, actual }), rotated);
});


test('manual activation translation reset cannot discard the original close travel', () => {
  const drag = absolutePointerDrag({ absoluteX: 105, absoluteY: 20, velocityX: 0, velocityY: -300, numberOfPointers: 1 }, { x: 100, y: 100 });
  assert.equal(drag.dx, 5);
  assert.equal(drag.dy, -80);
  assert.equal(shouldCloseCard(drag), true);
});
