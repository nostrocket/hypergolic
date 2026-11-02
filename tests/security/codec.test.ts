import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_IDENTITIES, type DatabaseRecord, type Inventory, type SecretRecord } from '../../src/security/identity-vault.ts';
import { decodeDatabase, decodeInventory, decodeSecret, decodeStage, encodeDatabase, encodeInventory, encodeSecret, encodeStage, MAX_PROTECTED_CHARS } from '../../src/security/identity-codec.ts';
import { pubkey, TEST_ID } from './harness.ts';

export const inventory = (): Inventory => ({ schema: 1, vaultId: TEST_ID, revision: 1, initialized: true, selectedPubkey: pubkey(1), identities: [{ pubkey: pubkey(1), addedAt: 42, origin: 'generated' }] });
export const record = (): DatabaseRecord => ({ revision: 0, inventory: inventory(), pending: null });

test('canonical metadata and compact protected receipts round trip without secret fields', () => {
  const db = record();
  assert.deepEqual(decodeDatabase(encodeDatabase(db)), db);
  assert.deepEqual(decodeInventory(encodeInventory(db.inventory)), db.inventory);
  const restored = decodeInventory(encodeInventory(db.inventory));
  assert(Object.isFrozen(restored) && Object.isFrozen(restored.identities) && Object.isFrozen(restored.identities[0]));
});
test('all sixteen identities at maximum supported integer/id lengths fit 2 KiB ASCII receipt', () => {
  const value: Inventory = { ...inventory(), vaultId: 'v'.repeat(80), revision: Number.MAX_SAFE_INTEGER,
    identities: Array.from({ length: MAX_IDENTITIES }, (_, n) => ({ pubkey: pubkey(n + 1), addedAt: Number.MAX_SAFE_INTEGER, origin: 'imported' })) };
  const encoded = encodeInventory(value);
  assert(Buffer.byteLength(encoded, 'utf8') <= MAX_PROTECTED_CHARS);
  assert.equal(encoded.length, Buffer.byteLength(encoded));
  assert.deepEqual(decodeInventory(encoded), value);
});
test('key and stage codecs return independent owned bytes; mutations do not change encoded snapshots', () => {
  const secret: SecretRecord = { schema: 1, pubkey: pubkey(1), secretKey: new Uint8Array(32).fill(7) };
  const encoded = encodeSecret(secret);
  secret.secretKey.fill(9);
  const decoded = decodeSecret(encoded, pubkey(1));
  assert(decoded.secretKey.every(byte => byte === 7));
  decoded.secretKey.fill(0);
  assert(decodeSecret(encoded, pubkey(1)).secretKey.every(byte => byte === 7));
  const staged = { ...secret, vaultId: TEST_ID, kind: 'import' as const, addedAt: 42 };
  assert.deepEqual(decodeStage(encodeStage(staged)), staged);
  assert.throws(() => decodeSecret(encoded, pubkey(2)));
});
const invalidCases: [string, (value: DatabaseRecord) => unknown][] = [
  ['secret at top level', v => ({ ...v, secretKey: 'never write this' })],
  ['secret nested in inventory', v => ({ ...v, inventory: { ...v.inventory, secretKey: new Uint8Array(32) } })],
  ['secret nested in identity', v => ({ ...v, inventory: { ...v.inventory, identities: [{ ...v.inventory.identities[0], secretKey: 'leak' }] } })],
  ['secret in pending', v => ({ ...v, pending: { kind: 'select', operationId: TEST_ID, pubkey: pubkey(1), secret: 'leak' } })],
  ['unknown schema', v => ({ ...v, inventory: { ...v.inventory, schema: 2 } })],
  ['unselected identity', v => ({ ...v, inventory: { ...v.inventory, selectedPubkey: pubkey(2) } })],
  ['duplicate identity', v => ({ ...v, inventory: { ...v.inventory, identities: [...v.inventory.identities, ...v.inventory.identities] } })],
  ['unsafe revision', v => ({ ...v, revision: Number.MAX_SAFE_INTEGER + 1 })],
  ['negative timestamp', v => ({ ...v, inventory: { ...v.inventory, identities: [{ ...v.inventory.identities[0], addedAt: -1 }] } })],
  ['invalid pubkey', v => ({ ...v, inventory: { ...v.inventory, selectedPubkey: 'nsec1unexpected' } })],
  ['accessor', v => Object.defineProperty(v, 'pending', { get() { throw new Error('accessor must not execute'); } })],
  ['toJSON injection', v => ({ ...v, toJSON() { throw new Error('toJSON must not execute'); } })],
  ['symbol secret', v => ({ ...v, [Symbol('secret')]: 'leak' })],
  ['array accessor', v => ({ ...v, inventory: { ...v.inventory, identities: Object.defineProperty([v.inventory.identities[0]], '0', { get() { throw new Error('array accessor must not execute'); } }) } })],
  ['sparse array', v => ({ ...v, inventory: { ...v.inventory, identities: new Array(1) } })],
  ['delete selected', v => ({ ...v, pending: { kind: 'delete', operationId: TEST_ID, pubkey: pubkey(1) } })],
];
for (const [name, corrupt] of invalidCases) test(`metadata codec rejects ${name}`, () => {
  assert.throws(() => encodeDatabase(corrupt(record()) as DatabaseRecord), error => error instanceof Error && error.message === 'CORRUPT_METADATA');
});
for (const input of ['', 'null', '[]', '"secret"', 'x'.repeat(8193), '{"secret":"秘密"}', '{']) test(`invalid stored metadata rejected (${input.slice(0, 12)})`, () => {
  assert.throws(() => decodeDatabase(input));
});
