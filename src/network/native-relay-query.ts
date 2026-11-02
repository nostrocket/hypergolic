import type { NostrEvent } from 'nostr-tools/pure';
import type { NativePublishedRelayPort } from '../napplets/native-published-relay.ts';
import { parsePublishedRelayMessage } from '../napplets/published-relay-wire.ts';
import { normalizeRelayUrl, MAX_RELAYS_PER_ROLE } from './relay-settings.ts';
import { utf8Bytes } from '../storage/codec.ts';
import { parseQueryFilters, QUERY_LIMITS, RelayQueryDataError, RelayQueryError, selectQueryEvents, verifyQueryEvent, type QueryFilter } from './relay-query-contract.ts';

export interface RelayQueryService {
  query(filters: readonly QueryFilter[], signal: AbortSignal, assertActive: () => void): Promise<readonly Readonly<{ event: NostrEvent }>[]>;
}
export type RelayQueryResult = Readonly<{ events: readonly Readonly<{ event: NostrEvent }>[]; incomplete: boolean; relayHints?: Readonly<Record<string, readonly string[]>> }>;
export interface DetailedRelayQueryService extends RelayQueryService {
  queryDetailed(filters: readonly QueryFilter[], signal: AbortSignal, assertActive: () => void): Promise<RelayQueryResult>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function parseFrames(input: unknown, subscription: string, filters: readonly QueryFilter[]): NostrEvent[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > QUERY_LIMITS.frames) throw new RelayQueryError();
  let eose = false, bytes = 0;
  const events: NostrEvent[] = [];
  for (const frame of input) {
    if (typeof frame !== 'string' || eose || (bytes += utf8Bytes(frame)) > 2 * 1024 * 1024) throw new RelayQueryError();
    const message = parsePublishedRelayMessage(frame, subscription);
    if (message.type === 'eose') eose = true;
    else if (message.type === 'event') {
      if (events.length >= QUERY_LIMITS.events) throw new RelayQueryError();
      events.push(verifyQueryEvent(message.event, filters));
    } else if (message.type !== 'notice' && message.type !== 'auth') throw new RelayQueryError();
  }
  if (!eose) throw new RelayQueryError();
  return events;
}
type Aggregation={bytes:number;limited:boolean;sizes:Map<string,number>};
function retainEvent(events:Map<string,NostrEvent>,hints:Map<string,Set<string>>,event:NostrEvent,relay:string,state:Aggregation,partial:boolean) {
  if(events.has(event.id)){hints.get(event.id)!.add(relay);return;}
  const size=utf8Bytes(JSON.stringify(event));
  if(!partial&&(events.size>=QUERY_LIMITS.events||state.bytes+size>QUERY_LIMITS.resultBytes))throw new RelayQueryDataError();
  events.set(event.id,event);hints.set(event.id,new Set([relay]));state.sizes.set(event.id,size);state.bytes+=size;
  while(events.size>QUERY_LIMITS.events||state.bytes>QUERY_LIMITS.resultBytes) {
    state.limited=true;
    const last=[...events.values()].sort((a,b)=>a.created_at-b.created_at||(a.id<b.id?1:a.id>b.id?-1:0))[0]!;
    events.delete(last.id);hints.delete(last.id);state.bytes-=state.sizes.get(last.id)!;state.sizes.delete(last.id);
  }
}
/** App-side only. Destinations come from trusted Network settings, never guest JSON. */
export function createNativeRelayQuery(port: Pick<NativePublishedRelayPort, 'newInstanceId' | 'queryPublishedRelay' | 'cancelPublishedRelay'>,
  destinations: () => readonly string[], timeoutMs: number = QUERY_LIMITS.timeoutMs, options:Readonly<{allowPartialOnLimit?:boolean}> = {}): DetailedRelayQueryService {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > QUERY_LIMITS.timeoutMs) throw new RelayQueryError();
  let concurrent = 0;
  async function runQuery(input: readonly QueryFilter[], signal: AbortSignal, assertActive: () => void, partialAtDeadline: boolean): Promise<RelayQueryResult> {
      const filters = parseQueryFilters(input);
      const configured = destinations();
      if (!Array.isArray(configured) || configured.length < 1 || configured.length > MAX_RELAYS_PER_ROLE) throw new RelayQueryError('relay query unavailable');
      const relays = configured.map(normalizeRelayUrl);
      if (new Set(relays).size !== relays.length || concurrent >= QUERY_LIMITS.concurrent) throw new RelayQueryError('relay query busy');
      const active = () => { if (signal.aborted) throw new RelayQueryError('relay query cancelled'); assertActive(); };
      active();
      concurrent++;
      const controller = new AbortController();
      const cancelledSignal = controller.signal;
      let pending: string | null = null;
      const used = new Set<string>();
      const cancel = () => {
        controller.abort();
        const operation = pending; pending = null;
        if (operation !== null) { try { port.cancelPublishedRelay(operation); } catch { /* Native deadline remains the backstop. */ } }
      };
      const events = new Map<string, NostrEvent>(), hints = new Map<string, Set<string>>();
      const result = (incomplete: boolean): RelayQueryResult => Object.freeze({events:selectQueryEvents([...events.values()],filters),incomplete,...(hints.size ? {relayHints:Object.freeze(Object.fromEntries([...hints].map(([id,relays]) => [id,Object.freeze([...relays])]))) } : {})});
      let successes = 0, invalidData = false, deadline = false;
      const aggregation:Aggregation={bytes:0,limited:false,sizes:new Map()};
      const timer = setTimeout(() => {deadline = true; cancel();}, timeoutMs);
      signal.addEventListener('abort', cancel, { once: true });
      let stop!: () => void;
      const cancelled = new Promise<RelayQueryResult>((resolve, reject) => {stop = () => {
        try {active(); if (partialAtDeadline && deadline && successes > 0) {resolve(result(true)); return;}}
        catch { /* External revocation never receives partial data. */ }
        reject(new RelayQueryError('relay query cancelled or timed out'));
      };});
      cancelledSignal.addEventListener('abort', stop, { once: true });
      try {
        if (signal.aborted) cancel();
        const work = async () => {
          for (const relay of relays) {
            active();
            if (cancelledSignal.aborted) throw new RelayQueryError();
            const operation = port.newInstanceId();
            if (!uuid.test(operation) || used.has(operation)) throw new RelayQueryError();
            used.add(operation);
            const subscription = 'query_' + operation.replaceAll('-', '');
            const wire = JSON.stringify(['REQ', subscription, ...filters]);
            pending = operation;
            let batch: NostrEvent[];
            try {
              active();
              const frames = await port.queryPublishedRelay(operation, relay, wire, subscription);
              active();
              if (cancelledSignal.aborted) throw new RelayQueryError();
              try {batch = parseFrames(frames, subscription, filters);} catch {invalidData = true; throw new RelayQueryDataError();}
            } catch {
              active();
              if (cancelledSignal.aborted) throw new RelayQueryError();
              continue;
            } finally { if (pending === operation) pending = null; }
            for (const event of batch) retainEvent(events,hints,event,relay,aggregation,partialAtDeadline&&options.allowPartialOnLimit===true);
            successes++;
          }
          active();
          if (successes === 0) {if (invalidData) throw new RelayQueryDataError(); throw new RelayQueryError();}
          return result(aggregation.limited || successes !== relays.length);
        };
        return await Promise.race([work(), cancelled]);
      } finally {
        cancel(); clearTimeout(timer); signal.removeEventListener('abort', cancel);
        cancelledSignal.removeEventListener('abort', stop); concurrent--;
      }
  }
  return Object.freeze({
    queryDetailed(input: readonly QueryFilter[], signal: AbortSignal, active: () => void) {return runQuery(input, signal, active, true);},
    async query(filters: readonly QueryFilter[], signal: AbortSignal, assertActive: () => void) {
      return (await runQuery(filters, signal, assertActive, false)).events;
    },
  });
}
