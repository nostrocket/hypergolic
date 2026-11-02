import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { OUTBOX_LIST_LIMITS, OutboxRelayListError, outboxListAge,
  parseOutboxRelayList, selectOutboxRelayList } from '../../src/outbox/relay-list.ts';

const key = new Uint8Array(32).fill(31), author = getPublicKey(key);
function signed(tags: string[][], created_at = 100, content = '') {
  return JSON.parse(JSON.stringify(finalizeEvent({ kind: 10002, created_at, tags, content }, key)));
}

test('omitted role means both; normalization deduplicates without losing roles', () => {
  const list = parseOutboxRelayList(signed([
    ['r', 'wss://RELAY.damus.io/'], ['r', 'wss://relay.damus.io', 'write'],
    ['r', 'wss://nos.lol', 'read'], ['r', 'wss://relay.primal.net', 'write'],
  ]), author);
  assert.deepEqual(list.read, ['wss://relay.damus.io', 'wss://nos.lol']);
  assert.deepEqual(list.write, ['wss://relay.damus.io', 'wss://relay.primal.net']);
  assert.ok(Object.isFrozen(list.event.tags[0]));
  assert.ok(Object.isFrozen(list.read));
});

test('private, local, credentialed, insecure and ambiguous role tags never grant transport', () => {
  const list = parseOutboxRelayList(signed([
    ['r', 'ws://relay.damus.io'], ['r', 'wss://127.0.0.1'], ['r', 'wss://host.local'],
    ['r', 'wss://user:pass@relay.damus.io'], ['r', 'wss://relay.damus.io?token=x'],
    ['r', 'wss://nos.lol', 'unknown'], ['r', 'wss://relay.primal.net', 'read'],
  ]), author);
  assert.deepEqual(list.read, ['wss://relay.primal.net']);
  assert.deepEqual(list.write, []);
  assert.equal(list.deniedDestinations, 5);
});

test('fresh signature/hash validation rejects tampering even after prior verification', () => {
  const event = signed([['r', 'wss://nos.lol']]);
  parseOutboxRelayList(event, author);
  event.tags[0][1] = 'wss://relay.damus.io';
  assert.throws(() => parseOutboxRelayList(event, author), OutboxRelayListError);
});

test('wrong author, kind and forged signature cannot populate a list', () => {
  const event = signed([['r', 'wss://nos.lol']]);
  assert.throws(() => parseOutboxRelayList(event, getPublicKey(new Uint8Array(32).fill(32))), OutboxRelayListError);
  event.sig = '0'.repeat(128);
  assert.throws(() => parseOutboxRelayList(event, author), OutboxRelayListError);
  const wrongKind = JSON.parse(JSON.stringify(finalizeEvent({kind: 0, created_at: 100, tags: [], content: ''}, key)));
  assert.throws(() => parseOutboxRelayList(wrongKind, author), OutboxRelayListError);
});

test('newest signed empty list revokes older relay destinations', () => {
  const list = selectOutboxRelayList([signed([['r','wss://nos.lol']], 99), signed([], 100)], author);
  assert.ok(list);
  assert.equal(list.event.created_at, 100);
  assert.deepEqual(list.read, []);
  assert.deepEqual(list.write, []);
});

test('same timestamp chooses lowest id independent of arrival order', () => {
  const a = signed([['r','wss://nos.lol']], 100, 'a');
  const b = signed([['r','wss://relay.damus.io']], 100, 'b');
  const expected = a.id < b.id ? a.id : b.id;
  assert.equal(selectOutboxRelayList([a, b], author)?.event.id, expected);
  assert.equal(selectOutboxRelayList([b, a], author)?.event.id, expected);
});

test('required relay set exceeding the native route bound fails rather than truncating', () => {
  const tags = Array.from({length: OUTBOX_LIST_LIMITS.relays + 1}, (_, index) => ['r', `wss://relay${index}.nostr.net`, 'read']);
  assert.throws(() => parseOutboxRelayList(signed(tags), author), OutboxRelayListError);
});

test('list bundle rejects sparse/accessor arrays and excessive events without invoking getters', () => {
  const sparse = new Array(1);
  assert.throws(() => selectOutboxRelayList(sparse, author), OutboxRelayListError);
  const accessor: unknown[] = []; let called = false;
  Object.defineProperty(accessor, '0', {get() { called = true; return signed([]); }, enumerable: true});
  assert.throws(() => selectOutboxRelayList(accessor, author), OutboxRelayListError);
  assert.equal(called, false);
  assert.throws(() => selectOutboxRelayList(Array(33).fill(signed([])), author), OutboxRelayListError);
  assert.equal(selectOutboxRelayList([], author), null);
});

test('cache intervals use successful lookup time with exact expiry boundaries', () => {
  const checkedAt = 100_000;
  assert.equal(outboxListAge(checkedAt, checkedAt), 'fresh');
  assert.equal(outboxListAge(checkedAt, checkedAt + OUTBOX_LIST_LIMITS.freshMs - 1), 'fresh');
  assert.equal(outboxListAge(checkedAt, checkedAt + OUTBOX_LIST_LIMITS.freshMs), 'stale');
  assert.equal(outboxListAge(checkedAt, checkedAt + OUTBOX_LIST_LIMITS.staleReadMs), 'expired');
  assert.throws(() => outboxListAge(checkedAt + 1, checkedAt), OutboxRelayListError);
  assert.throws(() => outboxListAge(NaN, checkedAt), OutboxRelayListError);
});
