import type { NostrEvent } from 'nostr-tools/pure';
import type { DetailedRelayQueryService, RelayQueryResult } from '../network/native-relay-query.ts';
import { parseQueryFilters, QUERY_LIMITS, RelayQueryDataError, RelayQueryError } from '../network/relay-query-contract.ts';
import { publicKey } from '../storage/codec.ts';
import { OUTBOX_QUERY_FILTERS } from './query-contract.ts';
import type { OutboxRelayListCache } from './relay-list-cache.ts';
import { OUTBOX_LIST_LIMITS, OutboxRelayListError, outboxListAge, parseOutboxRelayList, selectOutboxRelayList, type OutboxRelayList } from './relay-list.ts';

export type OutboxAuthorResolution = Readonly<{ list: OutboxRelayList | null; source: 'cache' | 'nip65'; incomplete: boolean }>;
export interface OutboxAuthorResolver {
  resolve(user: string, author: string, purpose: 'read' | 'publication', signal: AbortSignal, assertActive: () => void, refresh?: boolean): Promise<OutboxAuthorResolution>;
  resolveReadBatch?(user: string, authors: readonly string[], signal: AbortSignal, assertActive: () => void,
    timeoutMs: number): Promise<ReadonlyMap<string, OutboxAuthorResolution>>;
}
type ReadScope = Readonly<{ user: string; signal: AbortSignal; active: () => void }>;
/** Discovery service is constructed by the shell using trusted Lookup settings. */
export function createOutboxAuthorResolver(cache: OutboxRelayListCache, discovery: DetailedRelayQueryService,
  now: () => number = Date.now): OutboxAuthorResolver {
  let pending = 0;
  async function leased<T>(user: string, signal: AbortSignal, assertActive: () => void, work: (scope: ReadScope) => Promise<T>,
    timeoutMs: number = QUERY_LIMITS.timeoutMs): Promise<T> {
    if (pending >= QUERY_LIMITS.concurrent) throw new OutboxRelayListError();
    const controller = new AbortController(), stop = () => controller.abort();
    const active = () => { assertActive(); if (signal.aborted || controller.signal.aborted) throw new OutboxRelayListError(); };
    active(); pending++;
    signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, timeoutMs);
    let rejectCancelled!: () => void;
    const cancelled = new Promise<never>((_, reject) => { rejectCancelled = () => reject(new OutboxRelayListError()); });
    controller.signal.addEventListener('abort', rejectCancelled, { once: true });
    try {
      const result = await Promise.race([work({user, signal:controller.signal, active}), cancelled]);
      active(); return result;
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', stop);
      controller.signal.removeEventListener('abort', rejectCancelled); controller.abort(); pending--;
    }
  }
  async function cachedList(scope: ReadScope, author: string) {
    const stored = await cache.read(scope.user, author, scope.active, scope.signal); scope.active();
    return {
      list: stored?.event ? parseOutboxRelayList(stored.event, author) : null,
      age: stored ? outboxListAge(stored.fetchedAt, now()) : 'expired',
    };
  }
  type CachedList = Awaited<ReturnType<typeof cachedList>>;
  function fromCache(list: OutboxRelayList | null, incomplete: boolean): OutboxAuthorResolution {
    return Object.freeze({list, source:'cache', incomplete});
  }
  async function observedList(scope: ReadScope, author: string, cached: CachedList, observed: OutboxRelayList | null,
    incomplete: boolean, purpose: 'read' | 'publication', cacheMissing: boolean): Promise<OutboxAuthorResolution> {
    if (incomplete) {
      if (purpose === 'publication') throw new OutboxRelayListError();
      const candidates = [cached.age !== 'expired' ? cached.list?.event : undefined, observed?.event]
        .filter((event): event is NostrEvent => event !== undefined);
      return Object.freeze({list:selectOutboxRelayList(candidates, author), source:'nip65', incomplete:true});
    }
    if (!observed && cached.list) {
      return Object.freeze({list:purpose === 'read' && cached.age !== 'expired' ? cached.list : null, source:'nip65', incomplete:true});
    }
    if (!observed && !cacheMissing) return Object.freeze({list:null, source:'nip65', incomplete:true});
    const checkedAt = now(); outboxListAge(checkedAt, checkedAt);
    await cache.write(scope.user, author, {event:observed?.event ?? null, fetchedAt:checkedAt}, scope.active, scope.signal);
    scope.active();
    const saved = await cache.read(scope.user, author, scope.active, scope.signal); scope.active();
    if (!saved) throw new OutboxRelayListError();
    return Object.freeze({list:saved.event ? parseOutboxRelayList(saved.event, author) : null, source:'nip65', incomplete:false});
  }
  function byAuthor(fetched: RelayQueryResult, authors: readonly string[]): ReadonlyMap<string, OutboxRelayList | null> {
    const grouped = new Map(authors.map(author => [author, [] as NostrEvent[]]));
    for (const {event} of fetched.events) {
      const matching = grouped.get(event.pubkey);
      if (!matching) throw new OutboxRelayListError();
      matching.push(event);
    }
    // Verify every batch member before writing any cache row.
    return new Map([...grouped].map(([author, events]) => [author, selectOutboxRelayList(events, author)]));
  }
  async function forEachAuthor(authors: readonly string[], action: (author: string) => Promise<void>, index = 0): Promise<void> {
    const author = authors[index];
    if (author === undefined) return;
    await action(author);
    return forEachAuthor(authors, action, index + 1);
  }
  async function resolveReadBatch(userInput: string, authorInputs: readonly string[], signal: AbortSignal,
    assertActive: () => void, timeoutMs: number): Promise<ReadonlyMap<string, OutboxAuthorResolution>> {
    const user = publicKey(userInput), authors = [...new Set(authorInputs.map(publicKey))];
    if (authors.length > OUTBOX_LIST_LIMITS.authors || !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 || timeoutMs > QUERY_LIMITS.timeoutMs) throw new OutboxRelayListError();
    const startedAt = now();
    return leased(user, signal, assertActive, async scope => {
      const results = new Map<string, OutboxAuthorResolution>(), cold = new Map<string, CachedList>();
      await forEachAuthor(authors, async author => {
        const cached = await cachedList(scope, author);
        if (cached.age === 'fresh') results.set(author, fromCache(cached.list, false));
        else cold.set(author, cached);
      });
      const waiting = [...cold.keys()];
      for (let start = 0; start < waiting.length; start += OUTBOX_QUERY_FILTERS) {
        const batch = waiting.slice(start, start + OUTBOX_QUERY_FILTERS);
        const remaining = timeoutMs - (now() - startedAt);
        const share = Math.floor(remaining / Math.ceil((waiting.length - start) / OUTBOX_QUERY_FILTERS));
        // Leave part of the planning lease for a verified partial reply and cache checks.
        const budget = share - Math.min(100, Math.max(1, Math.floor(share / 10)));
        let fetched: RelayQueryResult;
        try {
          if (budget < 1) throw new RelayQueryError('relay discovery timed out');
          const filters = batch.map(author => ({authors:[author], kinds:[10002], limit:1}));
          fetched = await discovery.queryDetailed(filters, scope.signal, scope.active,
            {maximumFilters:OUTBOX_QUERY_FILTERS, timeoutMs:budget, allowPartialOnLimit:true});
        } catch (error) {
          scope.active();
          if (!(error instanceof RelayQueryError) || error instanceof RelayQueryDataError) throw error;
          for (const author of batch) {
            const cached = cold.get(author)!;
            results.set(author, fromCache(cached.age === 'expired' ? null : cached.list, true));
          }
          continue;
        }
        scope.active();
        const observed = byAuthor(fetched, batch);
        await forEachAuthor(batch, async author => {
          // A bounded multi-author response can omit members. Never negative-cache those omissions.
          results.set(author, await observedList(scope, author, cold.get(author)!, observed.get(author)!, fetched.incomplete, 'read', false));
        });
      }
      return results;
    }, timeoutMs);
  }
  return Object.freeze({
    async resolve(userInput: string, authorInput: string, purpose: 'read' | 'publication', signal: AbortSignal, assertActive: () => void, refresh = false) {
      const user = publicKey(userInput), author = publicKey(authorInput);
      if (purpose !== 'read' && purpose !== 'publication') throw new OutboxRelayListError();
      return leased(user, signal, assertActive, async scope => {
        const cached = await cachedList(scope, author);
        if (cached.age === 'fresh' && !refresh) return fromCache(cached.list, false);
        const filters = parseQueryFilters([{authors:[author], kinds:[10002], limit:32}]);
        let fetched: RelayQueryResult;
        try { fetched = await discovery.queryDetailed(filters, scope.signal, scope.active); }
        catch (error) {
          scope.active();
          if (purpose === 'read' && cached.age !== 'expired' && error instanceof RelayQueryError && !(error instanceof RelayQueryDataError)) {
            return fromCache(cached.list, true);
          }
          throw new OutboxRelayListError();
        }
        scope.active();
        const observed = selectOutboxRelayList(fetched.events.map(row => row.event), author);
        return observedList(scope, author, cached, observed, fetched.incomplete, purpose, true);
      });
    },
    resolveReadBatch,
  });
}
