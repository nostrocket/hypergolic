import {normalizeRelayUrl, type RelaySettingsSnapshot} from '../network/relay-settings.ts';
import {publicKey} from '../storage/codec.ts';
import {OUTBOX_LIST_LIMITS} from './relay-list.ts';
import type {OutboxAuthorResolution, OutboxAuthorResolver} from './author-resolver.ts';
import {OutboxQueryError} from './query-contract.ts';

export type OutboxReadPlanning = Readonly<{wide: boolean; timeoutMs: number; partialAuthorRoutes?: boolean}>;
export type OutboxReadPlan = Readonly<{relays: readonly string[]; source: 'nip65' | 'cache' | 'fallback';
  missingAuthors: readonly string[]; incomplete: boolean}>;

function appendPartialAuthorRoutes(selected: Set<string>, oversized: ReadonlyMap<string, readonly string[]>,
  network: readonly string[], missing: Set<string>): void {
  const signed = new Set([...oversized.values()].flat());
  for (const relay of [...network.filter(relay => signed.has(relay)), ...signed]) {
    if (selected.size === OUTBOX_LIST_LIMITS.relays) break;
    selected.add(relay);
  }
  for (const [author, relays] of oversized) {
    if (relays.some(relay => !selected.has(relay))) missing.add(author);
  }
}

/** Only one-shot Outbox data reads can use part of an oversized author route set. */
export async function resolveOutboxPlan(resolver: OutboxAuthorResolver, settings: RelaySettingsSnapshot,
  userInput: string, authorInputs: readonly string[], hints: readonly string[], direction: 'read' | 'write',
  signal: AbortSignal, active: () => void, refresh = false, planning?: OutboxReadPlanning): Promise<OutboxReadPlan> {
  active(); const user = publicKey(userInput), authors = [...new Set(authorInputs.map(publicKey))];
  if (authors.length > OUTBOX_LIST_LIMITS.authors) throw new OutboxQueryError('policy denied');
  const network = settings.networkRelays.map(normalizeRelayUrl);
  if (network.length > OUTBOX_LIST_LIMITS.relays || new Set(network).size !== network.length) throw new OutboxQueryError('policy denied');
  const wideRead = direction === 'read' && planning?.wide === true;
  const singleTimeoutMs = direction === 'read' && !wideRead && authors.length === 1 ? planning?.timeoutMs : undefined;
  const routes = new Set(hints.map(normalizeRelayUrl)), missing = new Set<string>();
  if (routes.size > OUTBOX_LIST_LIMITS.relays) throw new OutboxQueryError('policy denied');
  const authorRoutes = new Map<string, readonly string[]>();
  const oversized = new Map<string, readonly string[]>();
  const partialAuthorRoutes = direction === 'read' && planning?.partialAuthorRoutes === true;
  let source: OutboxReadPlan['source'] = 'cache', incomplete = false;
  const results = new Map<string, OutboxAuthorResolution>();
  async function fetch(index:number):Promise<void> {
    if(index>=authors.length)return;
    active();const author=authors[index]!;
    try {results.set(author, await resolver.resolve(user,author,direction==='read'?'read':'publication',signal,active,refresh,singleTimeoutMs));}
    catch {active();}
    return fetch(index+2);
  }
  if (wideRead && authors.length > 0 && resolver.resolveReadBatch) {
    try {
      const batch = await resolver.resolveReadBatch(user, authors, signal, active, planning.timeoutMs);
      for (const [author, resolution] of batch) results.set(author, resolution);
    } catch { active(); }
  } else await Promise.all([fetch(0),fetch(1)]);
  active();
  for (const author of authors) {
    const resolved = results.get(author);
    if (!resolved) { missing.add(author); incomplete = true; continue; }
    incomplete ||= resolved.incomplete;
    if (resolved.source === 'nip65') source = 'nip65';
    const relays = direction === 'read' ? resolved.list?.write : resolved.list?.read;
    if (!relays?.length || (direction === 'write' && resolved.incomplete)) {
      missing.add(author);
      incomplete ||= direction === 'write' || resolved.list !== null;
      continue;
    }
    const target = partialAuthorRoutes && relays.length > OUTBOX_LIST_LIMITS.relays ? oversized : authorRoutes;
    target.set(author, relays.map(normalizeRelayUrl));
  }
  if (direction === 'write' && (authors.length === 0 || missing.size > 0)) throw new OutboxQueryError(authors.length === 0 ? 'no authors' : 'relay list unavailable');
  const fallback = authors.length === 0 || missing.size > 0;
  let selected = new Set(routes);
  for (const relays of authorRoutes.values()) for (const relay of relays) selected.add(relay);
  if (fallback) for (const relay of network) selected.add(relay);
  if (wideRead && (fallback || selected.size > OUTBOX_LIST_LIMITS.relays)) {
    // Keep configured fallback peers reachable first and admit only whole author route sets.
    selected = new Set([...routes, ...network]);
    for (const [author, relays] of authorRoutes) {
      const combined = new Set([...selected, ...relays]);
      if (combined.size <= OUTBOX_LIST_LIMITS.relays) selected = combined;
      else { missing.add(author); incomplete = true; }
    }
  }
  if (selected.size > OUTBOX_LIST_LIMITS.relays) throw new OutboxQueryError('policy denied');
  const beforePartial = missing.size;
  appendPartialAuthorRoutes(selected, oversized, network, missing);
  incomplete ||= missing.size > beforePartial;
  if (selected.size === 0) throw new OutboxQueryError('relay list unavailable');
  if (fallback || beforePartial > 0) source = 'fallback';
  active(); return Object.freeze({relays:Object.freeze([...selected]),source,
    missingAuthors:Object.freeze(authors.filter(author => missing.has(author))),incomplete});
}
