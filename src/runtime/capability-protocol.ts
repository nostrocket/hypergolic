import { parseOutboxRead, type OutboxReadRequest } from '../outbox/query-contract.ts';
import { identifier, publicKey, revision, text, utf8Bytes } from '../storage/codec.ts';
import { parseRelayQuery, type RelayQueryRequest } from '../network/relay-query-contract.ts';
import { LIMITS, type Scope } from '../storage/ports.ts';

export const CAPABILITY_LIMITS = Object.freeze({ messageBytes: 2 * 1024 * 1024, sessionRequests: 1024 });
export const SUPPORTED_CAPABILITY_DOMAINS = Object.freeze(['identity', 'storage', 'theme', 'relay', 'resource', 'upload', 'link', 'intent', 'inc', 'notify', 'config', 'outbox']);
// Published and bundled admission use the same reviewed domain set; operations still enforce grants.
const NATIVE_CAPABILITY_DOMAINS = SUPPORTED_CAPABILITY_DOMAINS;
export const IDENTITY_OPERATIONS = ['identity.getPublicKey', 'identity.getRelays', 'identity.getProfile',
  'identity.getFollows', 'identity.getMutes', 'identity.getBlocked', 'identity.getList',
  'identity.getZaps', 'identity.getBadges'] as const;
export const STORAGE_OPERATIONS = ['storage.get', 'storage.set', 'storage.remove', 'storage.keys'] as const;
export type IdentityOperation = typeof IDENTITY_OPERATIONS[number];
export type StorageOperation = typeof STORAGE_OPERATIONS[number];
export type CapabilityOperation = IdentityOperation | StorageOperation | 'relay.query' | 'outbox.query' | 'outbox.getEvent' | 'outbox.resolveRelays';
export interface NativeRegistration {
  readonly sessionId: string; readonly generation: string; readonly epoch: number;
  readonly user: string; readonly publisher: string; readonly appId: string;
  readonly version: string; readonly instanceId: string;
  readonly fixture: string; readonly domains: readonly string[];
}
export type CapabilityRequest = OutboxReadRequest | RelayQueryRequest | Readonly<{ type: IdentityOperation; id: string; listType?: string }>
  | Readonly<{ type: StorageOperation; id: string; key?: string; value?: string; scope: Scope }>;
export type CapabilityReply = Readonly<Record<string, unknown> & { type: string; id: string }>;
export class CapabilityRequestError extends Error {
  constructor() { super('Invalid capability request'); this.name = 'CapabilityRequestError'; }
}
function invalid(): never { throw new CapabilityRequestError(); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== Object.keys(descriptors).length ||
      Object.values(descriptors).some(field => !Object.prototype.hasOwnProperty.call(field, 'value'))) return invalid();
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some(key => !Object.prototype.hasOwnProperty.call(value, key)) || Object.keys(value).some(key => !allowed.has(key))) invalid();
}
export function decodeNativeRegistration(value: unknown): NativeRegistration {
  const data = record(value);
  fields(data, ['sessionId', 'generation', 'epoch', 'user', 'publisher', 'appId', 'version', 'instanceId', 'fixture', 'domains']);
  if (!Array.isArray(data.domains) || data.domains.length > NATIVE_CAPABILITY_DOMAINS.length ||
      data.domains.some(domain => !NATIVE_CAPABILITY_DOMAINS.includes(domain)) || new Set(data.domains).size !== data.domains.length) return invalid();
  return Object.freeze({ sessionId: identifier(data.sessionId), generation: identifier(data.generation),
    epoch: revision(data.epoch), user: publicKey(data.user), publisher: publicKey(data.publisher),
    appId: text(data.appId, 1024), version: publicKey(data.version), instanceId: identifier(data.instanceId),
    fixture: identifier(data.fixture), domains: Object.freeze([...data.domains].sort()) });
}
export function parseCapabilityRequest(value: unknown): CapabilityRequest {
  const data = record(value);
  if (data.type === 'relay.query') return parseRelayQuery(data);
  if (['outbox.query','outbox.getEvent','outbox.resolveRelays'].includes(data.type as string)) return parseOutboxRead(data);
  const id = text(data.id, 128);
  const type = data.type;
  if (IDENTITY_OPERATIONS.includes(type as IdentityOperation)) {
    fields(data, type === 'identity.getList' ? ['type', 'id', 'listType'] : ['type', 'id']);
    return Object.freeze({ type: type as IdentityOperation, id,
      ...(type === 'identity.getList' ? { listType: text(data.listType, 256, true) } : {}) });
  }
  if (!STORAGE_OPERATIONS.includes(type as StorageOperation)) return invalid();
  const required = type === 'storage.keys' ? ['type', 'id'] : type === 'storage.set' ? ['type', 'id', 'key', 'value'] : ['type', 'id', 'key'];
  fields(data, required, ['scope']);
  if (Object.prototype.hasOwnProperty.call(data, 'scope') && data.scope !== 'shared' && data.scope !== 'instance') return invalid();
  return Object.freeze({ type: type as StorageOperation, id, scope: data.scope === 'instance' ? 'instance' : 'shared',
    ...(type === 'storage.keys' ? {} : { key: text(data.key, LIMITS.keyBytes, true) }),
    ...(type === 'storage.set' ? { value: text(data.value, LIMITS.valueBytes, true) } : {}) });
}
export function decodeNativeRequest(raw: string): { registration: NativeRegistration; request: unknown } {
  if (typeof raw !== 'string' || utf8Bytes(raw) > CAPABILITY_LIMITS.messageBytes) return invalid();
  const data = record(JSON.parse(raw));
  fields(data, ['registration', 'request']);
  if (typeof data.request !== 'string') return invalid();
  return { registration: decodeNativeRegistration(data.registration), request: JSON.parse(data.request) };
}
export function storageFailure(value: unknown, error: string): CapabilityReply | null {
  try {
    const data = record(value);
    if (!STORAGE_OPERATIONS.includes(data.type as StorageOperation)) return null;
    return Object.freeze({ type: `${data.type}.result`, id: text(data.id, 128), error });
  } catch { return null; }
}
export function queryFailure(value: unknown, error: string): CapabilityReply | null {
  try {
    const data = record(value);
    if (data.type !== 'relay.query') return null;
    return Object.freeze({ type: 'relay.query.result', id: text(data.id, 128), error });
  } catch { return null; }
}
export function identityResult(request: CapabilityRequest, user: string): CapabilityReply {
  const base = { type: `${request.type}.result`, id: request.id };
  switch (request.type) {
    case 'identity.getPublicKey': return Object.freeze({ ...base, pubkey: user });
    case 'identity.getRelays': return Object.freeze({ ...base, relays: {} });
    case 'identity.getProfile': return Object.freeze({ ...base, profile: null });
    case 'identity.getList': return Object.freeze({ ...base, entries: [] });
    case 'identity.getZaps': return Object.freeze({ ...base, zaps: [] });
    case 'identity.getBadges': return Object.freeze({ ...base, badges: [] });
    case 'identity.getFollows': case 'identity.getMutes': case 'identity.getBlocked': return Object.freeze({ ...base, pubkeys: [] });
    default: return invalid();
  }
}

/** Failed identity reads keep their required empty primary fields; public key has no error result. */
export function identityFailure(request: CapabilityRequest, error: string): CapabilityReply {
  if (request.type === 'identity.getPublicKey' || !request.type.startsWith('identity.')) return invalid();
  return Object.freeze({ ...identityResult(request, ''), error });
}
