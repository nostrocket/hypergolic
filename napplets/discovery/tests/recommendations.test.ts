import {test} from 'node:test';
import assert from 'node:assert/strict';
import {supportsRecommendations} from '../src/recommendations.ts';

test('public recommendations require a shell-supported addressable set for napplet addresses', () => {
  const support = {kind: 30267, type: 'app collections', addressable: true};
  assert.equal(supportsRecommendations([]), false);
  assert.equal(supportsRecommendations([{...support, kind: 30003}]), false);
  assert.equal(supportsRecommendations([{...support, addressable: false}]), false);
  assert.equal(supportsRecommendations([{...support, supportedItemTypes: ['url']}]), false);
  assert.equal(supportsRecommendations([{...support, supportedItemTypes: ['address']}]), true);
});
