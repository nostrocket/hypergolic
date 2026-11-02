import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cardDragFromTouch, releasedCardTouch, isCardTapRelease } from './cardTouch.ts';
import { shouldCloseCard, wantsCardClose } from './motion.ts';
const down = { id: 7, x: 108.5, y: 449.36, time: 1000 };
const point = (dy: number, id = 7) => ({ id, absoluteX: down.x, absoluteY: down.y + dy });

test('observed iOS gentle movement releases pending card recognition', () => {
  const drag = cardDragFromTouch(down, point(-13.6667), 1064, 1)!;
  assert.equal(wantsCardClose(drag), false);
  assert(Math.max(Math.abs(drag.dx), Math.abs(drag.dy)) > 12);
});
test('rapid original-touch travel admits and closes without translation reset', () => {
  assert.equal(wantsCardClose(cardDragFromTouch(down, point(-16), 1016, 1)!), true);
  assert.equal(shouldCloseCard(releasedCardTouch(down, [point(-100)], 0, 1100, false)!), true);
});
test('multiple touches, another released pointer and native cancellation cannot close', () => {
  assert.equal(cardDragFromTouch(down, point(-100), 1100, 2), null);
  assert.equal(releasedCardTouch(down, [point(-100, 8)], 0, 1100, false), null);
  assert.equal(releasedCardTouch(down, [point(-100)], 1, 1100, false), null);
  assert.equal(releasedCardTouch(down, [point(-100)], 0, 1100, true), null);
  assert.equal(releasedCardTouch(down, [point(-100), point(-100, 8)], 0, 1100, false), null);
});
test('holding after a short rapid drag removes the average-speed shortcut', () => {
  assert.equal(wantsCardClose(cardDragFromTouch(down, point(-20), 1020, 1)!), true);
  assert.equal(shouldCloseCard(releasedCardTouch(down, [point(-40)], 0, 1040, false)!), true);
  assert.equal(shouldCloseCard(releasedCardTouch(down, [point(-40)], 0, 1300, false)!), false);
  // Existing long-distance release criterion intentionally survives a pause.
  assert.equal(shouldCloseCard(releasedCardTouch(down, [point(-80)], 0, 1400, false)!), true);
});
test('diagonal motion and too-short releases retain the existing rejection criteria', () => {
  const diagonal = { id: 7, absoluteX: down.x + 60, absoluteY: down.y - 40 };
  assert.equal(wantsCardClose(cardDragFromTouch(down, diagonal, 1040, 1)!), false);
  assert.equal(shouldCloseCard(releasedCardTouch(down, [point(-24)], 0, 1012, false)!), false);
});

test('iOS collapsed short strokes cannot become taps when no separate move is delivered', () => {
  const start = point(0);
  assert.equal(isCardTapRelease(start, [point(-20)], 0), false);
  assert.equal(isCardTapRelease(start, [point(-28)], 0), false);
  assert.equal(isCardTapRelease(start, [point(-8)], 0), true);
  assert.equal(isCardTapRelease(start, [{ ...point(-6), absoluteX: down.x + 6 }], 0), false);
});
test('tap release requires the original sole pointer and finite displacement', () => {
  const start = point(0);
  assert.equal(isCardTapRelease(start, [point(0, 8)], 0), false);
  assert.equal(isCardTapRelease(start, [point(0)], 1), false);
  assert.equal(isCardTapRelease(start, [point(0), point(0, 8)], 0), false);
  assert.equal(isCardTapRelease(null, [point(0)], 0), false);
  assert.equal(isCardTapRelease(start, [point(NaN)], 0), false);
});
