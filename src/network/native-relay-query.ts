import type { CatalogRelayReader } from '../napplets/catalog-paging.ts';
import type { NostrEvent } from 'nostr-tools/pure';
import type { NativePublishedRelayPort } from '../napplets/native-published-relay.ts';
import { parsePublishedRelayMessage } from '../napplets/published-relay-wire.ts';
import { normalizeRelayUrl, MAX_RELAYS_PER_ROLE } from './relay-settings.ts';
import { utf8Bytes } from '../storage/codec.ts';
import { OUTBOX_QUERY_COUNTS, parseQueryFilters, QUERY_LIMITS, RelayQueryDataError, RelayQueryError, relayQueryWire, selectQueryEvents, verifyQueryEvent, type QueryFilter } from './relay-query-contract.ts';

export interface RelayQueryService {
  readonly catalog?: CatalogRelayReader;
  query(filters: readonly QueryFilter[], signal: AbortSignal, assertActive: () => void): Promise<readonly Readonly<{ event: NostrEvent }>[]>;
}
export type RelayQueryResult = Readonly<{ events: readonly Readonly<{ event: NostrEvent }>[]; incomplete: boolean; relayHints?: Readonly<Record<string, readonly string[]>> }>;
type DetailedQueryOptions = Readonly<{maximumFilters?: number; timeoutMs?: number; allowPartialOnLimit?: boolean; allowSearch?: boolean}>;
export interface DetailedRelayQueryService extends RelayQueryService {
  queryDetailed(filters: readonly QueryFilter[], signal: AbortSignal, assertActive: () => void, options?: DetailedQueryOptions): Promise<RelayQueryResult>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type QueryCounts = Readonly<{events: number; frames: number}>;
function parseFrames(input: unknown, subscription: string, filters: readonly QueryFilter[], counts: QueryCounts, checkDeadline?: () => void): NostrEvent[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > counts.frames) throw new RelayQueryError();
  let eose = false, bytes = 0;
  const events: NostrEvent[] = [];
  for (const frame of input) {
    checkDeadline?.();
    if (typeof frame !== 'string' || eose || (bytes += utf8Bytes(frame)) > 2 * 1024 * 1024) throw new RelayQueryError();
    const message = parsePublishedRelayMessage(frame, subscription);
    if (message.type === 'eose') eose = true;
    else if (message.type === 'event') {
      if (events.length >= counts.events) throw new RelayQueryError();
      events.push(verifyQueryEvent(message.event, filters));
    } else if (message.type !== 'notice' && message.type !== 'auth') throw new RelayQueryError();
  }
  checkDeadline?.();
  if (!eose) throw new RelayQueryError();
  return events;
}
type Aggregation={maximumEvents:number;bytes:number;limited:boolean;sizes:Map<string,number>;partial:boolean;ranked:boolean};
function forgetEvent(events: Map<string, NostrEvent>, hints: Map<string, Set<string>>, id: string, state: Aggregation) {
  events.delete(id); hints.delete(id); state.bytes -= state.sizes.get(id)!; state.sizes.delete(id);
}
function selectBatch(events: Map<string, NostrEvent>, hints: Map<string, Set<string>>,
  batch: readonly NostrEvent[], filters: readonly QueryFilter[], state: Aggregation) {
  const candidates = new Map(events);
  for (const event of batch) candidates.set(event.id, event);
  const selected = new Set(selectQueryEvents([...candidates.values()], filters).map(row => row.event.id));
  for (const id of events.keys()) if (!selected.has(id)) forgetEvent(events, hints, id, state);
  return batch.filter(event => selected.has(event.id));
}
function retainEvent(events:Map<string,NostrEvent>,hints:Map<string,Set<string>>,event:NostrEvent,relay:string,state:Aggregation) {
  if(events.has(event.id)){hints.get(event.id)!.add(relay);return;}
  const size=utf8Bytes(JSON.stringify(event));
  if(events.size>=state.maximumEvents||state.bytes+size>QUERY_LIMITS.resultBytes) {
    if(!state.partial) throw new RelayQueryDataError();
    if(state.ranked) {state.limited=true;return;} // Keep only the leading ranked prefix.
  }
  events.set(event.id,event);hints.set(event.id,new Set([relay]));state.sizes.set(event.id,size);state.bytes+=size;
  while(events.size>state.maximumEvents||state.bytes>QUERY_LIMITS.resultBytes) {
    state.limited=true;
    const last=[...events.values()].sort((a,b)=>a.created_at-b.created_at||(a.id<b.id?1:a.id>b.id?-1:0))[0]!;
    forgetEvent(events, hints, last.id, state);
  }
}
function queryLifetime(signal: AbortSignal, active: () => void, budget: number, enforceClock: boolean,
  cancelOperation: (operation: string) => void, partialResult: () => RelayQueryResult | undefined) {
  const controller = new AbortController();
  const expiresAt = enforceClock ? performance.now() + budget : 0;
  let pending: string | null = null;
  let deadline = false;
  const cancel = () => {
    controller.abort();
    const operation = pending; pending = null;
    if (operation !== null) {
      try { cancelOperation(operation); } catch { /* Native deadline remains the backstop. */ }
    }
  };
  const expire = () => {deadline = true; cancel();};
  const timer = setTimeout(expire, budget);
  signal.addEventListener('abort', cancel, {once:true});
  let stop!: () => void;
  const cancelled = new Promise<RelayQueryResult>((resolve, reject) => {stop = () => {
    try {
      active();
      const partial = deadline ? partialResult() : undefined;
      if (partial) {resolve(partial); return;}
    } catch { /* External revocation never receives partial data. */ }
    reject(new RelayQueryError('relay query cancelled or timed out'));
  };});
  controller.signal.addEventListener('abort', stop, {once:true});
  if (signal.aborted) cancel();
  return {
    cancelled,
    aborted: () => controller.signal.aborted,
    track(operation: string) { pending = operation; },
    complete(operation: string) { if (pending === operation) pending = null; },
    checkDeadline: enforceClock ? () => {
      if (performance.now() < expiresAt) return;
      expire();
      throw new RelayQueryError('relay query timed out');
    } : undefined,
    close() {
      cancel(); clearTimeout(timer); signal.removeEventListener('abort', cancel);
      controller.signal.removeEventListener('abort', stop);
    },
  };
}
/** App-side only. Destinations come from trusted Network settings, never guest JSON. */
export function createNativeRelayQuery(port: Pick<NativePublishedRelayPort, 'newInstanceId' | 'queryPublishedRelay' | 'cancelPublishedRelay'>,
  destinations: () => readonly string[], timeoutMs: number = QUERY_LIMITS.timeoutMs, options:Readonly<{allowPartialOnLimit?:boolean;outbox?:true}> = {}): DetailedRelayQueryService {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > QUERY_LIMITS.timeoutMs) throw new RelayQueryError();
  const counts = options.outbox ? OUTBOX_QUERY_COUNTS : QUERY_LIMITS;
  let concurrent = 0;
  function configuredRelays(): string[] {
    const configured = destinations();
    if (!Array.isArray(configured) || configured.length < 1 || configured.length > MAX_RELAYS_PER_ROLE) throw new RelayQueryError('relay query unavailable');
    const relays = configured.map(normalizeRelayUrl);
    if (new Set(relays).size !== relays.length) throw new RelayQueryError('relay query unavailable');
    return relays;
  }
  async function runQuery(input: readonly QueryFilter[], signal: AbortSignal, assertActive: () => void, partialAtDeadline: boolean,
    catalogRelay?: string, detailed?: DetailedQueryOptions): Promise<RelayQueryResult> {
      const wireFilters = parseQueryFilters(input, counts.events, detailed?.maximumFilters, detailed?.allowSearch, counts.events);
      const {search, ...structuredFilter} = wireFilters[0]!;
      const ranked = search !== undefined;
      const filters = ranked ? [structuredFilter] : wireFilters;
      const budget = detailed?.timeoutMs ?? timeoutMs;
      if (!Number.isSafeInteger(budget) || budget < 1 || budget > timeoutMs) throw new RelayQueryError();
      const configured = configuredRelays();
      const relays = catalogRelay === undefined ? configured : configured.filter(relay => relay === catalogRelay);
      if (ranked && relays.length !== 1) throw new RelayQueryError();
      if (relays.length === 0 || concurrent >= QUERY_LIMITS.concurrent) throw new RelayQueryError('relay query busy');
      const active = () => { if (signal.aborted) throw new RelayQueryError('relay query cancelled'); assertActive(); };
      active();
      concurrent++;
      const used = new Set<string>();
      const events = new Map<string, NostrEvent>(), hints = new Map<string, Set<string>>();
      const result = (incomplete: boolean): RelayQueryResult => Object.freeze({events:ranked
        ? Object.freeze(Array.from(events.values(),event => Object.freeze({event})))
        : selectQueryEvents([...events.values()],filters),incomplete,...(hints.size ? {relayHints:Object.freeze(Object.fromEntries([...hints].map(([id,relays]) => [id,Object.freeze([...relays])]))) } : {})});
      let successes = 0, invalidData = false;
      const aggregation:Aggregation={maximumEvents:counts.events,bytes:0,limited:false,sizes:new Map(),ranked,
        partial:partialAtDeadline && (detailed?.allowPartialOnLimit ?? options.allowPartialOnLimit) === true};
      const lifetime = queryLifetime(signal, active, budget, options.outbox === true,
        operation => port.cancelPublishedRelay(operation), () => partialAtDeadline && successes > 0 ? result(true) : undefined);
      const {checkDeadline} = lifetime;
      try {
        const work = async () => {
          for (const relay of relays) {
            active();
            checkDeadline?.();
            if (lifetime.aborted()) throw new RelayQueryError();
            const operation = port.newInstanceId();
            if (!uuid.test(operation) || used.has(operation)) throw new RelayQueryError();
            used.add(operation);
            const subscription = 'query_' + operation.replaceAll('-', '');
            const wire = relayQueryWire(subscription, wireFilters);
            lifetime.track(operation);
            let batch: NostrEvent[];
            try {
              active();
              checkDeadline?.();
              const frames = await port.queryPublishedRelay(operation, relay, wire, subscription);
              active();
              if (lifetime.aborted()) throw new RelayQueryError();
              try {
                batch = parseFrames(frames, subscription, filters, counts, checkDeadline);
                if (catalogRelay !== undefined && new Set(batch.map(event => event.id)).size !== batch.length) throw new RelayQueryDataError();
              } catch (error) {
                if (lifetime.aborted()) throw error;
                invalidData = true;
                throw new RelayQueryDataError();
              }
            } catch {
              active();
              if (lifetime.aborted()) throw new RelayQueryError();
              continue;
            } finally { lifetime.complete(operation); }
            // Wide queries can receive a different revision per author from each relay.
            // Enforce per-filter limits before the aggregate cap can crowd out other authors.
            if (filters.length > QUERY_LIMITS.filters) batch = selectBatch(events, hints, batch, filters, aggregation);
            for (const event of batch) {
              if (ranked && (aggregation.limited || events.size >= (structuredFilter.limit as number))) break;
              retainEvent(events,hints,event,relay,aggregation);
            }
            successes++;
          }
          active();
          checkDeadline?.();
          if (successes === 0) {if (invalidData) throw new RelayQueryDataError(); throw new RelayQueryError();}
          return result(aggregation.limited || successes !== relays.length);
        };
        return await Promise.race([work(), lifetime.cancelled]);
      } finally {
        lifetime.close(); concurrent--;
      }
  }
  return Object.freeze({
    catalog: Object.freeze({
      destinations: configuredRelays,
      async read(relay: string, filter: QueryFilter, signal: AbortSignal, active: () => void) {
        return (await runQuery([filter], signal, active, false, relay)).events;
      },
    }),
    queryDetailed(input: readonly QueryFilter[], signal: AbortSignal, active: () => void, detailed?: DetailedQueryOptions) {return runQuery(input, signal, active, true, undefined, detailed);},
    async query(filters: readonly QueryFilter[], signal: AbortSignal, assertActive: () => void) {
      return (await runQuery(filters, signal, assertActive, false)).events;
    },
  });
}
