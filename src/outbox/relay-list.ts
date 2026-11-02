import type { NostrEvent } from 'nostr-tools/pure';
import { parseQueryFilters, verifyQueryEvent } from '../network/relay-query-contract.ts';
import { MAX_RELAYS_PER_ROLE, normalizeRelayUrl } from '../network/relay-settings.ts';
import { utf8Bytes } from '../storage/codec.ts';

export const OUTBOX_LIST_LIMITS = Object.freeze({ events: 32, bundleBytes: 256 * 1024,
  relays: MAX_RELAYS_PER_ROLE, authors: 64, freshMs: 24 * 60 * 60_000,
  staleReadMs: 7 * 24 * 60 * 60_000 });
export class OutboxRelayListError extends Error {
  constructor() { super('relay list unavailable'); this.name = 'OutboxRelayListError'; }
}
export type OutboxRelayList = Readonly<{ event: NostrEvent; read: readonly string[];
  write: readonly string[]; deniedDestinations: number }>;
export type OutboxListAge = 'fresh' | 'stale' | 'expired';
const fail = (): never => { throw new OutboxRelayListError(); };
const hex64 = /^[0-9a-f]{64}$/;
const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** Cache age is measured from successful lookup, never from event.created_at. */
export function outboxListAge(fetchedAt: number, now: number): OutboxListAge {
  if (!integer(fetchedAt) || !integer(now) || fetchedAt > now) return fail();
  const age = now - fetchedAt;
  return age < OUTBOX_LIST_LIMITS.freshMs ? 'fresh'
    : age < OUTBOX_LIST_LIMITS.staleReadMs ? 'stale' : 'expired';
}
function filters(author: string) {
  if (typeof author !== 'string' || !hex64.test(author)) return fail();
  return parseQueryFilters([{ authors: [author], kinds: [10002], limit: OUTBOX_LIST_LIMITS.events }]);
}
function roles(event: NostrEvent): OutboxRelayList {
  const read = new Set<string>(), write = new Set<string>(), all = new Set<string>();
  let deniedDestinations = 0;
  for (const tag of event.tags) {
    if (tag[0] !== 'r' || tag[1] === undefined ||
        (tag[2] !== undefined && tag[2] !== 'read' && tag[2] !== 'write')) continue;
    let relay: string;
    try { relay = normalizeRelayUrl(tag[1]); } catch { deniedDestinations++; continue; }
    all.add(relay);
    // Never silently truncate a required recipient's signed relay set.
    if (all.size > OUTBOX_LIST_LIMITS.relays) return fail();
    if (tag[2] !== 'write') read.add(relay);
    if (tag[2] !== 'read') write.add(relay);
  }
  return Object.freeze({ event, read: Object.freeze([...read]), write: Object.freeze([...write]), deniedDestinations });
}
/** Reconstruct and authenticate even previously verified or persisted events. */
export function parseOutboxRelayList(input: unknown, author: string): OutboxRelayList {
  try { return roles(verifyQueryEvent(input, filters(author))); }
  catch { return fail(); }
}
/** NIP-01 replaceable selection: newest timestamp, then lowest lexical id. */
export function selectOutboxRelayList(input: unknown, author: string): OutboxRelayList | null {
  const selectedFilters = filters(author);
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype ||
      input.length > OUTBOX_LIST_LIMITS.events || Reflect.ownKeys(input).length !== input.length + 1) return fail();
  const events: NostrEvent[] = [];
  try {
    // Authenticate before serializing so accessors/symbols cannot smuggle cache fields.
    for (let index = 0; index < input.length; index++) {
      const field = Object.getOwnPropertyDescriptor(input, String(index));
      if (!field || !Object.hasOwn(field, 'value')) return fail();
      events.push(verifyQueryEvent(field.value, selectedFilters));
    }
    if (utf8Bytes(JSON.stringify(events)) > OUTBOX_LIST_LIMITS.bundleBytes) return fail();
  } catch { return fail(); }
  events.sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // Select signed winner first: an empty newest list revokes older destinations.
  return events.length === 0 ? null : roles(events[0]!);
}
