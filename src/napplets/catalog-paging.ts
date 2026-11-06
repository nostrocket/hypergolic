import type { NostrEvent } from 'nostr-tools/pure';
import { QUERY_LIMITS, type QueryFilter } from '../network/relay-query-contract.ts';
import { utf8Bytes } from '../storage/codec.ts';
import { CATALOG_PAGE_LIMIT, type CatalogPage, type CatalogPageRequest } from './catalog-page-contract.ts';

type EventRow = Readonly<{event: NostrEvent}>;
export type CatalogRelayReader = Readonly<{
  destinations(): readonly string[];
  read(relay: string, filter: QueryFilter, signal: AbortSignal, active: () => void): Promise<readonly EventRow[]>;
}>;
type Lane = Readonly<{relay: string; until: number; boundary: boolean; done: boolean; failed: boolean}>;
type Batch = Readonly<{lane: Lane; rows: readonly EventRow[]; gap: boolean}>;
type Position = Readonly<{lanes: readonly Lane[]; next: number; gap: boolean}>;
type State = {round: string; until: number; page: number; position: Position; pending: Readonly<{reply: CatalogPage; position: Position}> | null};
const PAGE_SIZE = 8;
const LANES_PER_PAGE = 2;
const MAX_ROUNDS = 64;

function selected(position: Position): number[] {
  const indexes: number[] = [];
  for (let offset = 0; offset < position.lanes.length && indexes.length < LANES_PER_PAGE; offset++) {
    const index = (position.next + offset) % position.lanes.length;
    if (!position.lanes[index]!.done) indexes.push(index);
  }
  return indexes;
}

async function readLane(reader: CatalogRelayReader, lane: Lane, signal: AbortSignal, active: () => void): Promise<Batch> {
  const limit = lane.boundary ? QUERY_LIMITS.events : PAGE_SIZE;
  let rows: readonly EventRow[];
  try {
    rows = await reader.read(lane.relay, {kinds: [35129], until: lane.until, limit,
      ...(lane.boundary ? {since: lane.until} : {})}, signal, active);
  } catch {
    active();
    return {lane: {...lane, failed: true}, rows: [], gap: false};
  }
  active();
  const oldest = rows.at(-1)?.event.created_at;
  const done = lane.boundary ? lane.until === 0 : oldest === undefined;
  const until = lane.boundary ? Math.max(0, lane.until - 1) : oldest ?? lane.until;
  return {lane: {relay: lane.relay, until, done, failed: false, boundary: !lane.boundary && oldest === lane.until},
    rows, gap: lane.boundary && rows.length === limit};
}

function combine(position: Position, indexes: readonly number[], batches: readonly Batch[]) {
  const lanes = [...position.lanes], rows = new Map<string, EventRow>();
  let gap = position.gap, bytes = 0, deferred: number | undefined;
  for (const [offset, batch] of batches.entries()) {
    const index = indexes[offset]!;
    const unique = batch.rows.filter(row => !rows.has(row.event.id));
    const size = unique.reduce((sum, row) => sum + utf8Bytes(JSON.stringify(row.event)), 0);
    // A lane whose rows could not fit has not been delivered. Give it first place next time.
    if (rows.size + unique.length > QUERY_LIMITS.events || bytes + size > QUERY_LIMITS.resultBytes) {
      deferred ??= index;
      continue;
    }
    for (const row of unique) rows.set(row.event.id, row);
    bytes += size; lanes[index] = batch.lane; gap ||= batch.gap;
  }
  const next = deferred ?? (indexes.at(-1)! + 1) % lanes.length;
  return {position: {lanes, next, gap}, events: [...rows.values()]};
}

/** One state machine per exact renderer generation. A page advances only when its recipient acknowledges it. */
export function createCatalogPaging(reader: CatalogRelayReader, now = () => Math.floor(Date.now() / 1000)) {
  let state: State | null = null, running = false;
  const rounds = new Set<string>();
  const activeScope = (current: State, active: () => void): void => {
    active();
    const configured = reader.destinations();
    if (configured.length !== current.position.lanes.length ||
        configured.some((relay, index) => relay !== current.position.lanes[index]!.relay)) throw Error('Catalog relay settings changed');
  };
  return async (request: CatalogPageRequest, signal: AbortSignal, assertActive: () => void): Promise<CatalogPage> => {
    if (running) throw Error('Catalog paging busy');
    running = true;
    const active = () => {if (signal.aborted) throw Error('Catalog paging cancelled'); assertActive();};
    try {
      active();
      if (request.reset && state?.round !== request.round) {
        if (rounds.has(request.round) || rounds.size >= MAX_ROUNDS) throw Error('Catalog paging round unavailable');
        const until = now(), configured = reader.destinations();
        if (!configured.length) throw Error('Catalog relay settings unavailable');
        rounds.add(request.round);
        state = {round: request.round, until, page: 0, pending: null, position: {next: 0, gap: false,
          lanes: configured.map(relay => ({relay, until, boundary: false, done: false, failed: false}))}};
      }
      if (!state || state.round !== request.round) throw Error('Catalog paging unavailable');
      const current = state;
      const check = () => activeScope(current, active);
      check();
      if (current.pending?.reply.page === request.after && current.pending.reply.more) {
        current.page = request.after; current.position = current.pending.position; current.pending = null;
      }
      if (request.after !== current.page) throw Error('Invalid catalog page acknowledgment');
      if (current.pending) return current.pending.reply;

      const indexes = selected(current.position);
      const batches = await Promise.allSettled(indexes.map(index => readLane(reader, current.position.lanes[index]!, signal, check)));
      check();
      const {position, events} = combine(current.position, indexes, batches.map(result => {
        if (result.status === 'rejected') throw Error('Catalog paging unavailable');
        return result.value;
      }));
      const page = current.page + 1, unfinished = position.lanes.some(lane => !lane.done);
      const bounded = unfinished && page === CATALOG_PAGE_LIMIT;
      const reply = Object.freeze({page, until: current.until, events, more: unfinished && !bounded,
        partial: position.lanes.some(lane => lane.failed), gap: position.gap, bounded});
      current.pending = {reply, position};
      return reply;
    } finally {running = false;}
  };
}
