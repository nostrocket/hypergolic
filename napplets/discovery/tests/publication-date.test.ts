import assert from 'node:assert/strict';
import test from 'node:test';
import { publicationTimestamp } from '../src/publication-date.ts';

test('publication dates preserve valid UTC timestamps and omit invalid signed date ranges', () => {
  assert.equal(publicationTimestamp(0)?.iso, '1970-01-01T00:00:00.000Z');
  assert.equal(publicationTimestamp(8640000000000)?.iso, '+275760-09-13T00:00:00.000Z');
  for (const value of [Number.MAX_SAFE_INTEGER, 8640000000001, Infinity, NaN, -1, 1.2]) assert.equal(publicationTimestamp(value), undefined);
});
