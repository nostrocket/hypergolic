import test from 'node:test';
import assert from 'node:assert/strict';
import { captureEventSnapshot, EventSnapshotError } from '../../src/security/event-snapshot.ts';

const PUBKEY = '11'.repeat(32);
const RELAYS = ['wss://relay.example.org', 'wss://relay.example.org/path'];
const EVENT = { kind: 1, content: 'hello', tags: [['t', 'snapshot']], created_at: 1_700_000_000 };
const HASH = '084b2dd1be12d7320f0ec2acca1476d8e6e04d095155784ed1c1b8e26aeb3c60';
const capture = (event: unknown = EVENT, pubkey: unknown = PUBKEY, relays: unknown = RELAYS) => captureEventSnapshot(event, pubkey, relays);
const invalid = (operation: () => unknown) => assert.throws(operation, EventSnapshotError);

test('captures exact immutable event, trusted identity and normalized write destinations', () => {
  const snapshot = capture();
  assert.equal(snapshot.hash, HASH);
  assert.deepEqual(snapshot.destinations, ['wss://relay.example.org/', 'wss://relay.example.org/path']);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.event), true);
  assert.equal(Object.isFrozen(snapshot.event.tags), true);
  assert.equal(Object.isFrozen(snapshot.event.tags[0]), true);
  assert.equal(Object.isFrozen(snapshot.destinations), true);
});

test('rejects event-owned fields, wrong prototypes, getters, sparse arrays and malformed tags', () => {
  invalid(() => capture({ ...EVENT, pubkey: PUBKEY }));
  invalid(() => capture(Object.assign(Object.create(null), EVENT)));
  let getterReads = 0;
  const getter = { kind: 1, content: 'x', tags: [['t']], get created_at() { getterReads++; return 1; } };
  invalid(() => capture(getter));
  assert.equal(getterReads, 0);
  const sparse: string[][] = []; sparse.length = 1; invalid(() => capture({ ...EVENT, tags: sparse }));
  invalid(() => capture({ ...EVENT, tags: [[]] }));
  invalid(() => capture({ ...EVENT, tags: [['t', 1]] }));
});

test('rejects invalid integers, identity metadata, destinations and unpaired UTF-16', () => {
  for (const kind of [-1, 65536, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) invalid(() => capture({ ...EVENT, kind }));
  for (const timestamp of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) invalid(() => capture({ ...EVENT, created_at: timestamp }));
  invalid(() => capture(EVENT, 'aa')); invalid(() => capture(EVENT, PUBKEY.replace('1', 'A')));
  for (const relay of ['ws://relay.example.org', 'wss://localhost', 'wss://relay.example.org?x=1', 'wss://relay.example.org/#x', 'https://relay.example.org',
    'wss://relay', 'wss://127.0.0.1', 'wss://192.168.1.1', 'wss://[::1]', 'wss://[fc00::1]', 'wss://[fe80::1]',
    'wss://2130706433', 'wss://relay.example']) invalid(() => capture(EVENT, PUBKEY, [relay]));
  invalid(() => capture({ ...EVENT, content: '\ud800' }));
});

test('deep capture is independent of caller mutation and timestamp is fixed', () => {
  const tags = [['t', 'before']], input = { kind: 1, content: 'before', tags, created_at: 10 }, relays = ['wss://relay.example.org'];
  const snapshot = capture(input, PUBKEY, relays);
  input.content = 'after'; input.created_at = 11; tags[0]![1] = 'after'; relays[0] = 'wss://other.example';
  assert.equal(snapshot.event.content, 'before'); assert.equal(snapshot.event.created_at, 10);
  assert.deepEqual(snapshot.event.tags, [['t', 'before']]); assert.deepEqual(snapshot.destinations, ['wss://relay.example.org/']);
});

test('rejects oversized canonical payload and destination ambiguity', () => {
  invalid(() => capture({ ...EVENT, content: 'x'.repeat(2 * 1024 * 1024) }));
  const repeated = ['x'.repeat(1024 * 1024)];
  invalid(() => capture({ ...EVENT, tags: [repeated, repeated, repeated] }));
  invalid(() => capture(EVENT, PUBKEY, ['wss://relay.example.org', 'wss://relay.example.org/']));
  invalid(() => capture(EVENT, PUBKEY, []));
});
