import type { DetailedRelayQueryService } from '../network/native-relay-query.ts';
import { parseQueryFilters, QUERY_LIMITS, RelayQueryDataError, RelayQueryError } from '../network/relay-query-contract.ts';
import { publicKey } from '../storage/codec.ts';
import type { OutboxRelayListCache } from './relay-list-cache.ts';
import { OutboxRelayListError, outboxListAge, parseOutboxRelayList, selectOutboxRelayList, type OutboxRelayList } from './relay-list.ts';

export type OutboxAuthorResolution = Readonly<{ list: OutboxRelayList | null; source: 'cache' | 'nip65'; incomplete: boolean }>;
export interface OutboxAuthorResolver {
  resolve(user: string, author: string, purpose: 'read' | 'publication', signal: AbortSignal, assertActive: () => void, refresh?: boolean): Promise<OutboxAuthorResolution>;
}
/** Discovery service is constructed by the shell using trusted Lookup settings. */
export function createOutboxAuthorResolver(cache: OutboxRelayListCache, discovery: DetailedRelayQueryService,
  now: () => number = Date.now): OutboxAuthorResolver {
  let pending = 0;
  return Object.freeze({
    async resolve(userInput: string, authorInput: string, purpose: 'read' | 'publication', signal: AbortSignal, assertActive: () => void, refresh = false) {
      const user = publicKey(userInput), author = publicKey(authorInput);
      if ((purpose !== 'read' && purpose !== 'publication') || pending >= QUERY_LIMITS.concurrent) throw new OutboxRelayListError();
      const controller = new AbortController(), stop = () => controller.abort();
      const active = () => { assertActive(); if (signal.aborted || controller.signal.aborted) throw new OutboxRelayListError(); };
      active(); pending++;
      signal.addEventListener('abort', stop, { once: true });
      const timer = setTimeout(stop, QUERY_LIMITS.timeoutMs);
      let rejectCancelled!: () => void;
      const cancelled = new Promise<never>((_, reject) => { rejectCancelled = () => reject(new OutboxRelayListError()); });
      controller.signal.addEventListener('abort', rejectCancelled, { once: true });
      async function work(): Promise<OutboxAuthorResolution> {
        active();
        const stored = await cache.read(user, author, active, controller.signal); active();
        const cached = stored?.event ? parseOutboxRelayList(stored.event, author) : null;
        const age = stored ? outboxListAge(stored.fetchedAt, now()) : 'expired';
        if (stored && age === 'fresh' && !refresh) return Object.freeze({list: cached, source: 'cache', incomplete: false});
        const filters = parseQueryFilters([{authors: [author], kinds: [10002], limit: 32}]);
        let fetched;
        try { fetched = await discovery.queryDetailed(filters, controller.signal, active); }
        catch (error) {
          active();
          if (purpose === 'read' && stored && age !== 'expired' && error instanceof RelayQueryError && !(error instanceof RelayQueryDataError)) {
            return Object.freeze({list: cached, source: 'cache', incomplete: true});
          }
          throw new OutboxRelayListError();
        }
        active();
        const observed = selectOutboxRelayList(fetched.events.map(row => row.event), author);
        // Incomplete or empty discovery does not extend a known signed list's lifetime.
        if (fetched.incomplete) {
          if (purpose === 'publication') throw new OutboxRelayListError();
          const selected = selectOutboxRelayList([...(cached && age !== 'expired' ? [cached.event] : []), ...(observed ? [observed.event] : [])], author);
          return Object.freeze({list: selected, source: 'nip65', incomplete: true});
        }
        if (!observed && cached) {
          return Object.freeze({list: purpose === 'read' && age !== 'expired' ? cached : null, source: 'nip65', incomplete: true});
        }
        const checkedAt = now(); outboxListAge(checkedAt, checkedAt);
        await cache.write(user, author, {event: observed?.event ?? null, fetchedAt: checkedAt}, active, controller.signal);
        active();
        const saved = await cache.read(user, author, active, controller.signal); active();
        if (!saved) throw new OutboxRelayListError();
        return Object.freeze({list: saved.event ? parseOutboxRelayList(saved.event, author) : null, source: 'nip65', incomplete: false});
      }
      try { const result = await Promise.race([work(), cancelled]); active(); return result; }
      finally {
        clearTimeout(timer); signal.removeEventListener('abort', stop);
        controller.signal.removeEventListener('abort', rejectCancelled); controller.abort(); pending--;
      }
    },
  });
}
