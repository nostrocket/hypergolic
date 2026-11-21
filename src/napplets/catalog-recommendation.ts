import type {NostrEvent} from 'nostr-tools/pure';
import type {RelayQueryService} from '../network/native-relay-query.ts';
import {NATIVE_RELAY_REQUEST_BYTES, QUERY_LIMITS, verifyQueryEvent, type QueryFilter} from '../network/relay-query-contract.ts';
import {normalizeRelayUrl, MAX_RELAYS_PER_ROLE} from '../network/relay-settings.ts';
import {captureEventSnapshot, type EventSnapshot} from '../security/event-snapshot.ts';
import {publicKey, utf8Bytes} from '../storage/codec.ts';

const identifier = 'napplets';
const coordinatePattern = /^35129:[0-9a-f]{64}:.+$/u;
const validCoordinate = (value: unknown): value is string => typeof value === 'string' && value.length <= 512 &&
  coordinatePattern.test(value) && !/[\u0000-\u001f\u007f]/u.test(value);
export type CatalogRecommendationGuard = ((signal: AbortSignal, active: () => void) => Promise<void>) & {
  readonly destinations?: readonly string[];
  readonly excludedRelays?: readonly string[];
  /** true only when trusted approval bookkeeping proves no publication was dispatched. */
  release(allowRetry?: boolean): void;
};
type ReachableList = Readonly<{destinations: readonly string[]; excludedRelays: readonly string[]}>;
type Prepared = Readonly<{snapshot: EventSnapshot; revision: string | null; network: string; ticket: number; reachable?: ReachableList}>;
class RecommendationError extends Error {
  readonly status: 'unavailable' | 'incomplete' | 'stale' | 'read-only';
  readonly failedRelays?: readonly string[];
  constructor(status: RecommendationError['status'], failedRelays?: readonly string[]) {
    super(status);
    this.status = status;
    this.failedRelays = failedRelays;
  }
}
function fitsPublication(snapshot: EventSnapshot): boolean {
  const wire = {...snapshot.event, pubkey: snapshot.selectedPubkey, id: '0'.repeat(64), sig: '0'.repeat(128)};
  return utf8Bytes(JSON.stringify(['EVENT', wire])) <= NATIVE_RELAY_REQUEST_BYTES;
}

function validateCurrentList(event: NostrEvent, account: string, relays: readonly string[], now: number): void {
  let identifiers = 0;
  for (const tag of event.tags) {
    if (tag.length > 256) throw new RecommendationError('unavailable');
    if (tag[0] !== 'd') continue;
    identifiers++;
    if (tag.length !== 2 || tag[1] !== identifier) throw new RecommendationError('unavailable');
  }
  if (identifiers !== 1 || event.tags.length > 512 || event.created_at > now) throw new RecommendationError('unavailable');
  const template = {kind: event.kind, content: event.content, tags: event.tags, created_at: event.created_at};
  if (!fitsPublication(captureEventSnapshot(template, account, relays))) throw new RecommendationError('unavailable');
}
function reachablePartition(result: {reachableRelays?: readonly string[]; failedRelays?: readonly string[]}, configured: readonly string[]) {
  if (!result.reachableRelays?.length || !result.failedRelays?.length) return undefined;
  const destinations = result.reachableRelays.map(normalizeRelayUrl), excludedRelays = result.failedRelays.map(normalizeRelayUrl);
  const reached = new Set(destinations), excluded = new Set(excludedRelays);
  if (reached.size !== destinations.length || excluded.size !== excludedRelays.length || destinations.length + excludedRelays.length !== configured.length ||
      configured.some(relay => reached.has(relay) === excluded.has(relay)) ||
      JSON.stringify(destinations) !== JSON.stringify(configured.filter(relay => reached.has(relay))) ||
      JSON.stringify(excludedRelays) !== JSON.stringify(configured.filter(relay => excluded.has(relay)))) return undefined;
  return {destinations: Object.freeze(destinations.map(relay => new URL(relay).href)),
    excludedRelays: Object.freeze(excludedRelays.map(relay => new URL(relay).href))};
}

function createRecommendationReader(account: string, queries: RelayQueryService) {
  const filters: readonly QueryFilter[] = [{kinds: [30267], authors: [account], '#d': [identifier], limit: QUERY_LIMITS.events}];
  function destinations(): readonly string[] {
    const raw = queries.destinations?.();
    if (!raw?.length || raw.length > MAX_RELAYS_PER_ROLE) throw new RecommendationError('unavailable');
    const relays = raw.map(normalizeRelayUrl);
    if (new Set(relays).size !== relays.length) throw new RecommendationError('unavailable');
    return Object.freeze(relays);
  }
  const network = () => JSON.stringify(destinations());
  function lifecycle(signal: AbortSignal, active: () => void, expected?: string) {
    if (signal.aborted) throw Error('Recommendation cancelled');
    active();
    if (expected !== undefined && network() !== expected) throw new RecommendationError('stale');
  }
  async function latest(signal: AbortSignal, active: () => void, expected: string) {
    const check = () => lifecycle(signal, active, expected);
    check();
    if (!queries.queryDetailed) throw new RecommendationError('unavailable');
    const result = await queries.queryDetailed(filters, signal, check, {completeRelays: true});
    check();
    const partition = result.incomplete ? reachablePartition(result, destinations()) : undefined;
    if (result.incomplete && !partition) throw new RecommendationError('incomplete', result.failedRelays);
    if (result.events.length > QUERY_LIMITS.events) throw new RecommendationError('incomplete');
    const now = Math.floor(Date.now() / 1000);
    const events = result.events.map(row => verifyQueryEvent(row.event, filters));
    events.sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const event = events[0];
    if (event) validateCurrentList(event, account, destinations(), now);
    check();
    const current = event ?? null;
    return {current, reachable: partition};
  }
  return {destinations, network, lifecycle, latest};
}

class CatalogRecommendations {
  readonly account: string;
  readonly reader: ReturnType<typeof createRecommendationReader>;
  readonly canSign: () => Promise<boolean>;
  readonly consumed = new Set<string>();
  running = false;
  prepared: Prepared | null = null;
  ticket = 0;
  checkedRevision: string | null | undefined;
  constructor(user: string, queries: RelayQueryService, canSign: () => Promise<boolean>) {
    this.account = publicKey(user); this.reader = createRecommendationReader(this.account, queries); this.canSign = canSign;
  }
  async prepareAddition(coordinate: string, create: boolean, signal: AbortSignal, active: () => void): Promise<object> {
    const {account, reader, consumed, canSign} = this;
    const {lifecycle, network, latest, destinations} = reader;
    lifecycle(signal, active);
    if (this.running || !validCoordinate(coordinate)) return Object.freeze({status: 'unavailable'});
    this.running = true;
    try {
      if (!await canSign()) {lifecycle(signal, active); return Object.freeze({status: 'read-only'});}
      this.reader.lifecycle(signal, active);
      const expected = network();
      const {current, reachable} = await latest(signal, active, expected);
      const revision = current?.id ?? null;
      if (!create && !current) return Object.freeze({status:'missing'});
      if (current?.tags.some(tag => tag[0] === 'a' && tag[1] === coordinate)) return Object.freeze({status: 'already-recommended'});
      if (consumed.size >= 64 || this.checkedRevision === revision || this.ticket >= Number.MAX_SAFE_INTEGER) return Object.freeze({status: 'unavailable'});
      const now = Math.floor(Date.now() / 1000);
      // A strictly newer replaceable event avoids same-second id tie ambiguity.
      if (current && current.created_at >= now) return Object.freeze({status: 'stale'});
      const template = {kind: 30267, created_at: now, content: current?.content ?? '',
        tags: [...(current?.tags.map(tag => [...tag]) ?? [['d', identifier]]), ['a', coordinate]]};
      if (template.tags.length > 512) return Object.freeze({status: 'unavailable'});
      const snapshot = captureEventSnapshot(template, account, destinations());
      if (!fitsPublication(snapshot) || consumed.has(snapshot.hash)) return Object.freeze({status: 'unavailable'});
      lifecycle(signal, active, expected);
      this.prepared = Object.freeze({snapshot, revision, network: expected, ticket: ++this.ticket, ...(reachable ? {reachable} : {})});
      return Object.freeze({status: 'prepared', account, event: snapshot.event, relays: reachable?.destinations ?? snapshot.destinations});
    } catch (error) {
      this.reader.lifecycle(signal, active);
      return Object.freeze({status: error instanceof RecommendationError ? error.status : 'unavailable',
        ...(error instanceof RecommendationError && error.failedRelays?.length ? {failedRelays: error.failedRelays} : {})});
    } finally {this.running = false;}
  }
  bind(event: EventSnapshot): CatalogRecommendationGuard | null {
    const plan = this.prepared;
    if (!plan) return null;
    let captured: EventSnapshot;
    try {captured = captureEventSnapshot(event.event, event.selectedPubkey, event.destinations);} catch {return null;}
    if (captured.selectedPubkey !== this.account || captured.hash !== event.hash || captured.hash !== plan.snapshot.hash ||
        JSON.stringify(captured.destinations) !== JSON.stringify(plan.snapshot.destinations) || this.reader.network() !== plan.network) return null;
    // Consume before the approval UI appears, including cancellation or failed checks.
    this.prepared = null; this.consumed.add(captured.hash);
    return this.guard(plan, captured);
  }
  private guard(plan: Prepared, captured: EventSnapshot): CatalogRecommendationGuard {
    const {reader, canSign, consumed} = this;
    const {lifecycle, latest} = reader;
    let uses = 0, checking = false, released = false;
    const guard = async (signal: AbortSignal, active: () => void) => {
      if (released || checking || uses >= 2) throw Error('Recommendation preparation consumed');
      uses++; checking = true;
      const check = () => {
        lifecycle(signal, active, plan.network);
        if (released || this.ticket !== plan.ticket) throw new RecommendationError('stale');
      };
      try {
        check();
        if (!await canSign()) throw new RecommendationError('read-only');
        check();
        const {current, reachable} = await latest(signal, check, plan.network);
        if ((current?.id ?? null) !== plan.revision ||
            JSON.stringify(reachable?.destinations) !== JSON.stringify(plan.reachable?.destinations) ||
            JSON.stringify(reachable?.excludedRelays) !== JSON.stringify(plan.reachable?.excludedRelays)) {
          throw new RecommendationError('stale');
        }
        check();
        this.checkedRevision = plan.revision;
      } catch (error) {
        uses = 2;
        throw error;
      } finally {checking = false;}
    };
    return Object.freeze(Object.assign(guard, {...(plan.reachable ? {destinations: plan.reachable.destinations, excludedRelays: plan.reachable.excludedRelays} : {}), release: (allowRetry = false) => {
      if (released) return;
      released = true;
      if (allowRetry) {
        consumed.delete(captured.hash);
        if (this.ticket === plan.ticket && this.checkedRevision === plan.revision) this.checkedRevision = undefined;
      }
    }}));
  }
}

/** Prepare the account's kind-30267 napplet list for native Lists review.
 * A partial relay result binds the review to the reachable destinations. The guard
 * rechecks the revision and relay coverage before signing and again before sending. */
export function createCatalogRecommendations(user: string, queries: RelayQueryService, canSign: () => Promise<boolean>) {
  const service = new CatalogRecommendations(user, queries, canSign);
  return Object.freeze({prepareAddition: service.prepareAddition.bind(service), bind: service.bind.bind(service)});
}
