import assert from 'node:assert/strict';
import test from 'node:test';
import {accessIconPath} from './access-icon.ts';
import {launchAccessCopy} from './launch-access-copy.ts';
import {SUPPORTED_CAPABILITY_DOMAINS} from '../runtime/capability-protocol.ts';

test('every granted capability has a consumer disclosure', () => {
  for (const domain of SUPPORTED_CAPABILITY_DOMAINS) {
    const copy = launchAccessCopy(domain, false);
    assert.notEqual(copy.name, domain);
    assert.doesNotMatch(copy.description, /not confirmed|Declared by the publisher/);
  }
});

test('unavailable known and unknown capabilities never promise working access', () => {
  for (const domain of ['identity', 'cvm', 'unknown-future-capability']) {
    const copy = launchAccessCopy(domain, true);
    assert.match(copy.description, /will not be granted/);
    assert.match(copy.description, /will not work/);
  }
  assert.equal(launchAccessCopy('unknown-future-capability', true).name, 'unknown-future-capability');
});

test('unknown declarations do not invent functionality', () => {
  assert.match(launchAccessCopy('unknown-future-capability', false).description, /not confirmed/);
});

test('sensitive access retains foreground, per-operation and free-tool limits', () => {
  assert.match(launchAccessCopy('keys', false).description, /focus/);
  assert.match(launchAccessCopy('upload', false).description, /Each upload needs your approval/);
  assert.match(launchAccessCopy('cvm', false).description, /free tools/);
  assert.match(launchAccessCopy('media', false).description, /15 minutes and 32 MiB/);
});

test('each named access type has distinct artwork, including unavailable direct messages', () => {
  const domains = [...SUPPORTED_CAPABILITY_DOMAINS, 'shell', 'dm'];
  const paths = domains.map(accessIconPath);
  assert.equal(new Set(paths).size, domains.length);
  assert.ok(!paths.includes(accessIconPath('unknown-future-capability')));
  assert.equal(accessIconPath('__proto__'), accessIconPath('unknown-future-capability'));
});
