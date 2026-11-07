import { getEventHash, verifyEvent, type NostrEvent } from 'nostr-tools/pure';
import { text, utf8Bytes } from '../storage/codec.ts';

export const QUERY_LIMITS = Object.freeze({ filters: 4, list: 64, requestBytes: 16 * 1024,
  events: 32, eventBytes: 64 * 1024, resultBytes: 512 * 1024, frames: 64,
  timeoutMs: 15_000, concurrent: 2 });
export const OUTBOX_QUERY_COUNTS = Object.freeze({events: 200, frames: 256});
export const NATIVE_RELAY_REQUEST_BYTES = 8_192;
export type QueryFilter = Readonly<Record<string, readonly string[] | readonly number[] | number | string>>;
export type RelayQueryRequest = Readonly<{ type: 'relay.query'; id: string; filters: readonly QueryFilter[] }>;
export class RelayQueryError extends Error {
  constructor(message = 'relay query failed') { super(message); this.name = 'RelayQueryError'; }
}
/** Returned frames failed authentication, correlation or bounds; this is not an outage. */
export class RelayQueryDataError extends RelayQueryError {
  constructor() {super('relay query failed'); this.name = 'RelayQueryDataError';}
}
const fail = (): never => { throw new RelayQueryError('invalid relay query'); };
const hex64 = /^[0-9a-f]{64}$/;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== Object.keys(descriptors).length ||
      Object.values(descriptors).some(field => !Object.prototype.hasOwnProperty.call(field, 'value'))) return fail();
  return value as Record<string, unknown>;
}
function dense(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max ||
      Reflect.ownKeys(value).length !== value.length + 1) return fail();
  const output: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return fail();
    output.push(descriptor.value);
  }
  return output;
}
export function parseQueryFilters(input: unknown, maximumLimit: number = QUERY_LIMITS.events,
  maximumFilters: number = QUERY_LIMITS.filters, allowSearch = false, defaultLimit: number = QUERY_LIMITS.events): readonly QueryFilter[] {
  const filters = dense(input, maximumFilters);
  if (filters.length === 0) return fail();
  const result = filters.map(value => {
    const source = record(value), filter: Record<string, QueryFilter[string]> = {};
    if (Object.keys(source).length > 32) return fail();
    for (const [key, item] of Object.entries(source)) {
      if (key === 'search') {
        if (!allowSearch || filters.length !== 1 || typeof item !== 'string' || item.length > 1024 ||
          !item.trim() || utf8Bytes(item) > 1024) return fail();
        filter.search = item;
      } else if (['since', 'until', 'limit'].includes(key)) {
        if (!integer(item)) return fail();
        // NIP-01 allows fewer initial results than the caller requests.
        filter[key] = key === 'limit' ? Math.min(item, maximumLimit) : item;
      } else {
        if (!['ids', 'authors', 'kinds'].includes(key) && !/^#[a-zA-Z]$/.test(key)) return fail();
        const values = dense(item, QUERY_LIMITS.list);
        if (values.length === 0) return fail();
        if (key === 'kinds') {
          if (!values.every(value => integer(value) && value <= 65535)) return fail();
          filter[key] = Object.freeze(values as number[]);
        } else {
          if (!values.every(value => typeof value === 'string' && utf8Bytes(value) <= 1024 &&
            (!['ids', 'authors', '#e', '#p'].includes(key) || hex64.test(value)))) return fail();
          filter[key] = Object.freeze(values as string[]);
        }
      }
    }
    if (typeof filter.since === 'number' && typeof filter.until === 'number' && filter.since > filter.until) return fail();
    // Bound broad requests without changing caller-selected narrower limits.
    if (filter.limit === undefined) filter.limit = defaultLimit;
    return Object.freeze(filter);
  });
  if (utf8Bytes(JSON.stringify(result)) > QUERY_LIMITS.requestBytes) return fail();
  return Object.freeze(result);
}
export function relayQueryWire(subscription: string, filters: readonly QueryFilter[]): string {
  const wire = JSON.stringify(['REQ', subscription, ...filters]);
  if (utf8Bytes(wire) > NATIVE_RELAY_REQUEST_BYTES) return fail();
  return wire;
}
export function parseRelayQuery(value: unknown): RelayQueryRequest {
  const data = record(value);
  if (data.type !== 'relay.query' || Object.keys(data).length !== 3 || !Object.prototype.hasOwnProperty.call(data, 'filters')) return fail();
  return Object.freeze({ type: 'relay.query', id: text(data.id, 128), filters: parseQueryFilters(data.filters) });
}
type QueryPhase = 'stored' | 'live';
export function queryMatches(event: NostrEvent, filter: QueryFilter, phase: QueryPhase = 'stored'): boolean {
  if (phase === 'stored' && filter.limit === 0) return false;
  return Object.entries(filter).every(([key, value]) => {
    if (key === 'search') return false; // Ranked reads verify a separate structured filter.
    if (key === 'limit') return true;
    if (key === 'since') return event.created_at >= (value as number);
    if (key === 'until') return event.created_at <= (value as number);
    if (key === 'ids') return (value as readonly string[]).includes(event.id);
    if (key === 'authors') return (value as readonly string[]).includes(event.pubkey);
    if (key === 'kinds') return (value as readonly number[]).includes(event.kind);
    return event.tags.some(tag => tag[0] === key.slice(1) && tag[1] !== undefined && (value as readonly string[]).includes(tag[1]));
  });
}
// Count JSON string contents before allocating a serialization, including escape amplification.
function consumeJsonText(value: string, remaining: number, allowUnpaired = false): number {
  if (value.length > remaining) return fail();
  for (let index = 0; index < value.length; index++) {
    const point = value.codePointAt(index)!;
    if (point > 0xffff) { remaining -= 4; index++; }
    else if (point >= 0xd800 && point <= 0xdfff) {
      if (!allowUnpaired) return fail();
      remaining -= 6;
    } else if (point < 0x20) remaining -= point >= 8 && point <= 13 && point !== 11 ? 2 : 6;
    else if (point === 0x22 || point === 0x5c) remaining -= 2;
    else remaining -= point <= 0x7f ? 1 : point <= 0x7ff ? 2 : 3;
    if (remaining < 0) return fail();
  }
  return remaining;
}

const capturedQueryEvents = new WeakSet<object>();
export function isCapturedQueryEvent(value: NostrEvent): boolean { return capturedQueryEvents.has(value); }
/** Fresh exact fields, byte bounds, matching filter and canonical hash before async verification. */
export function captureQueryEvent(input: unknown, filters: readonly QueryFilter[], phase: QueryPhase = 'stored'): NostrEvent {
  const value = record(input);
  if (typeof value.id !== 'string' || !hex64.test(value.id) || typeof value.pubkey !== 'string' || !hex64.test(value.pubkey) ||
      typeof value.sig !== 'string' || !/^[0-9a-f]{128}$/.test(value.sig) ||
      !integer(value.kind) || value.kind > 65535 || !integer(value.created_at) || typeof value.content !== 'string') return fail();
  const event: NostrEvent = { id: value.id, pubkey: value.pubkey, kind: value.kind,
    created_at: value.created_at, content: value.content, tags: [], sig: value.sig };
  // The fixed header is ASCII. Its empty content and tags include their outer delimiters.
  const available = QUERY_LIMITS.eventBytes - JSON.stringify({ ...event, content: '' }).length;
  let remaining = consumeJsonText(event.content, available, true);
  const tags = dense(value.tags, 256);
  remaining -= Math.max(0, tags.length - 1);
  for (const item of tags) {
    const tag = dense(item, 64);
    remaining -= 2 + tag.length * 2 + Math.max(0, tag.length - 1);
    if (remaining < 0) return fail();
    for (const field of tag) {
      if (typeof field !== 'string') return fail();
      remaining = consumeJsonText(field, remaining);
    }
    event.tags.push(tag as string[]);
  }
  if (!filters.some(filter => queryMatches(event, filter, phase))) return fail();
  try { if (getEventHash(event) !== event.id) return fail(); } catch { return fail(); }
  // Remove verification cache symbols; downstream code receives only NIP-01 fields.
  const clean = { id: event.id, pubkey: event.pubkey, kind: event.kind, created_at: event.created_at,
    content: event.content, tags: event.tags, sig: event.sig };
  for (const tag of event.tags) Object.freeze(tag);
  Object.freeze(event.tags);
  Object.freeze(clean);
  capturedQueryEvents.add(clean);
  return clean;
}
/** Synchronous paths retain fresh JS Schnorr verification; captured rows have no cache symbols. */
export function verifyQueryEvent(input: unknown, filters: readonly QueryFilter[], phase: QueryPhase = 'stored'): NostrEvent {
  const event = captureQueryEvent(input, filters, phase);
  // verifyEvent writes a cache symbol, so verify a fresh mutable exact-field copy.
  try { if (!verifyEvent({...event})) return fail(); } catch { return fail(); }
  return event;
}
export function selectQueryEvents(events: readonly NostrEvent[], filters: readonly QueryFilter[]): readonly Readonly<{ event: NostrEvent }>[] {
  const sorted = [...events].sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const selected = new Set<string>();
  for (const filter of filters) {
    const limit = filter.limit as number;
    let count = 0;
    for (const event of sorted) {
      if (count >= limit) break;
      if (queryMatches(event, filter)) { selected.add(event.id); count++; }
    }
  }
  const result: Readonly<{ event: NostrEvent }>[] = [];
  for (const event of sorted) {
    if (selected.has(event.id)) result.push(Object.freeze({ event }));
  }
  return Object.freeze(result);
}
