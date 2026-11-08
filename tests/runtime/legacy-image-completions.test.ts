import test from 'node:test';
import assert from 'node:assert/strict';
import {createLegacyImageCompletions} from '../../runtime/src/legacy-image-completions.ts';
const image = (mib: number) => ({blob: new Blob([new Uint8Array(mib * 1024 * 1024)], {type: 'image/png'}), mime: 'image/png'});
test('paused image completions have a separate 10 MiB aggregate Blob budget', () => {
  const queue = createLegacyImageCompletions(), six = image(6), four = image(4);
  assert.equal(queue.put('first', six), true);
  assert.equal(queue.put('overflow', six), false);
  assert.equal(queue.take('overflow'), undefined);
  assert.equal(queue.put('overflow', {error: 'quota-exceeded'}), true);
  assert.equal(queue.put('second', four), true);
  assert.equal(queue.put('over-by-one', {blob: new Blob(['x']), mime: 'image/png'}), false);
  assert.equal(queue.take('first'), six);
  assert.equal(queue.put('replacement', six), true);
  assert.deepEqual(queue.take('overflow'), {error: 'quota-exceeded'});
  queue.close();
});
test('cancel and terminal document teardown release retained images and reject late completions', () => {
  const queue = createLegacyImageCompletions(), imageBytes = image(10);
  assert.equal(queue.put('cancelled', imageBytes), true);queue.drop('cancelled');
  assert.equal(queue.take('cancelled'), undefined);assert.equal(queue.put('loaded', imageBytes), true);
  queue.close();assert.equal(queue.take('loaded'), undefined);
  assert.equal(queue.put('stale', imageBytes), false);assert.equal(queue.put('stale-error', {error: 'timeout'}), false);
});
