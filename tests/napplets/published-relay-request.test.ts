import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPublishedRelayRequest, MAX_PUBLISHED_REQ_BYTES, PublishedRelayRequestError } from '../../src/napplets/published-relay-request.ts';
import { parsePublishedRelayMessage } from '../../src/napplets/published-relay-wire.ts';
import { MAX_RELAY_FRAME_BYTES } from '../../src/napplets/published-source.ts';

const coordinate = Object.freeze({ kind: 35129 as const, pubkey: 'ab'.repeat(32), identifier: 'napplet-one' });

test('builds a bounded REQ with exact publisher, d coordinate, kind and limit', () => {
  const request = buildPublishedRelayRequest(coordinate);
  const parsed = JSON.parse(request.wire);
  assert.deepEqual(parsed[0], 'REQ');
  assert.match(request.subscriptionId, /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal(parsed[1], request.subscriptionId);
  assert.deepEqual(parsed[2], { kinds: [35129], authors: [coordinate.pubkey], '#d': ['napplet-one'], limit: 32 });
  assert.ok(new TextEncoder().encode(request.wire).byteLength <= MAX_PUBLISHED_REQ_BYTES);
  assert.ok(new TextEncoder().encode(request.wire).byteLength <= MAX_RELAY_FRAME_BYTES);
  assert.equal(Object.isFrozen(request), true);
  assert.equal(Object.isFrozen(request.wire), true);
});

test('pins the query to one exact event id when reopening a selected version', () => {
  const eventId = 'cd'.repeat(32);
  const request = buildPublishedRelayRequest(coordinate, eventId);
  assert.deepEqual(JSON.parse(request.wire)[2], {
    ids: [eventId], kinds: [35129], authors: [coordinate.pubkey], '#d': ['napplet-one'], limit: 32,
  });
});

test('generated subscription id agrees with the bounded response parser', () => {
  const request = buildPublishedRelayRequest(coordinate);
  assert.deepEqual(parsePublishedRelayMessage(JSON.stringify(['EOSE', request.subscriptionId]), request.subscriptionId), { type: 'eose' });
  assert.throws(() => parsePublishedRelayMessage(JSON.stringify(['EOSE', 'other']), request.subscriptionId));
});

test('rejects malformed coordinate records, accessors, and pinned ids', () => {
  let getterCalls = 0;
  const accessor = { kind: 35129, pubkey: 'ab'.repeat(32) } as Record<string, unknown>;
  Object.defineProperty(accessor, 'identifier', { get() { getterCalls++; return 'x'; }, enumerable: true });
  for (const value of [
    { ...coordinate, kind: 1 }, { ...coordinate, pubkey: 'AB'.repeat(32) }, { ...coordinate, identifier: '' },
    { ...coordinate, identifier: ' trailing ' }, { ...coordinate, identifier: 'x\n' }, accessor,
    Object.assign(Object.create(null) as object, coordinate),
  ]) assert.throws(() => buildPublishedRelayRequest(value as never), PublishedRelayRequestError);
  assert.equal(getterCalls, 0);
  for (const id of ['', 'ab'.repeat(31), 'AB'.repeat(32), 'g'.repeat(64), null]) {
    assert.throws(() => buildPublishedRelayRequest(coordinate, id as string), PublishedRelayRequestError);
  }
});

test('bounds the escaped identifier wire representation', () => {
  const identifier = '\\"'.repeat(120);
  const request = buildPublishedRelayRequest({ ...coordinate, identifier });
  assert.ok(new TextEncoder().encode(request.wire).byteLength < MAX_PUBLISHED_REQ_BYTES);
  assert.deepEqual(JSON.parse(request.wire)[2]['#d'], [identifier]);
});
