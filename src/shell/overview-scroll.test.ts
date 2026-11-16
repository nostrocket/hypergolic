import assert from 'node:assert/strict';
import { test } from 'node:test';
import { overviewGeometry } from './motion.ts';
import { createOverviewScrollRestorer, overviewScrollOffset } from './overview-scroll.ts';

const size = { width: 369, height: 704 };
const geometry = overviewGeometry(size, 20);

test('Home remount waits for viewport and content in either native event order', () => {
  for (const events of [['layout', 'content'], ['content', 'layout']] as const) {
    const ready = createOverviewScrollRestorer();
    let nativeOffset = 0;
    let sharedOffset = 0;
    let scrolls = 0;
    const restore = () => {
      const next = overviewScrollOffset(geometry, 18, sharedOffset, size.height);
      nativeOffset = next;
      sharedOffset = next;
      scrolls += 1;
    };
    ready(events[0], restore);
    assert.equal(scrolls, 0);
    ready(events[1], restore);
    assert.equal(scrolls, 1);
    assert.equal(nativeOffset, sharedOffset);
    const rect = geometry.cards[18];
    assert(rect.y >= nativeOffset);
    assert(rect.y + rect.height + geometry.captionHeight <= nativeOffset + size.height);
    // Later content measurements must not undo the user's manual scrolling.
    nativeOffset = sharedOffset = 100;
    ready('content', restore);
    ready('layout', restore);
    assert.equal(scrolls, 1);
    assert.equal(nativeOffset, 100);
  }
});

test('returning through Home restores a retained offset even if the card is already in view', () => {
  const top = overviewScrollOffset(geometry, 10, 0, size.height);
  assert(top > 0);
  assert.equal(overviewScrollOffset(geometry, 10, top, size.height), top);
  assert.equal(overviewScrollOffset(geometry, 0, top, size.height), 60);
});

test('closed cards, empty lists and changed viewport geometry cannot retain an invalid offset', () => {
  assert.equal(overviewScrollOffset(overviewGeometry(size, 0), -1, 1000, size.height), 0);
  assert.equal(overviewScrollOffset(geometry, -1, -100, size.height), 0);
  assert.equal(overviewScrollOffset(geometry, -1, 1e6, size.height), geometry.contentHeight - size.height);
});
