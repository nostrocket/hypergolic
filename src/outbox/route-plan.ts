import {normalizeRelayUrl, type RelaySettingsSnapshot} from '../network/relay-settings.ts';
import {publicKey} from '../storage/codec.ts';
import {OUTBOX_LIST_LIMITS} from './relay-list.ts';
import type {OutboxAuthorResolver} from './author-resolver.ts';
import {OutboxQueryError} from './query-contract.ts';

export type OutboxReadPlan = Readonly<{relays: readonly string[]; source: 'nip65' | 'cache' | 'fallback';
  missingAuthors: readonly string[]; incomplete: boolean}>;
/** No relay union is silently truncated. A write diagnostic never substitutes for required inbox resolution. */
export async function resolveOutboxPlan(resolver: OutboxAuthorResolver, settings: RelaySettingsSnapshot,
  userInput: string, authorInputs: readonly string[], hints: readonly string[], direction: 'read' | 'write',
  signal: AbortSignal, active: () => void, refresh = false): Promise<OutboxReadPlan> {
  active(); const user = publicKey(userInput), authors = [...new Set(authorInputs.map(publicKey))];
  if (authors.length > OUTBOX_LIST_LIMITS.authors) throw new OutboxQueryError('policy denied');
  const network = settings.networkRelays.map(normalizeRelayUrl);
  if (network.length > OUTBOX_LIST_LIMITS.relays || new Set(network).size !== network.length) throw new OutboxQueryError('policy denied');
  const routes = new Set<string>(), missing: string[] = [];
  let source: OutboxReadPlan['source'] = 'cache', incomplete = false;
  function add(relays: readonly string[]): void {
    for (const relay of relays) routes.add(normalizeRelayUrl(relay));
    if (routes.size > OUTBOX_LIST_LIMITS.relays) throw new OutboxQueryError('policy denied');
  }
  add(hints);
  const results:Awaited<ReturnType<OutboxAuthorResolver['resolve']>>[]=[];
  async function fetch(index:number):Promise<void> {
    if(index>=authors.length)return;
    active();const author=authors[index]!;
    try {results[index]=await resolver.resolve(user,author,direction==='read'?'read':'publication',signal,active,refresh);}
    catch {active();}
    return fetch(index+2);
  }
  await Promise.all([fetch(0),fetch(1)]);active();
  for (const [index,author] of authors.entries()) {
    const resolved=results[index];
    if(!resolved){missing.push(author);incomplete=true;continue;}
    incomplete ||= resolved.incomplete;
    if (resolved.source === 'nip65') source = 'nip65';
    const relays = direction === 'read' ? resolved.list?.write : resolved.list?.read;
    if (!relays?.length || (direction === 'write' && resolved.incomplete)) {missing.push(author); incomplete = true; continue;}
    add(relays);
  }
  if (direction === 'write' && (authors.length === 0 || missing.length > 0)) throw new OutboxQueryError(authors.length === 0 ? 'no authors' : 'relay list unavailable');
  if (authors.length === 0 || missing.length > 0) {add(network); source = 'fallback'; incomplete = true;}
  if (routes.size === 0) throw new OutboxQueryError('relay list unavailable');
  active(); return Object.freeze({relays:Object.freeze([...routes]),source,missingAuthors:Object.freeze(missing),incomplete});
}
