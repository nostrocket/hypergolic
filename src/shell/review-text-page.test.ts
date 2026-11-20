import assert from 'node:assert/strict';
import test from 'node:test';
import {reviewTextPage} from './review-text-page.ts';

test('all approval pages reconstruct the exact content without splitting a surrogate pair', () => {
  const content = 'x'.repeat(4095) + '🌱' + 'y'.repeat(4095) + '🌿';
  const pages = Array.from({length: reviewTextPage(content, 0).count}, (_, index) => reviewTextPage(content, index).text);
  assert.equal(pages.length, 3);
  assert.equal(pages[0], 'x'.repeat(4095));
  assert.equal(pages.join(''), content);
  assert.ok(pages.every(page => new TextDecoder().decode(new TextEncoder().encode(page)) === page && page.length <= 4097));
  assert.deepEqual(reviewTextPage('', 1), {index: 0, count: 1, text: ''});
  assert.equal(reviewTextPage(content, 200).text, pages.at(-1));
});
