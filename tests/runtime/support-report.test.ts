import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilityCompatibility, supportForDomain } from '../../src/runtime/support-report.ts';
import { NAP_CATALOGUE } from '../../src/runtime/nap-catalogue.ts';

test('published admission filters capabilities independently of catalogue status', () => {
  assert.deepEqual(capabilityCompatibility(['media', 'theme', 'fs', 'outbox']).domains, ['outbox', 'theme']);
  assert.deepEqual(capabilityCompatibility(['media', 'theme', 'fs', 'outbox']).unsupportedDomains, ['fs', 'media']);
  assert.equal(supportForDomain('fs').status, 'unavailable');
  assert.equal(supportForDomain('media').status, 'unavailable');
  assert.equal(supportForDomain('resource').status, 'available');
  assert.equal(supportForDomain('shell').status, 'available');
  assert.equal(supportForDomain('storage').status, 'available');
  assert.equal(supportForDomain('outbox').status, 'available');
  assert.match(supportForDomain('outbox').detail, /also require the relay grant/);
  assert.match(supportForDomain('relay').detail, /Encrypted publication is unavailable/);
  assert.equal(new Set(NAP_CATALOGUE.map(row => row.domain)).size, NAP_CATALOGUE.length);
  assert(NAP_CATALOGUE.every(row => /^[a-f0-9]{40}$/.test(row.revision)));
});

test('support and request changes require a different remembered review', () => {
  const first = capabilityCompatibility(['fs', 'theme']);
  assert.equal(first.review, capabilityCompatibility(['theme', 'fs']).review);
  assert.notEqual(first.review, capabilityCompatibility(['theme', 'media']).review);
  assert.notEqual(first.review, capabilityCompatibility(['fs', 'theme'], ['theme', 'fs']).review);
});
