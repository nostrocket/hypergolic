import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilityCompatibility, reviewedCapabilityCompatibility, supportForDomain } from '../../src/runtime/support-report.ts';
import { NAP_CATALOGUE } from '../../src/runtime/nap-catalogue.ts';

test('published admission filters capabilities independently of catalogue status', () => {
  assert.deepEqual(capabilityCompatibility(['media', 'theme', 'fs', 'outbox', 'gamepad']).domains, ['fs', 'media', 'outbox', 'theme']);
  assert.deepEqual(capabilityCompatibility(['media', 'theme', 'fs', 'outbox', 'gamepad']).unsupportedDomains, ['gamepad']);
  assert.equal(supportForDomain('fs').status, 'available');
  assert.equal(supportForDomain('media').status, 'available');
  assert.match(supportForDomain('media').detail, /Playlists and napplet-owned sessions are unavailable/);
  assert.equal(supportForDomain('resource').status, 'available');
  assert.equal(supportForDomain('shell').status, 'available');
  assert.equal(supportForDomain('storage').status, 'available');
  assert.equal(supportForDomain('outbox').status, 'available');
  assert.equal(supportForDomain('keys').status, 'available');
  assert.match(supportForDomain('keys').detail, /focused napplet/);
  assert.equal(supportForDomain('gamepad').status, 'unavailable');
  assert.match(supportForDomain('outbox').detail, /Raw Relay operations require a separate grant/);
  assert.match(supportForDomain('relay').detail, /Encrypted publication is unavailable/);
  assert.equal(new Set(NAP_CATALOGUE.map(row => row.domain)).size, NAP_CATALOGUE.length);
  assert(NAP_CATALOGUE.every(row => /^[a-f0-9]{40}$/.test(row.revision)));
});

test('support and request changes require a different remembered review', () => {
  const first = capabilityCompatibility(['fs', 'theme']);
  assert.equal(first.review, capabilityCompatibility(['theme', 'fs']).review);
  assert.notEqual(first.review, capabilityCompatibility(['theme', 'media']).review);
  assert.notEqual(first.review, reviewedCapabilityCompatibility(['fs', 'theme'], 'before-fs').review);
});

test('new list writes require a Lists grant alongside Relay and preserve the old grant on saved sessions',async()=>{
  const {publishedCapabilityCompatibility}=await import('../../src/napplets/first-open-consent.ts');
  assert.deepEqual(publishedCapabilityCompatibility(['relay'],['lists'],'before-lists').domains,['relay']);
  assert.deepEqual(publishedCapabilityCompatibility(['relay'],['lists']).domains,['lists','relay']);
  assert.deepEqual(publishedCapabilityCompatibility(['lists'],[]).unsupportedDomains,['lists']);
});
