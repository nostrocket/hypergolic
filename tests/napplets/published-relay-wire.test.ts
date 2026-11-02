import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePublishedRelayMessage } from '../../src/napplets/published-relay-wire.ts';
import { MAX_RELAY_FRAME_BYTES } from '../../src/napplets/published-source.ts';

const SUB = 'manifest_lookup_1';
const parse = (value: unknown) => parsePublishedRelayMessage(value, SUB);

test('accepts only the active subscription and preserves an untrusted event for later signature verification', () => {
  const result = parse(JSON.stringify(['EVENT', SUB, { id: 'unverified', tags: [] }]));
  assert.equal(result.type, 'event');
  if (result.type === 'event') assert.deepEqual(result.event, { id: 'unverified', tags: [] });
  assert(Object.isFrozen(result));
  assert.deepEqual(parse(JSON.stringify(['EOSE', SUB])), { type: 'eose' });
  assert.deepEqual(parse(JSON.stringify(['CLOSED', SUB, 'auth-required: login needed'])), {
    type: 'closed', reason: 'auth-required: login needed',
  });
  assert.deepEqual(parse(JSON.stringify(['NOTICE', 'maintenance'])), { type: 'notice', message: 'maintenance' });
});

test('wrong subscriptions, publish replies and malformed envelopes fail closed', () => {
  for (const message of [
    ['EVENT', 'other', {}], ['EOSE', 'other'], ['CLOSED', 'other', 'denied'],
    ['EVENT', SUB, null], ['EVENT', SUB, []], ['EVENT', SUB, {}, 'extra'],
    ['OK', '0'.repeat(64), true, ''], ['AUTH', {}], ['NOTICE', 1],
  ]) assert.throws(() => parse(JSON.stringify(message)));
  for (const wire of ['{', '{}', '[]', 'null', '"EOSE"', '']) assert.throws(() => parse(wire));
  assert.throws(() => parsePublishedRelayMessage(JSON.stringify(['EOSE', SUB]), 'bad id'));
});

test('message byte budget and server-supplied text bounds hold before event delivery', () => {
  assert.throws(() => parse(' '.repeat(MAX_RELAY_FRAME_BYTES + 1)));
  assert.throws(() => parse(JSON.stringify(['NOTICE', 'x'.repeat(257)])));
  assert.throws(() => parse(JSON.stringify(['CLOSED', SUB, 'é'.repeat(129)])));
});


test('optional relay AUTH announcements disclose no challenge and require an exact bounded shape', () => {
  for (const challenge of ['', 'rotated', 'é'.repeat(256)]) {
    const result = parse(JSON.stringify(['AUTH', challenge]));
    assert.deepEqual(result, { type: 'auth' });
    assert.ok(Object.isFrozen(result));
  }
  for (const message of [['AUTH'], ['AUTH', null], ['AUTH', {}], ['AUTH', 'challenge', 'extra']]) {
    assert.throws(() => parse(JSON.stringify(message)));
  }
  assert.throws(() => parse(JSON.stringify(['AUTH', 'é'.repeat(MAX_RELAY_FRAME_BYTES)])));
});
