import type { QueryBatchVerifier } from './native-event-verifier.ts';
import type { NostrEvent } from 'nostr-tools/pure';
import type { NativePublishedRelayPort } from '../napplets/native-published-relay.ts';
import { parsePublishedRelayMessage } from '../napplets/published-relay-wire.ts';
import { normalizeRelayUrl, MAX_RELAYS_PER_ROLE } from './relay-settings.ts';
import { utf8Bytes } from '../storage/codec.ts';
import { OUTBOX_QUERY_COUNTS, parseQueryFilters, QUERY_LIMITS, RelayQueryBusyError, RelayQueryDataError, RelayQueryError, relayQueryWire, selectQueryEvents, captureQueryEvent, verifyQueryEvent, type QueryFilter } from './relay-query-contract.ts';

export interface RelayQueryService {
  readonly destinations?: () => readonly string[];
  query(filters: readonly QueryFilter[], signal: AbortSignal, assertActive: () => void): Promise<readonly Readonly<{ event: NostrEvent }>[]>;
  queryDetailed?(filters: readonly QueryFilter[], signal: AbortSignal, assertActive: () => void, options?: DetailedQueryOptions): Promise<RelayQueryResult>;
}
export type RelayQueryResult = Readonly<{ events: readonly Readonly<{ event: NostrEvent }>[]; incomplete: boolean; relayHints?: Readonly<Record<string, readonly string[]>>; failedRelays?: readonly string[]; reachableRelays?: readonly string[] }>;
type DetailedQueryOptions = Readonly<{maximumFilters?: number; timeoutMs?: number; allowPartialOnLimit?: boolean; allowSearch?: boolean; completeRelays?: true}>;
export interface DetailedRelayQueryService extends RelayQueryService {
  queryDetailed(filters: readonly QueryFilter[], signal: AbortSignal, assertActive: () => void, options?: DetailedQueryOptions): Promise<RelayQueryResult>;
}
type NativeQueryPort = Pick<NativePublishedRelayPort, 'newInstanceId' | 'cancelPublishedRelay'> & {
  queryPublishedRelay(operationId: string, url: string, request: string, subId: string, timeoutMs?: number): Promise<string[]>;
};
type AdmitPeer = (signal: AbortSignal, active: () => void) => Promise<() => void>;
type PeerRequest = Readonly<{operation: string; relay: string; wire: string; subscription: string}>;
function completePeerBudget(budget: number, peers: number, remaining: number): number {
  const share = Math.floor(budget / (Math.ceil(peers / 2) * 2));
  // Small sets need room for the native 3s idle timer plus connection setup.
  // The query's unchanged total deadline still bounds retries and queued peers.
  const nativeWindow = peers <= 5 ? Math.min(4000, Math.floor(budget / 3)) : 0;
  return Math.max(1, Math.min(5000, Math.max(share, nativeWindow), remaining));
}
function knownTransportFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    'code' in error && error.code === 'ERR_RELAY_TRANSPORT';
}
async function boundedPeerRead(port: NativeQueryPort, request: PeerRequest, budget: number, signal: AbortSignal): Promise<string[]> {
  const {operation, relay, wire, subscription} = request;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop!: () => void;
  const expired = new Promise<never>((_, reject) => {
    stop = () => reject(new RelayQueryError('relay query cancelled'));
    signal.addEventListener('abort', stop, {once: true});
    timer = setTimeout(() => {
      try {port.cancelPublishedRelay(operation);} catch { /* The native operation's own deadline remains the backstop. */ }
      // The opaque native call might already hold partial response bytes.
      reject(new RelayQueryError('relay peer timed out'));
    }, budget);
  });
  try {return await Promise.race([port.queryPublishedRelay(operation, relay, wire, subscription), expired]);}
  finally {clearTimeout(timer); signal.removeEventListener('abort', stop);}
}
function readPeerFrames(port: NativeQueryPort, request: PeerRequest, lifetime: ReturnType<typeof queryLifetime>,
  budget: number, peers: number, index: number, completeRelays: boolean, outbox: boolean): Promise<string[]> {
  if (completeRelays || (!outbox && peers > 1)) {
    const remaining=lifetime.remaining();
    const share=completeRelays ? completePeerBudget(budget,peers,remaining)
      : Math.max(1,Math.min(remaining,Math.floor(budget / (Math.ceil(peers / 2) + 1))));
    return boundedPeerRead(port, request, share, lifetime.signal);
  }
  const {operation,relay,wire,subscription}=request;
  return outbox ? port.queryPublishedRelay(operation,relay,wire,subscription,lifetime.peerBudget(peers-index))
    : port.queryPublishedRelay(operation,relay,wire,subscription);
}
type PeerRead = (relay: string, index: number) => Promise<'complete' | 'invalid' | 'failed'>;
async function readPeers(relays: readonly string[], readRelay: PeerRead, retry: boolean, workers: 1 | 2): Promise<void> {
  // Two peers leave native capacity for other reads. A failed connection gets
  // one fresh attempt; invalid frames never retry or contribute partial data.
  let next = 0;
  const worker = async () => {
    while (next < relays.length) {
      const index = next++, relay = relays[index]!;
      if (await readRelay(relay, index) === 'failed' && retry) await readRelay(relay, index);
    }
  };
  await Promise.all(Array.from({length: Math.min(workers, relays.length)}, worker));
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type QueryCounts = Readonly<{events: number; frames: number}>;
async function parseFrames(input: unknown, subscription: string, filters: readonly QueryFilter[], counts: QueryCounts, checkDeadline?: () => void, verify?: (events: readonly NostrEvent[]) => Promise<void>): Promise<NostrEvent[]> {
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
      events.push((verify ? captureQueryEvent : verifyQueryEvent)(message.event, filters));
    } else if (message.type !== 'notice' && message.type !== 'auth') throw new RelayQueryError();
  }
  checkDeadline?.();
  if (!eose) throw new RelayQueryError();
  if (verify && events.length) await verify(Object.freeze(events));
  checkDeadline?.();
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
function queryCollection(filters: readonly QueryFilter[], relays: readonly string[], aggregation: Aggregation, completeRelays: boolean) {
  const events = new Map<string, NostrEvent>(), hints = new Map<string, Set<string>>(), completed = new Set<string>();
  const transportFailures = new Set<string>();
  let invalid = false;
  const result = (incomplete: boolean): RelayQueryResult => Object.freeze({events: aggregation.ranked
    ? Object.freeze(Array.from(events.values(),event => Object.freeze({event})))
    : selectQueryEvents([...events.values()],filters),incomplete,
    ...(hints.size ? {relayHints:Object.freeze(Object.fromEntries([...hints].map(([id,sources]) => [id,Object.freeze(relays.filter(relay => sources.has(relay)))]))) } : {}),
    ...(completeRelays && incomplete && completed.size < relays.length
      ? {failedRelays:Object.freeze(relays.filter(relay => !completed.has(relay)))} : {}),
    ...(completeRelays && incomplete && completed.size > 0 && !invalid && !aggregation.limited && completed.size + transportFailures.size === relays.length
      ? {reachableRelays:Object.freeze(relays.filter(relay => completed.has(relay)))} : {})});
  return {
    result,
    completed: () => completed.size,
    failed(relay: string, malformed: boolean) {if (malformed) invalid = true; else transportFailures.add(relay);},
    accept(relay: string, batch: NostrEvent[]) {
      // Select before charging aggregate budgets: older rows outside the requested
      // newest results do not make that selected output partial.
      if (!aggregation.ranked) batch = selectBatch(events, hints, batch, filters, aggregation);
      for (const event of batch) {
        if (aggregation.ranked && (aggregation.limited || events.size >= (filters[0]!.limit as number))) break;
        retainEvent(events,hints,event,relay,aggregation);
      }
      completed.add(relay);
      transportFailures.delete(relay);
    },
  };
}
function queryLifetime(signal: AbortSignal, active: () => void, budget: number, enforceClock: boolean,
  cancelOperation: (operation: string) => void, partialResult: () => RelayQueryResult | undefined) {
  const controller = new AbortController();
  const expiresAt = performance.now() + budget;
  const pending = new Set<string>();
  let deadline = false;
  const cancel = () => {
    controller.abort();
    for (const operation of pending) {
      try { cancelOperation(operation); } catch { /* Native deadline remains the backstop. */ }
    }
    pending.clear();
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
    signal: controller.signal,
    remaining: () => Math.max(0, Math.floor(expiresAt - performance.now())),
    aborted: () => controller.signal.aborted,
    peerBudget(peers: number): number {
      const remaining = Math.floor(expiresAt - performance.now());
      if (remaining < 1) {expire();throw new RelayQueryError('relay query timed out');}
      // Reserve time for later peers without renewing the total deadline.
      return Math.max(1,Math.min(10_000,Math.floor(remaining / Math.min(2,peers))));
    },
    track(operation: string) { pending.add(operation); },
    complete(operation: string) { pending.delete(operation); },
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
export function createNativeRelayQuery(port: NativeQueryPort,
  destinations: () => readonly string[], timeoutMs: number = QUERY_LIMITS.timeoutMs, options:Readonly<{allowPartialOnLimit?:boolean;outbox?:true;admitPeer?:AdmitPeer;verifyBatch?:QueryBatchVerifier}> = {}): DetailedRelayQueryService {
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
  function prepare(input:readonly QueryFilter[],detailed?:DetailedQueryOptions) {
    const wireFilters = parseQueryFilters(input, counts.events, detailed?.maximumFilters, detailed?.allowSearch, counts.events);
    const {search, ...structuredFilter} = wireFilters[0]!;
    const ranked = search !== undefined;
    const filters = ranked ? [structuredFilter] : wireFilters;
    const budget = detailed?.timeoutMs ?? timeoutMs;
    if (!Number.isSafeInteger(budget) || budget < 1 || budget > timeoutMs) throw new RelayQueryError();
    const relays = configuredRelays();
    if (ranked && relays.length !== 1) throw new RelayQueryError();
    return {wireFilters,filters,ranked,budget,relays};
  }
  async function runQuery(input: readonly QueryFilter[], signal: AbortSignal, assertActive: () => void, partialAtDeadline: boolean,
    detailed?: DetailedQueryOptions): Promise<RelayQueryResult> {
      const {wireFilters,filters,ranked,budget,relays}=prepare(input,detailed);
      if (concurrent >= QUERY_LIMITS.concurrent) throw new RelayQueryBusyError();
      const active = () => { if (signal.aborted) throw new RelayQueryError('relay query cancelled'); assertActive(); };
      active();
      concurrent++;
      const used = new Set<string>();
      let invalidData = false;
      const aggregation:Aggregation={maximumEvents:counts.events,bytes:0,limited:false,sizes:new Map(),ranked,
        partial:partialAtDeadline && (detailed?.allowPartialOnLimit ?? options.allowPartialOnLimit) === true};
      const completeRelays = detailed?.completeRelays === true;
      const collection = queryCollection(filters, relays, aggregation, completeRelays), {result} = collection;
      const lifetime = queryLifetime(signal, active, budget, options.outbox === true || completeRelays,
        operation => port.cancelPublishedRelay(operation), () => partialAtDeadline && (collection.completed() > 0 || completeRelays) ? result(true) : undefined);
      const {checkDeadline} = lifetime;
      try {
        const readRelay: PeerRead = async (relay, index) => {
            active();
            checkDeadline?.();
            if (lifetime.aborted()) throw new RelayQueryError();
            const operation = port.newInstanceId();
            if (!uuid.test(operation) || used.has(operation)) throw new RelayQueryError();
            used.add(operation);
            const subscription = 'query_' + operation.replaceAll('-', '');
            const wire = relayQueryWire(subscription, wireFilters);
            let batch: NostrEvent[];
            try {
              const checkPeer = () => {
                active();
                checkDeadline?.();
                if (lifetime.aborted()) throw new RelayQueryError();
              };
              const release = options.admitPeer ? await options.admitPeer(lifetime.signal, checkPeer) : undefined;
              let frames: string[];
              try {
                checkPeer();
                lifetime.track(operation);
                frames = await readPeerFrames(port,{operation,relay,wire,subscription},lifetime,budget,relays.length,index,completeRelays,options.outbox===true);
              } finally {
                lifetime.complete(operation);
                release?.();
              }
              active();
              if (lifetime.aborted()) throw new RelayQueryError();
              try {
                batch = await parseFrames(frames, subscription, filters, counts, checkDeadline, options.verifyBatch
                  ? events => options.verifyBatch!(events,lifetime.signal,active,lifetime.remaining()) : undefined);
                active();
                if (lifetime.aborted()) throw new RelayQueryError();
              } catch (error) {
                if (lifetime.aborted()) throw error;
                invalidData = true;
                throw new RelayQueryDataError();
              }
            } catch (error) {
              active();
              if (lifetime.aborted()) throw new RelayQueryError();
              // Native rejection may also mean malformed or over-limit frames.
              // Only an explicit transport outcome can authorize excluding it.
              collection.failed(relay, !knownTransportFailure(error));
              return error instanceof RelayQueryDataError ? 'invalid' : 'failed';
            }
            collection.accept(relay, batch);
            return 'complete';
        };
        const work = async () => {
          // Outbox data reads share native admission. Standalone verification
          // callers without that pool retain their sequential dispatch contract.
          const workers = !options.outbox || completeRelays || options.admitPeer ? 2 : 1;
          await readPeers(relays, readRelay, completeRelays, workers);
          active();
          checkDeadline?.();
          if (collection.completed() === 0) {
            if (completeRelays) return result(true);
            if (invalidData) throw new RelayQueryDataError(); throw new RelayQueryError();
          }
          return result(aggregation.limited || collection.completed() !== relays.length);
        };
        return await Promise.race([work(), lifetime.cancelled]);
      } finally {
        lifetime.close(); concurrent--;
      }
  }
  return Object.freeze({
    destinations: configuredRelays,
    queryDetailed(input: readonly QueryFilter[], signal: AbortSignal, active: () => void, detailed?: DetailedQueryOptions) {return runQuery(input, signal, active, true, detailed);},
    async query(filters: readonly QueryFilter[], signal: AbortSignal, assertActive: () => void) {
      return (await runQuery(filters, signal, assertActive, false)).events;
    },
  });
}
