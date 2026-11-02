import {createNativeRelayQuery, type RelayQueryResult} from '../network/native-relay-query.ts';
import type {NativePublishedRelayPort} from '../napplets/native-published-relay.ts';
import type {RelaySettingsSnapshot} from '../network/relay-settings.ts';
import {QUERY_LIMITS} from '../network/relay-query-contract.ts';
import type {OutboxAuthorResolver} from './author-resolver.ts';
import {parseOutboxQuery, parseOutboxEvent, parseOutboxResolve, OutboxQueryError, type OutboxQueryRequest} from './query-contract.ts';
import {resolveOutboxPlan, type OutboxReadPlan} from './route-plan.ts';
export type {OutboxReadPlan} from './route-plan.ts';
export type OutboxEventRow = Readonly<RelayQueryResult['events'][number] & {sidecar?: Readonly<{relayHints: readonly string[]}>}>;
export type OutboxReadResult = Readonly<{events: readonly OutboxEventRow[]; incomplete: boolean; plan: OutboxReadPlan}>;
export type OutboxEventResult = Readonly<{result?: OutboxEventRow; incomplete?: true; error?: string}>;
export interface OutboxReadService {
  query(input: unknown, user: string, signal: AbortSignal, assertActive: () => void): Promise<OutboxReadResult>;
  getEvent?(input: unknown, user: string, signal: AbortSignal, assertActive: () => void): Promise<OutboxEventResult>;
  resolveRelays?(input: unknown, user: string, signal: AbortSignal, assertActive: () => void): Promise<OutboxReadPlan>;
  plan?(input: unknown, user: string, signal: AbortSignal, assertActive: () => void, refresh?: boolean): Promise<OutboxReadPlan>;
}
/** App-owned transport and settings are captured separately from parsed guest options. */
export function createOutboxReadService(resolver: OutboxAuthorResolver,
  native: Pick<NativePublishedRelayPort,'newInstanceId' | 'queryPublishedRelay' | 'cancelPublishedRelay'>,
  settings: () => RelaySettingsSnapshot, now: () => number = Date.now) {
  let pending = 0;
  async function bounded<T>(timeoutMs: number, signal: AbortSignal, assertActive: () => void,
    work: (signal: AbortSignal, active: () => void, remaining: () => number) => Promise<T>): Promise<T> {
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
    const remaining = () => {
      active(); const ms = timeoutMs - (now() - startedAt);
      if (!Number.isSafeInteger(ms) || ms < 1 || ms > timeoutMs) throw new OutboxQueryError('relay timeout');
      clearTimeout(timer); // Data transport now owns the same remaining deadline and may return verified partial data.
      return ms;
    };
    try {const result = await Promise.race([work(controller.signal,active,remaining),cancelled]); active(); return result;}
    finally {clearTimeout(timer);signal.removeEventListener('abort',stop);controller.signal.removeEventListener('abort',rejectCancelled);controller.abort();pending--;}
  }
  function route(request: OutboxQueryRequest, user: string, signal: AbortSignal, active: () => void, refresh = false) {
    const authors = new Set(request.options.authors);
    for (const filter of request.filters) for (const author of (filter.authors ?? []) as readonly string[]) authors.add(author);
    return resolveOutboxPlan(resolver,settings(),user,[...authors],request.options.relays,'read',signal,active,refresh);
  }
  async function query(input: unknown,user: string,signal: AbortSignal,assertActive: () => void): Promise<OutboxReadResult> {
    const request = parseOutboxQuery(input);
    return bounded(request.options.timeoutMs,signal,assertActive,async (leased,active,remaining) => {
      const plan = await route(request,user,leased,active); active();
      const transport = createNativeRelayQuery(native,() => plan.relays,remaining(),{allowPartialOnLimit:true});
      const result = await transport.queryDetailed(request.filters,leased,active); active();
      const events = result.events.slice(0,request.options.limit).map(row => {
        const hints = result.relayHints?.[row.event.id];
        return Object.freeze({...row,...(hints?.length ? {sidecar:Object.freeze({relayHints:hints})} : {})});
      });
      return Object.freeze({events:Object.freeze(events),incomplete:plan.incomplete || result.incomplete,plan});
    });
  }
  return Object.freeze({
    query,
    async getEvent(input: unknown,user: string,signal: AbortSignal,active: () => void): Promise<OutboxEventResult> {
      const request = parseOutboxEvent(input);
      const result = await query({type:'outbox.query',id:request.id,filters:{ids:[request.eventId],limit:1},
        options:{authors:request.options.author ? [request.options.author] : [],relays:request.options.relays,timeoutMs:request.options.timeoutMs,limit:1}},user,signal,active);
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
      const request = parseOutboxQuery(input);
      return bounded(request.options.timeoutMs,signal,assertActive,(leased,active) => route(request,user,leased,active,refresh));
    },
  });
}
