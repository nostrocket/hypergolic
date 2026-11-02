import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent } from 'nostr-tools/pure';
import { captureEventSnapshot } from '../../src/security/event-snapshot.ts';
import { SignedEventError, validateSignedEvent } from '../../src/security/signed-event.ts';

const SECRET = new Uint8Array(32); SECRET[31] = 2;
const SNAPSHOT = captureEventSnapshot({ kind: 1, content: 'signed fixture', tags: [['t', 'proof']], created_at: 1_700_000_002 }, 'c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5', ['wss://relay.example.org']);
// finalizeEvent annotates its return with nostr-tools' verification cache symbol.
// The production boundary receives a plain JSON wire value; retain a separate
// forged-cache fixture below so the cache rejection remains covered explicitly.
const SIGNED = JSON.parse(JSON.stringify(finalizeEvent(
  { ...SNAPSHOT.event, tags: SNAPSHOT.event.tags.map(tag => [...tag]) }, SECRET,
)));
const invalid = (value: unknown) => assert.throws(() => validateSignedEvent(SNAPSHOT, value), SignedEventError);

test('accepts an independently finalized scalar-2 event and freezes the verified copy', () => {
  const result = validateSignedEvent(SNAPSHOT, JSON.parse(JSON.stringify(SIGNED)));
  assert.equal(result.id, SIGNED.id); assert.equal(result.pubkey, SIGNED.pubkey);
  assert.equal(result.sig, SIGNED.sig); assert.equal(result.created_at, SNAPSHOT.event.created_at);
  assert.deepEqual(Reflect.ownKeys(result), ['id', 'pubkey', 'created_at', 'kind', 'tags', 'content', 'sig']);
  assert.doesNotThrow(() => validateSignedEvent(SNAPSHOT, result));
  assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.tags), true); assert.equal(Object.isFrozen(result.tags[0]), true);
});

test('rejects payload, identity, timestamp, tag-order, id and signature changes', () => {
  for (const change of [
    { content: 'changed' }, { pubkey: '22'.repeat(32) }, { created_at: 1_700_000_003 },
    { tags: [['proof', 't']] }, { id: '00'.repeat(32) }, { sig: '00'.repeat(64) },
  ]) invalid({ ...SIGNED, ...change });
});

test('rejects extra fields, getters, bad prototypes and forged verification cache symbols', () => {
  invalid({ ...SIGNED, extra: true });
  let reads = 0;
  const getter = { ...SIGNED, get sig() { reads++; return SIGNED.sig; } };
  invalid(getter); assert.equal(reads, 0);
  invalid(Object.assign(Object.create(null), SIGNED));
  const forged = { ...SIGNED }; Object.defineProperty(forged, Symbol.for('nostr-tools/verified'), { value: true }); invalid(forged);
  const nested = { ...SIGNED, tags: [[['nested']]] }; invalid(nested);
  const cyclic: any[] = []; cyclic.push(cyclic); invalid({ ...SIGNED, tags: [cyclic] });
});

test('returned copy is isolated from signer-result mutation after validation', () => {
  const input = JSON.parse(JSON.stringify(SIGNED));
  const result = validateSignedEvent(SNAPSHOT, input);
  input.content = 'mutated'; input.tags[0][0] = 'mutated'; input.sig = '00'.repeat(64);
  assert.equal(result.content, SIGNED.content); assert.deepEqual(result.tags, SIGNED.tags);
});
