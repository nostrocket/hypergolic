import type {NostrEvent} from 'nostr-tools/pure';
import type {RelayQueryService} from '../network/native-relay-query.ts';
import {parseQueryFilters, QUERY_LIMITS, type QueryFilter} from '../network/relay-query-contract.ts';
import {utf8Bytes} from '../storage/codec.ts';
import {IdentityDataError, latestIdentityEvent, verifiedIdentityEvents} from './identity-contract.ts';
import {identityAddress} from './identity-projection.ts';
export const BADGE_LIMITS = Object.freeze({badges: 12, sets: 4, depth: 1, thumbs: 8});
export const BADGE_BUNDLE_FILTERS = parseQueryFilters([{kinds: [10008, 30008, 8, 30009], limit: 32}]);
export type PublicBadge = Readonly<{id: string; awardedBy: string; name?: string; description?: string; image?: string; thumbs?: readonly string[]}>;
type Pair = Readonly<{definition: string; award: string}>;
function identifier(event: NostrEvent): string {
  const values = event.tags.filter(tag => tag[0] === 'd');
  if (values.length !== 1 || values[0]!.length < 2 || utf8Bytes(values[0]![1]!) > 1024) throw new IdentityDataError('invalid badge address');
  return values[0]![1]!;
}
function roots(events: readonly NostrEvent[], user: string): readonly NostrEvent[] {
  if (events.some(event => event.kind === 10008 && event.pubkey !== user)) throw new IdentityDataError('invalid badge profile owner');
  return events.filter(event => event.pubkey === user && (event.kind === 10008 || event.kind === 30008 && event.tags.some(tag => tag[0] === 'd' && tag[1] === 'profile_badges') && identifier(event) === 'profile_badges'));
}
function addressed(events: readonly NostrEvent[], reference: string): NostrEvent | null {
  const address = identityAddress(reference);
  return latestIdentityEvent(events.filter(event => event.kind === address.kind && event.pubkey === address.author && identifier(event) === address.identifier));
}
function references(event: NostrEvent): readonly (Pair | string)[] {
  const output: (Pair | string)[] = [];
  for (let i = 0; i < event.tags.length; i++) {
    const tag = event.tags[i]!;
    if (tag[0] === 'e') throw new IdentityDataError('incomplete accepted badge pair');
    if (tag[0] !== 'a') continue;
    if (tag[1] === undefined) throw new IdentityDataError('invalid accepted badge reference');
    const address = identityAddress(tag[1]);
    if (address.kind === 30008) output.push(tag[1]);
    else if (address.kind === 30009) {
      const award = event.tags[++i];
      if (award?.[0] !== 'e' || !/^[0-9a-f]{64}$/.test(award[1] ?? '')) throw new IdentityDataError('incomplete accepted badge pair');
      output.push(Object.freeze({definition: tag[1], award: award[1]!}));
    } else throw new IdentityDataError('unsupported accepted badge reference');
    if (output.length > BADGE_LIMITS.badges + BADGE_LIMITS.sets) throw new IdentityDataError('accepted badges exceeded limits');
  }
  return Object.freeze(output);
}
function pairs(root: NostrEvent | null, events: readonly NostrEvent[]): readonly Pair[] {
  if (!root) return Object.freeze([]);
  const selected = references(root), result: Pair[] = [], sets = new Set<string>();
  for (const entry of selected) {
    if (typeof entry !== 'string') result.push(entry);
    else {
      sets.add(entry); if (sets.size > BADGE_LIMITS.sets) throw new IdentityDataError('accepted badge sets exceeded limits');
      const set = addressed(events, entry);
      if (!set || set.id === root.id) throw new IdentityDataError('accepted badge set unavailable');
      for (const child of references(set)) {
        if (typeof child === 'string') throw new IdentityDataError('nested accepted badge sets unsupported');
        result.push(child);
      }
    }
    if (result.length > BADGE_LIMITS.badges) throw new IdentityDataError('accepted badges exceeded limits');
  }
  return Object.freeze(result);
}
function metadata(event: NostrEvent): Omit<PublicBadge, 'id' | 'awardedBy'> {
  const result: {name?: string; description?: string; image?: string; thumbs?: readonly string[]} = {};
  for (const [field, maximum] of [['name', 256], ['description', 8192], ['image', 2048]] as const) {
    const tags = event.tags.filter(tag => tag[0] === field);
    if (tags.length > 1 || tags[0] && (tags[0][1] === undefined || utf8Bytes(tags[0][1]!) > maximum)) throw new IdentityDataError('invalid badge metadata');
    if (tags[0]) result[field] = tags[0][1]!;
  }
  const thumbs = event.tags.filter(tag => tag[0] === 'thumb');
  if (thumbs.length > BADGE_LIMITS.thumbs || thumbs.some(tag => tag[1] === undefined || utf8Bytes(tag[1]!) > 2048)) throw new IdentityDataError('invalid badge thumbnails');
  if (thumbs.length) result.thumbs = Object.freeze(thumbs.map(tag => tag[1]!));
  return Object.freeze(result);
}
export function acceptedBadges(events: readonly NostrEvent[], user: string): readonly PublicBadge[] {
  const root = latestIdentityEvent(roots(events, user));
  return Object.freeze(pairs(root, events).map(pair => {
    const address = identityAddress(pair.definition), definition = addressed(events, pair.definition);
    const award = events.find(event => event.id === pair.award);
    const awardDefinitions = award?.tags.filter(tag => tag[0] === 'a') ?? [];
    if (!definition || !award || award.kind !== 8 || award.pubkey !== address.author || awardDefinitions.length !== 1 || awardDefinitions[0]![1] !== pair.definition || !award.tags.some(tag => tag[0] === 'p' && tag[1] === user)) throw new IdentityDataError('accepted badge evidence unavailable');
    return Object.freeze({id: definition.id, awardedBy: award.pubkey, ...metadata(definition)});
  }));
}
/** Fixed joins through trusted configured destinations. Address/relay hints never add a destination. */
export async function fetchAcceptedBadges(user: string, cached: readonly NostrEvent[] | null, queries: RelayQueryService, signal: AbortSignal, active: () => void): Promise<{events: readonly NostrEvent[]; observedRoot: boolean}> {
  const rootFilters = parseQueryFilters([{authors: [user], kinds: [10008], limit: 2}, {authors: [user], kinds: [30008], '#d': ['profile_badges'], limit: 2}]);
  const source = new Map((cached ?? []).map(event => [event.id, event]));
  async function query(filters: readonly QueryFilter[]): Promise<readonly NostrEvent[]> {
    active(); const rows = await queries.query(filters, signal, active); active();
    const events = verifiedIdentityEvents(rows.map(row => row.event), filters);
    for (const event of events) source.set(event.id, event);
    return events;
  }
  const observed = await query(rootFilters), root = latestIdentityEvent(roots([...source.values()], user));
  if (!root) return {events: Object.freeze([]), observedRoot: true};
  const setReferences = [...new Set(references(root).filter((entry): entry is string => typeof entry === 'string'))];
  if (setReferences.length > BADGE_LIMITS.sets) throw new IdentityDataError('accepted badge sets exceeded limits');
  async function queryAddresses(addresses: readonly string[]) {
    for (let i = 0; i < addresses.length; i += QUERY_LIMITS.filters) {
      const filters = addresses.slice(i, i + QUERY_LIMITS.filters).map(reference => {const address = identityAddress(reference); return {authors: [address.author], kinds: [address.kind], '#d': [address.identifier], limit: 2};});
      await query(parseQueryFilters(filters));
    }
  }
  await queryAddresses(setReferences);
  const selected = pairs(root, [...source.values()]);
  const missingAwards = new Set<string>();
  for (const pair of selected) {if (!source.has(pair.award)) missingAwards.add(pair.award);}
  if (missingAwards.size) await query(parseQueryFilters([{ids: [...missingAwards], kinds: [8], '#p': [user], limit: BADGE_LIMITS.badges}]));
  await queryAddresses([...new Set(selected.map(pair => pair.definition))]);
  const needed = new Map<string, NostrEvent>([[root.id, root]]);
  for (const reference of setReferences) {const set = addressed([...source.values()], reference); if (set) needed.set(set.id, set);}
  for (const pair of selected) {const definition = addressed([...source.values()], pair.definition), award = source.get(pair.award); if (definition) needed.set(definition.id, definition); if (award) needed.set(award.id, award);}
  const events = verifiedIdentityEvents([...needed.values()], BADGE_BUNDLE_FILTERS); acceptedBadges(events, user); active();
  return {events, observedRoot: observed.length > 0};
}
