import {normalizeRelayUrl, type RelaySettingsSnapshot} from '../network/relay-settings.ts';
import {publicKey} from '../storage/codec.ts';
import {OUTBOX_LIST_LIMITS} from './relay-list.ts';
import type {OutboxAuthorResolution, OutboxAuthorResolver} from './author-resolver.ts';
import {OutboxQueryError} from './query-contract.ts';

export type OutboxReadPlan = Readonly<{relays: readonly string[]; source: 'nip65' | 'cache' | 'fallback';
  missingAuthors: readonly string[]; incomplete: boolean}>;
/** No relay union is silently truncated. A write diagnostic never substitutes for required inbox resolution. */
export async function resolveOutboxPlan(resolver: OutboxAuthorResolver, settings: RelaySettingsSnapshot,
  userInput: string, authorInputs: readonly string[], hints: readonly string[], direction: 'read' | 'write',
  signal: AbortSignal, active: () => void, refresh = false, batchTimeoutMs?: number): Promise<OutboxReadPlan> {
  active(); const user = publicKey(userInput), authors = [...new Set(authorInputs.map(publicKey))];
  if (authors.length > OUTBOX_LIST_LIMITS.authors) throw new OutboxQueryError('policy denied');
  const network = settings.networkRelays.map(normalizeRelayUrl);
  if (network.length > OUTBOX_LIST_LIMITS.relays || new Set(network).size !== network.length) throw new OutboxQueryError('policy denied');
  const wideRead = direction === 'read' && batchTimeoutMs !== undefined;
  const routes = new Set(hints.map(normalizeRelayUrl)), missing = new Set<string>();
  if (routes.size > OUTBOX_LIST_LIMITS.relays) throw new OutboxQueryError('policy denied');
  const authorRoutes = new Map<string, readonly string[]>();
  let source: OutboxReadPlan['source'] = 'cache', incomplete = false;
  const results = new Map<string, OutboxAuthorResolution>();
  async function fetch(index:number):Promise<void> {
    if(index>=authors.length)return;
    active();const author=authors[index]!;
    try {results.set(author, await resolver.resolve(user,author,direction==='read'?'read':'publication',signal,active,refresh));}
    catch {active();}
    return fetch(index+2);
  }
  if (wideRead && authors.length > 0 && resolver.resolveReadBatch) {
    try {
      const batch = await resolver.resolveReadBatch(user, authors, signal, active, batchTimeoutMs);
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
      missing.add(author); incomplete = true; continue;
    }
    authorRoutes.set(author, relays.map(normalizeRelayUrl));
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
      else missing.add(author);
    }
  }
  if (selected.size > OUTBOX_LIST_LIMITS.relays) throw new OutboxQueryError('policy denied');
  if (selected.size === 0) throw new OutboxQueryError('relay list unavailable');
  if (fallback || missing.size > 0) { source = 'fallback'; incomplete = true; }
  active(); return Object.freeze({relays:Object.freeze([...selected]),source,
    missingAuthors:Object.freeze(authors.filter(author => missing.has(author))),incomplete});
}
