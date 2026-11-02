export const MAX_IDENTITIES = 16;

export type Identity = Readonly<{
  pubkey: string;
  addedAt: number;
  origin: 'generated' | 'imported' | 'connected';
}>;

export type Inventory = Readonly<{
  schema: 1;
  vaultId: string;
  revision: number;
  initialized: boolean;
  selectedPubkey: string | null;
  identities: readonly Identity[];
}>;

export type Pending = Readonly<
  | { kind: 'initialize'; operationId: string; addedAt: number }
  | { kind: 'import'; operationId: string; addedAt: number; pubkey: string }
  | { kind: 'select' | 'delete'; operationId: string; pubkey: string }
>;

export type DatabaseRecord = Readonly<{
  revision: number;
  inventory: Inventory;
  pending: Pending | null;
}>;

export type SecretRecord = {
  schema: 1;
  pubkey: string;
  secretKey: Uint8Array;
};

export type StagedSecret = SecretRecord & {
  vaultId: string;
  kind: 'initialize' | 'import';
  addedAt: number;
};

export type VaultErrorCode =
  | 'INVALID_NSEC'
  | 'INVALID_SECRET'
  | 'CORRUPT_METADATA'
  | 'STORAGE_FAILURE'
  | 'READBACK_FAILED'
  | 'RECOVERY_REQUIRED'
  | 'NOT_READY'
  | 'NOT_FOUND'
  | 'LIMIT_REACHED'
  | 'DELETE_SELECTED'
  | 'AUTHORIZATION_DENIED'
  | 'PENDING_DELETION'
  | 'INVALID_SIGNER_CONNECTION'
  | 'SIGNER_ALREADY_CONNECTED'
  | 'SIGNER_UNAVAILABLE' | 'SIGNER_RELAYS_CHANGED'
  | 'SIGNER_REJECTED'
  | 'SIGNER_EXPIRED'
  | 'SIGNER_RESPONSE_INVALID'
  | 'SIGNER_UNCERTAIN'
  | 'SIGNER_UNSUPPORTED'
  | 'SIGNER_IDENTITY_CHANGED'
  | 'SIGNER_APP_FAILED'
  | 'LOCAL_KEY_UNAVAILABLE';

export class VaultError extends Error {
  readonly code: VaultErrorCode;

  constructor(code: VaultErrorCode, reason: string = code) {
    super(reason);
    this.name = 'VaultError';
    this.code = code;
  }
}

export type VaultSnapshot = Readonly<{
  vaultId: string;
  revision: number;
  selectedPubkey: string;
  identities: readonly (Identity & { status: 'active' | 'deleting' })[];
  pendingDeletion: string | null;
}>;

const HEX = /^[0-9a-f]{64}$/;

const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

export const sameSecret = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

export const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export function pubkey(value: unknown): value is string {
  return typeof value === 'string' && value.length === 64 && HEX.test(value);
}

export function opaqueId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,80}$/.test(value);
}

export function wipeReturned(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  const descriptor = Object.getOwnPropertyDescriptor(value, 'secretKey');
  if (descriptor?.value instanceof Uint8Array) descriptor.value.fill(0);
}

export function record(value: unknown): Record<string, unknown> {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(descriptor => !own(descriptor, 'value'))
  ) {
    throw new VaultError('CORRUPT_METADATA');
  }
  return value as Record<string, unknown>;
}

export function fields(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !own(value, key))) {
    throw new VaultError('CORRUPT_METADATA');
  }
}

export const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export const freezeInventory = (value: Inventory): Inventory => Object.freeze({
  ...value,
  identities: Object.freeze(value.identities.map(identity => Object.freeze({ ...identity }))),
});

export function inventory(value: unknown): Inventory {
  const candidate = record(value);
  fields(candidate, ['schema', 'vaultId', 'revision', 'initialized', 'selectedPubkey', 'identities']);
  if (
    candidate.schema !== 1
    || !opaqueId(candidate.vaultId)
    || !integer(candidate.revision)
    || typeof candidate.initialized !== 'boolean'
    || !Array.isArray(candidate.identities)
    || candidate.identities.length > MAX_IDENTITIES
  ) {
    throw new VaultError('CORRUPT_METADATA');
  }
  const identities: Identity[] = candidate.identities.map(item => {
    const identity = record(item);
    fields(identity, ['pubkey', 'addedAt', 'origin']);
    if (!pubkey(identity.pubkey) || !integer(identity.addedAt) || !['generated', 'imported', 'connected'].includes(String(identity.origin))) {
      throw new VaultError('CORRUPT_METADATA');
    }
    return { pubkey: identity.pubkey, addedAt: identity.addedAt, origin: identity.origin as Identity['origin'] };
  });
  const validInitialized = candidate.initialized
    ? pubkey(candidate.selectedPubkey) && identities.some(identity => identity.pubkey === candidate.selectedPubkey) && candidate.revision >= 1
    : identities.length === 0 && candidate.selectedPubkey === null && candidate.revision === 0;
  if (new Set(identities.map(identity => identity.pubkey)).size !== identities.length || !validInitialized) {
    throw new VaultError('CORRUPT_METADATA');
  }
  return freezeInventory({
    schema: 1,
    vaultId: candidate.vaultId,
    revision: candidate.revision,
    initialized: candidate.initialized,
    selectedPubkey: candidate.selectedPubkey as string | null,
    identities,
  });
}

export function pending(value: unknown): Pending | null {
  if (value === null) return null;
  const candidate = record(value);
  const keys = candidate.kind === 'initialize'
    ? ['kind', 'operationId', 'addedAt']
    : candidate.kind === 'import'
      ? ['kind', 'operationId', 'addedAt', 'pubkey']
      : ['kind', 'operationId', 'pubkey'];
  fields(candidate, keys);
  if (
    !['initialize', 'import', 'select', 'delete'].includes(String(candidate.kind))
    || !opaqueId(candidate.operationId)
    || ((candidate.kind === 'initialize' || candidate.kind === 'import') && !integer(candidate.addedAt))
    || (candidate.kind !== 'initialize' && !pubkey(candidate.pubkey))
  ) {
    throw new VaultError('CORRUPT_METADATA');
  }
  return Object.freeze({ ...candidate }) as Pending;
}

export function database(value: unknown): DatabaseRecord {
  const candidate = record(value);
  fields(candidate, ['revision', 'inventory', 'pending']);
  if (!integer(candidate.revision)) throw new VaultError('CORRUPT_METADATA');
  const currentInventory = inventory(candidate.inventory);
  const currentPending = pending(candidate.pending);
  if (!currentInventory.initialized && currentPending?.kind !== 'initialize') throw new VaultError('CORRUPT_METADATA');
  if (currentPending?.kind === 'initialize' && currentInventory.initialized) throw new VaultError('CORRUPT_METADATA');
  if (currentPending?.kind === 'import' && currentInventory.identities.some(identity => identity.pubkey === currentPending.pubkey)) {
    throw new VaultError('CORRUPT_METADATA');
  }
  if (
    currentPending
    && (currentPending.kind === 'select' || currentPending.kind === 'delete')
    && (
      !currentInventory.identities.some(identity => identity.pubkey === currentPending.pubkey)
      || (currentPending.kind === 'delete' && currentPending.pubkey === currentInventory.selectedPubkey)
    )
  ) {
    throw new VaultError('CORRUPT_METADATA');
  }
  return Object.freeze({ revision: candidate.revision, inventory: currentInventory, pending: currentPending });
}

export function nextInventory(base: Inventory, changes: Partial<Inventory>): Inventory {
  if (base.revision >= Number.MAX_SAFE_INTEGER) throw new VaultError('CORRUPT_METADATA');
  return inventory({ ...base, ...changes, revision: base.revision + 1 });
}
