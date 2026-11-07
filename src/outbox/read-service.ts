import {createNativeRelayQuery, type RelayQueryResult} from '../network/native-relay-query.ts';
import type {NativePublishedRelayPort} from '../napplets/native-published-relay.ts';
import type {RelaySettingsSnapshot} from '../network/relay-settings.ts';
import {utf8Bytes} from '../storage/codec.ts';
import {OUTBOX_QUERY_COUNTS, QUERY_LIMITS} from '../network/relay-query-contract.ts';
import type {OutboxAuthorResolver} from './author-resolver.ts';
import {OUTBOX_QUERY_FILTERS, capOutboxFilters, parseOutboxQuery, parseOutboxEvent, parseOutboxResolve, OutboxQueryError, type OutboxQueryRequest} from './query-contract.ts';
import {resolveOutboxPlan, type OutboxReadPlan, type OutboxReadPlanning} from './route-plan.ts';
export type {OutboxReadPlan} from './route-plan.ts';
export type OutboxEventRow = Readonly<RelayQueryResult['events'][number] & {sidecar?: Readonly<{relayHints: readonly string[]}>}>;
export type OutboxReadResult = Readonly<{events: readonly OutboxEventRow[]; incomplete: boolean; plan: OutboxReadPlan}>;
export type OutboxEventResult = Readonly<{result?: OutboxEventRow; incomplete?: true; error?: string}>;
export type NativeOutboxQueryPort = Pick<NativePublishedRelayPort, 'newInstanceId' | 'cancelPublishedRelay'> & {
  queryOutboxRelay(token: string, operationId: string, url: string, requestText: string, subscriptionId: string, timeoutMs: number): Promise<string[]>;
};
export interface OutboxReadService {
  query(input: unknown, user: string, signal: AbortSignal, assertActive: () => void, nativeToken: string): Promise<OutboxReadResult>;
  getEvent?(input: unknown, user: string, signal: AbortSignal, assertActive: () => void, nativeToken: string): Promise<OutboxEventResult>;
  resolveRelays?(input: unknown, user: string, signal: AbortSignal, assertActive: () => void): Promise<OutboxReadPlan>;
  plan?(input: unknown, user: string, signal: AbortSignal, assertActive: () => void, refresh?: boolean): Promise<OutboxReadPlan>;
}
const MAX_RELAY_HINT_BYTES = 256 * 1024;
function projectEvents(result: RelayQueryResult, limit: number): readonly OutboxEventRow[] {
  let remaining = MAX_RELAY_HINT_BYTES;
  return Object.freeze(result.events.slice(0,limit).map(row => {
    const hints = result.relayHints?.[row.event.id];
    if (!hints?.length) return row;
    const sidecar = Object.freeze({relayHints:hints});
    const bytes = utf8Bytes(JSON.stringify({sidecar}));
    if (bytes > remaining) return row;
    remaining -= bytes;
    return Object.freeze({...row,sidecar});
  }));
}
/** App-owned transport and settings are captured separately from parsed guest options. */
export function createOutboxReadService(resolver: OutboxAuthorResolver,
  native: NativeOutboxQueryPort,
  settings: () => RelaySettingsSnapshot, now: () => number = Date.now) {
  let pending = 0;
  async function bounded<T>(timeoutMs: number, signal: AbortSignal, assertActive: () => void,
    work: (signal: AbortSignal, active: () => void, remaining: (handoff?: boolean) => number) => Promise<T>): Promise<T> {
    if (pending >= QUERY_LIMITS.concurrent) throw new OutboxQueryError('relay timeout');
    const startedAt = now();
    if (!Number.isSafeInteger(startedAt) || startedAt < 0) throw new OutboxQueryError('relay timeout');
    const controller = new AbortController(), stop = () => controller.abort();
    const active = () => {assertActive(); if (signal.aborted || controller.signal.aborted) throw new OutboxQueryError('relay timeout');};
    active(); pending++; signal.addEventListener('abort',stop,{once:true});
    const timer = setTimeout(stop,timeoutMs);
    let rejectCancelled!: () => void;
    const cancelled = new Promise<never>((_,reject) => {rejectCancelled = () => reject(new OutboxQueryError('relay timeout'));});
    controller.signal.addEventListener('abort',rejectCancelled,{once:true});
    const remaining = (handoff = false) => {
      active(); const ms = timeoutMs - (now() - startedAt);
      if (!Number.isSafeInteger(ms) || ms < 1 || ms > timeoutMs) throw new OutboxQueryError('relay timeout');
      if (handoff) clearTimeout(timer); // Data transport now owns the same remaining deadline and may return verified partial data.
      return ms;
    };
    try {const result = await Promise.race([work(controller.signal,active,remaining),cancelled]); active(); return result;}
    finally {clearTimeout(timer);signal.removeEventListener('abort',stop);controller.signal.removeEventListener('abort',rejectCancelled);controller.abort();pending--;}
  }
  function route(request: OutboxQueryRequest, user: string, signal: AbortSignal, active: () => void, refresh = false, planning?: OutboxReadPlanning) {
    const search = request.filters[0]?.search !== undefined;
    const authors = new Set(search ? [] : request.options.authors);
    if (!search) for (const filter of request.filters) for (const author of (filter.authors ?? []) as readonly string[]) authors.add(author);
    const plan = resolveOutboxPlan(resolver,settings(),user,[...authors],request.options.relays,'read',signal,active,refresh,planning);
    // Search terms go only to the nominated peer, whose relevance ranking is local to that relay.
    if (!search) return plan;
    return plan.then(selected => {
      const relays = selected.relays.filter(relay => relay === request.options.relays[0]);
      if (relays.length !== 1) throw new OutboxQueryError('policy denied');
      return Object.freeze({...selected,relays:Object.freeze(relays),incomplete:false});
    });
  }
  async function query(input: unknown,user: string,signal: AbortSignal,assertActive: () => void, nativeToken: string): Promise<OutboxReadResult> {
    const request = parseOutboxQuery(input);
    if (!nativeToken) throw new OutboxQueryError('policy denied');
    return bounded(request.options.timeoutMs,signal,assertActive,async (leased,active,remaining) => {
      const wide = request.filters.length > QUERY_LIMITS.filters;
      const planning = {wide, timeoutMs:Math.max(1, Math.floor(remaining() / 2))};
      const plan = await route(request,user,leased,active,false,planning); active();
      const transport = createNativeRelayQuery({
        newInstanceId: () => native.newInstanceId(),
        queryPublishedRelay: (id, url, wire, sub, timeoutMs) => native.queryOutboxRelay(nativeToken,id,url,wire,sub,timeoutMs!),
        cancelPublishedRelay: id => native.cancelPublishedRelay(id),
      },() => plan.relays,remaining(true),{allowPartialOnLimit:true,outbox:true});
      const result = await transport.queryDetailed(capOutboxFilters(request.filters,OUTBOX_QUERY_COUNTS.events),leased,active,
        {maximumFilters:wide ? OUTBOX_QUERY_FILTERS : QUERY_LIMITS.filters, allowSearch:true}); active();
      const maximum = OUTBOX_QUERY_COUNTS.events;
      const capped = result.events.length === maximum &&
        (request.options.limit > maximum ||
          request.options.limit === maximum && request.filters.some(filter => (filter.limit as number) > maximum));
      const events = projectEvents(result, request.options.limit);
      return Object.freeze({events,incomplete:plan.incomplete || result.incomplete || capped,plan});
    });
  }
  return Object.freeze({
    query,
    async getEvent(input: unknown,user: string,signal: AbortSignal,active: () => void,nativeToken: string): Promise<OutboxEventResult> {
      const request = parseOutboxEvent(input);
      const result = await query({type:'outbox.query',id:request.id,filters:{ids:[request.eventId],limit:1},
        options:{authors:request.options.author ? [request.options.author] : [],relays:request.options.relays,timeoutMs:request.options.timeoutMs,limit:1}},user,signal,active,nativeToken);
      const row = result.events[0];
      if (row && row.event.id !== request.eventId) throw new OutboxQueryError('invalid filter');
      return Object.freeze({...(row ? {result:row} : {error:'not found'}),...(result.incomplete ? {incomplete:true as const} : {})});
    },
    async resolveRelays(input: unknown,user: string,signal: AbortSignal,assertActive: () => void): Promise<OutboxReadPlan> {
      const request = parseOutboxResolve(input);
      if (!request.target.authors.length) throw new OutboxQueryError('no authors');
      return bounded(QUERY_LIMITS.timeoutMs,signal,assertActive,(leased,active) =>
        resolveOutboxPlan(resolver,settings(),user,request.target.authors,[],request.target.direction,leased,active));
    },
    async plan(input: unknown,user: string,signal: AbortSignal,assertActive: () => void, refresh = false): Promise<OutboxReadPlan> {
      const request = parseOutboxQuery(input,OUTBOX_QUERY_FILTERS,false);
      return bounded(request.options.timeoutMs,signal,assertActive,(leased,active) => route(request,user,leased,active,refresh));
    },
  });
}
