import type {NostrEvent} from 'nostr-tools/pure';
import type {RelayQueryService} from '../network/native-relay-query.ts';
import {NATIVE_RELAY_REQUEST_BYTES, QUERY_LIMITS, verifyQueryEvent, type QueryFilter} from '../network/relay-query-contract.ts';
import {normalizeRelayUrl, MAX_RELAYS_PER_ROLE} from '../network/relay-settings.ts';
import {captureEventSnapshot, type EventSnapshot} from '../security/event-snapshot.ts';
import {publicKey, utf8Bytes} from '../storage/codec.ts';

const TYPE = 'relay.catalogRecommendation';
const identifier = 'napplets';
const coordinatePattern = /^35129:[0-9a-f]{64}:.+$/u;
const hex = /^[0-9a-f]{64}$/;
const validCoordinate = (value: unknown): value is string => typeof value === 'string' && value.length <= 512 &&
  coordinatePattern.test(value) && !/[\u0000-\u001f\u007f]/u.test(value);
export type CatalogRecommendationGuard = ((signal: AbortSignal, active: () => void) => Promise<void>) & {
  /** true only when trusted approval bookkeeping proves no publication was dispatched. */
  release(allowRetry?: boolean): void;
};
type Prepared = Readonly<{snapshot: EventSnapshot; revision: string | null; network: string; ticket: number}>;
class RecommendationError extends Error {
  readonly status: 'unavailable' | 'incomplete' | 'stale' | 'read-only';
  constructor(status: RecommendationError['status']) {super(status); this.status = status;}
}
function request(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw Error('Invalid recommendation');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== Object.keys(descriptors).length || Object.values(descriptors).some(item => !('value' in item))) throw Error('Invalid recommendation');
  const row = value as Record<string, unknown>, fields = row.coordinate === undefined ? ['type', 'id'] : ['type', 'id', 'account', 'revision', 'coordinate'];
  if (Object.keys(row).length !== fields.length || fields.some(field => !Object.hasOwn(row, field)) || row.type !== TYPE ||
      typeof row.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(row.id)) throw Error('Invalid recommendation');
  if (fields.length > 2 && (typeof row.account !== 'string' || !hex.test(row.account) ||
      row.revision !== null && (typeof row.revision !== 'string' || !hex.test(row.revision)) || !validCoordinate(row.coordinate))) throw Error('Invalid recommendation');
  return row;
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
function recommendedCoordinates(event: NostrEvent | null): readonly string[] {
  const coordinates = new Set<string>();
  for (const tag of event?.tags ?? []) if (tag[0] === 'a' && validCoordinate(tag[1])) coordinates.add(tag[1]);
  return Object.freeze([...coordinates]);
}

function createRecommendationReader(account: string, queries: RelayQueryService) {
  const filters: readonly QueryFilter[] = [{kinds: [30267], authors: [account], '#d': [identifier], limit: QUERY_LIMITS.events}];
  function destinations(): readonly string[] {
    const raw = queries.catalog?.destinations();
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
    const result = await queries.queryDetailed(filters, signal, check);
    check();
    if (result.incomplete) throw new RecommendationError('incomplete');
    if (result.events.length > QUERY_LIMITS.events) throw new RecommendationError('incomplete');
    const now = Math.floor(Date.now() / 1000);
    const events = result.events.map(row => verifyQueryEvent(row.event, filters));
    events.sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const event = events[0];
    if (event) validateCurrentList(event, account, destinations(), now);
    check();
    return event ?? null;
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
  async dispatch(input: unknown, signal: AbortSignal, active: () => void): Promise<object> {
    const {account, reader, consumed, canSign} = this;
    const {lifecycle, network, latest, destinations} = reader;
    lifecycle(signal, active);
    if (this.running) return Object.freeze({status: 'unavailable'});
    this.running = true;
    try {
      const row = request(input);
      if (row.account !== undefined && row.account !== account) return Object.freeze({status: 'account-changed'});
      if (!await canSign()) {lifecycle(signal, active); return Object.freeze({status: 'read-only'});}
      this.reader.lifecycle(signal, active);
      const expected = network(), current = await latest(signal, active, expected), revision = current?.id ?? null;
      if (row.coordinate === undefined) return Object.freeze({status: 'ready', account, revision,
        recommended: recommendedCoordinates(current)});
      if (row.revision !== revision) return Object.freeze({status: 'stale'});
      if (current?.tags.some(tag => tag[0] === 'a' && tag[1] === row.coordinate)) return Object.freeze({status: 'already-recommended'});
      if (consumed.size >= 64 || this.checkedRevision === revision || this.ticket >= Number.MAX_SAFE_INTEGER) return Object.freeze({status: 'unavailable'});
      const now = Math.floor(Date.now() / 1000);
      // A strictly newer replaceable event avoids same-second id tie ambiguity.
      if (current && current.created_at >= now) return Object.freeze({status: 'stale'});
      const template = {kind: 30267, created_at: now, content: current?.content ?? '',
        tags: [...(current?.tags.map(tag => [...tag]) ?? [['d', identifier]]), ['a', row.coordinate as string]]};
      if (template.tags.length > 512) return Object.freeze({status: 'unavailable'});
      const snapshot = captureEventSnapshot(template, account, destinations());
      if (!fitsPublication(snapshot) || consumed.has(snapshot.hash)) return Object.freeze({status: 'unavailable'});
      lifecycle(signal, active, expected);
      this.prepared = Object.freeze({snapshot, revision, network: expected, ticket: ++this.ticket});
      return Object.freeze({status: 'prepared', event: snapshot.event, relays: snapshot.destinations});
    } catch (error) {
      this.reader.lifecycle(signal, active);
      return Object.freeze({status: error instanceof RecommendationError ? error.status : 'unavailable'});
    } finally {this.running = false;}
  }
  bind(event: EventSnapshot): CatalogRecommendationGuard | null {
    const plan = this.prepared;
    if (!plan) return null;
    let captured: EventSnapshot;
    try {captured = captureEventSnapshot(event.event, event.selectedPubkey, event.destinations);} catch {return null;}
    if (captured.selectedPubkey !== this.account || captured.hash !== event.hash || captured.hash !== plan.snapshot.hash ||
        JSON.stringify(captured.destinations) !== JSON.stringify(plan.snapshot.destinations)) return null;
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
        const current = await latest(signal, check, plan.network);
        if ((current?.id ?? null) !== plan.revision) throw new RecommendationError('stale');
        check();
        this.checkedRevision = plan.revision;
      } catch (error) {
        uses = 2;
        throw error;
      } finally {checking = false;}
    };
    return Object.assign(guard, {release: (allowRetry = false) => {
      if (released) return;
      released = true;
      if (allowRetry) {
        consumed.delete(captured.hash);
        if (this.ticket === plan.ticket && this.checkedRevision === plan.revision) this.checkedRevision = undefined;
      }
    }});
  }
}

/** One instance per renderer generation. Reads only this account's exact kind-30267
 * d=napplets list across the configured Network relays. A complete result is scoped
 * to those relays, never a global Nostr latest-list claim. No signature or publication
 * happens here; a consumed preparation still needs the ordinary native event review.
 * Native queryDetailed attempts each configured Network relay and reports incomplete
 * when any relay fails EOSE/authentication or the aggregate is limited. The catalog
 * destinations and detailed query must come from that same trusted query service.
 * This cannot detect a relay hiding newer data or writes after the final recheck. */
export function createCatalogRecommendations(user: string, queries: RelayQueryService, canSign: () => Promise<boolean>) {
  const service = new CatalogRecommendations(user, queries, canSign);
  return Object.freeze({dispatch: service.dispatch.bind(service), bind: service.bind.bind(service)});
}
