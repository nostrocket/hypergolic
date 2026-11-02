import type { NostrEvent } from 'nostr-tools/pure';
import { parseQueryFilters, verifyQueryEvent, type QueryFilter } from '../network/relay-query-contract.ts';
import { utf8Bytes } from '../storage/codec.ts';
import type { CapabilityRequest, IdentityOperation } from '../runtime/capability-protocol.ts';

export const IDENTITY_LIMITS = Object.freeze({ freshMs: 5 * 60_000, timeoutMs: 20_000,
  cacheRows: 64, cacheBytes: 4 * 1024 * 1024, bundleBytes: 256 * 1024, concurrent: 2 });
export const IDENTITY_CACHE_KEYS = ['profile', 'relays', 'follows', 'mutes', 'bookmarks', 'pins', 'interests', 'badges'] as const;
export type IdentityCacheKey = typeof IDENTITY_CACHE_KEYS[number];
export type IdentityRequest = Extract<CapabilityRequest, Readonly<{ type: IdentityOperation }>>;
export type ProfileData = Readonly<Partial<Record<'name' | 'displayName' | 'about' | 'picture' | 'banner' | 'nip05' | 'lud16' | 'website', string>>>;
export class IdentityDataError extends Error {
  constructor(message = 'identity data unavailable') { super(message); this.name = 'IdentityDataError'; }
}
export function profileFilters(user: string): readonly QueryFilter[] {
  return parseQueryFilters([{ authors: [user], kinds: [0], limit: 4 }]);
}
/** Reconstruct exact NIP-01 fields to avoid accepting an upstream verification cache. */
export function verifiedIdentityEvents(events: unknown, filters: readonly QueryFilter[]): readonly NostrEvent[] {
  if (!Array.isArray(events) || Object.getPrototypeOf(events) !== Array.prototype || Reflect.ownKeys(events).length !== events.length + 1 || events.length > 32 || utf8Bytes(JSON.stringify(events)) > IDENTITY_LIMITS.bundleBytes) throw new IdentityDataError('invalid identity data');
  try { return Object.freeze(events.map(event => verifyQueryEvent(event, filters))); }
  catch { throw new IdentityDataError('invalid identity data'); }
}
export function verifiedProfileEvents(events: unknown, user: string): readonly NostrEvent[] {
  return verifiedIdentityEvents(events, profileFilters(user));
}
export function latestIdentityEvent(events: readonly NostrEvent[]): NostrEvent | null {
  return [...events].sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0] ?? null;
}
export function profileFromEvents(events: readonly NostrEvent[]): ProfileData | null {
  const event = latestIdentityEvent(events);
  if (!event) return null;
  let data: unknown;
  try { data = JSON.parse(event.content); } catch { throw new IdentityDataError('invalid profile metadata'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new IdentityDataError('invalid profile metadata');
  const source = data as Record<string, unknown>;
  const fields = { name: 256, display_name: 256, about: 8192, picture: 2048, banner: 2048, nip05: 1024, lud16: 320, website: 2048 };
  const result: Partial<Record<keyof ProfileData, string>> = {};
  for (const [field, maximum] of Object.entries(fields)) {
    if (!Object.hasOwn(source, field)) continue;
    const value = source[field];
    if (typeof value !== 'string' || utf8Bytes(value) > maximum) throw new IdentityDataError('invalid profile metadata');
    const name = field === 'display_name' ? 'displayName' : field as keyof ProfileData;
    result[name] = value;
  }
  return Object.freeze(result);
}
export { identityFailure } from '../runtime/capability-protocol.ts';
