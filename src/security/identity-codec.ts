import { MAX_IDENTITIES, VaultError, type DatabaseRecord, type Identity, type Inventory, type Pending, type SecretRecord, type StagedSecret } from './identity-vault.ts';

const HEX = /^[0-9a-f]{64}$/;
export const MAX_PROTECTED_CHARS = 2048;
export const MAX_METADATA_CHARS = 8192;
const invalid = (): never => { throw new VaultError('CORRUPT_METADATA'); };
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== fields.length || fields.some(k => !Object.hasOwn(descriptors, k))
    || Object.values(descriptors).some(d => !Object.hasOwn(d, 'value'))) return invalid();
  return value as Record<string, unknown>;
}
function list(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) return invalid();
  for (let n = 0; n < value.length; n++) if (!Object.hasOwn(descriptors, String(n)) || !Object.hasOwn(descriptors[String(n)]!, 'value')) return invalid();
  return value;
}
function integer(v: unknown): number { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) return invalid(); return v; }
export function publicKey(v: unknown): string { if (typeof v !== 'string' || !HEX.test(v)) return invalid(); return v; }
function id(v: unknown): string { if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(v)) return invalid(); return v; }
function origin(v: unknown): Identity['origin'] { if (v !== 'generated' && v !== 'imported') return invalid(); return v; }
function inventory(value: unknown): Inventory {
  const v = object(value, ['schema', 'vaultId', 'revision', 'initialized', 'selectedPubkey', 'identities']);
  if (v.schema !== 1 || typeof v.initialized !== 'boolean') return invalid();
  const identities = list(v.identities, MAX_IDENTITIES).map(item => {
    const i = object(item, ['pubkey', 'addedAt', 'origin']);
    return Object.freeze({ pubkey: publicKey(i.pubkey), addedAt: integer(i.addedAt), origin: origin(i.origin) });
  });
  const revision = integer(v.revision), selectedPubkey = v.selectedPubkey === null ? null : publicKey(v.selectedPubkey);
  if (new Set(identities.map(i => i.pubkey)).size !== identities.length) return invalid();
  if (v.initialized ? (revision === 0 || !identities.some(i => i.pubkey === selectedPubkey)) : (revision !== 0 || selectedPubkey !== null || identities.length !== 0)) return invalid();
  return Object.freeze({ schema: 1, vaultId: id(v.vaultId), revision, initialized: v.initialized, selectedPubkey, identities: Object.freeze(identities) });
}
function pending(value: unknown): Pending | null {
  if (value === null) return null;
  if (typeof value !== 'object' || value === null) return invalid();
  const kind = Object.getOwnPropertyDescriptor(value, 'kind')?.value as unknown;
  if (kind !== 'initialize' && kind !== 'import' && kind !== 'select' && kind !== 'delete') return invalid();
  const v = object(value, kind === 'initialize' ? ['kind', 'operationId', 'addedAt'] : kind === 'import' ? ['kind', 'operationId', 'addedAt', 'pubkey'] : ['kind', 'operationId', 'pubkey']);
  const operationId = id(v.operationId);
  if (kind === 'initialize') return Object.freeze({ kind, operationId, addedAt: integer(v.addedAt) });
  if (kind === 'import') return Object.freeze({ kind, operationId, addedAt: integer(v.addedAt), pubkey: publicKey(v.pubkey) });
  return Object.freeze({ kind, operationId, pubkey: publicKey(v.pubkey) });
}
function database(value: unknown): DatabaseRecord {
  const v = object(value, ['revision', 'inventory', 'pending']);
  const inv = inventory(v.inventory), p = pending(v.pending);
  if (!inv.initialized && p?.kind !== 'initialize' || inv.initialized && p?.kind === 'initialize') return invalid();
  if (p?.kind === 'import' && inv.identities.some(i => i.pubkey === p.pubkey)) return invalid();
  if (p && (p.kind === 'select' || p.kind === 'delete') && (!inv.identities.some(i => i.pubkey === p.pubkey) || p.kind === 'delete' && p.pubkey === inv.selectedPubkey)) return invalid();
  return Object.freeze({ revision: integer(v.revision), inventory: inv, pending: p });
}
function parse(value: string, limit: number): unknown {
  if (typeof value !== 'string' || value.length > limit || !/^[\x20-\x7e]*$/.test(value)) return invalid();
  try { return JSON.parse(value) as unknown; } catch { return invalid(); }
}
function json(value: unknown, limit: number): string {
  const encoded = JSON.stringify(value);
  if (encoded.length > limit || !/^[\x20-\x7e]*$/.test(encoded)) return invalid();
  return encoded;
}

export function encodeDatabase(value: DatabaseRecord): string { return json(database(value), MAX_METADATA_CHARS); }
export function decodeDatabase(value: string): DatabaseRecord { return database(parse(value, MAX_METADATA_CHARS)); }
// Compact ASCII receipts keep all sixteen identities below SecureStore's historical 2 KiB limit.
export function encodeInventory(value: Inventory): string {
  const v = inventory(value);
  return json(['HGI1', v.vaultId, v.revision, v.initialized ? 1 : 0, v.selectedPubkey,
    v.identities.map(i => [i.pubkey, i.addedAt, i.origin === 'generated' ? 0 : 1])], MAX_PROTECTED_CHARS);
}
export function decodeInventory(value: string): Inventory {
  const a = list(parse(value, MAX_PROTECTED_CHARS), 6);
  if (a.length !== 6 || a[0] !== 'HGI1' || a[3] !== 0 && a[3] !== 1) return invalid();
  const identities = list(a[5], MAX_IDENTITIES).map(item => {
    const i = list(item, 3);
    if (i.length !== 3 || i[2] !== 0 && i[2] !== 1) return invalid();
    return { pubkey: i[0], addedAt: i[1], origin: i[2] === 0 ? 'generated' : 'imported' };
  });
  return inventory({ schema: 1, vaultId: a[1], revision: a[2], initialized: a[3] === 1, selectedPubkey: a[4], identities });
}
function secretHex(value: unknown): string {
  if (!(value instanceof Uint8Array) || value.length !== 32) throw new VaultError('INVALID_SECRET');
  let encoded = '';
  for (let n = 0; n < 32; n++) encoded += value[n]!.toString(16).padStart(2, '0');
  return encoded;
}
function secretBytes(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !HEX.test(value)) throw new VaultError('INVALID_SECRET');
  const bytes = new Uint8Array(32);
  for (let n = 0; n < 32; n++) bytes[n] = Number.parseInt(value.slice(n * 2, n * 2 + 2), 16);
  return bytes;
}
export function encodeSecret(value: SecretRecord): string {
  const v = object(value, ['schema', 'pubkey', 'secretKey']);
  if (v.schema !== 1) throw new VaultError('INVALID_SECRET');
  return json(['HGK1', publicKey(v.pubkey), secretHex(v.secretKey)], MAX_PROTECTED_CHARS);
}
export function decodeSecret(value: string, expectedPubkey: string): SecretRecord {
  const a = list(parse(value, MAX_PROTECTED_CHARS), 3);
  if (a.length !== 3 || a[0] !== 'HGK1' || publicKey(a[1]) !== publicKey(expectedPubkey)) throw new VaultError('INVALID_SECRET');
  return { schema: 1, pubkey: expectedPubkey, secretKey: secretBytes(a[2]) };
}
export function encodeStage(value: StagedSecret): string {
  const v = object(value, ['schema', 'pubkey', 'secretKey', 'vaultId', 'kind', 'addedAt']);
  if (v.schema !== 1 || v.kind !== 'initialize' && v.kind !== 'import') throw new VaultError('INVALID_SECRET');
  return json(['HGS1', publicKey(v.pubkey), secretHex(v.secretKey), id(v.vaultId), v.kind === 'initialize' ? 0 : 1, integer(v.addedAt)], MAX_PROTECTED_CHARS);
}
export function decodeStage(value: string): StagedSecret {
  const a = list(parse(value, MAX_PROTECTED_CHARS), 6);
  if (a.length !== 6 || a[0] !== 'HGS1' || a[4] !== 0 && a[4] !== 1) throw new VaultError('INVALID_SECRET');
  const pubkey = publicKey(a[1]), vaultId = id(a[3]), addedAt = integer(a[5]);
  return { schema: 1, pubkey, secretKey: secretBytes(a[2]), vaultId, kind: a[4] === 0 ? 'initialize' : 'import', addedAt };
}
