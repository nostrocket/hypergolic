import type {NostrEvent} from 'nostr-tools/pure';
import {parseQueryFilters, type QueryFilter} from '../network/relay-query-contract.ts';
import {utf8Bytes} from '../storage/codec.ts';
import {IdentityDataError, latestIdentityEvent, profileFromEvents, type IdentityCacheKey, type IdentityRequest} from './identity-contract.ts';
export interface IdentityProjection {
  readonly key: IdentityCacheKey; readonly filters: readonly QueryFilter[]; readonly field: string;
  readonly sensitive: boolean; project(events: readonly NostrEvent[]): unknown;
}
const HEX = /^[0-9a-f]{64}$/;
export const IDENTITY_COLLECTION_LIMIT = 256;
export function identityAddress(value: string): {kind: number; author: string; identifier: string} {
  const match = /^(\d{1,5}):([0-9a-f]{64}):(.*)$/s.exec(value);
  if (!match || Number(match[1]) < 30000 || Number(match[1]) > 39999 || utf8Bytes(match[3]!) > 1024) throw new IdentityDataError('invalid public identity reference');
  return {kind: Number(match[1]), author: match[2]!, identifier: match[3]!};
}
function bounded(values: readonly string[]): readonly string[] {
  const unique = [...new Set(values)];
  if (values.length > IDENTITY_COLLECTION_LIMIT) throw new IdentityDataError('identity list exceeded limits');
  return Object.freeze(unique);
}
function tagValues(event: NostrEvent | null, accepted: Readonly<Record<string, 'key' | 'address' | 'text'>>): readonly string[] {
  const values: string[] = [];
  for (const tag of event?.tags ?? []) {
    if (!Object.hasOwn(accepted, tag[0]!)) continue;
    const type = accepted[tag[0]!]!;
    const value = tag[1];
    if (value === undefined || (type === 'key' ? !HEX.test(value) : type === 'text' ? value.length === 0 || utf8Bytes(value) > 256 : false)) throw new IdentityDataError('invalid public identity list');
    if (type === 'address') identityAddress(value);
    values.push(value);
  }
  return bounded(values);
}
function relayMap(events: readonly NostrEvent[]) {
  const result: Record<string, Readonly<{read: boolean; write: boolean}>> = {};
  const tags = latestIdentityEvent(events)?.tags.filter(tag => tag[0] === 'r') ?? [];
  if (tags.length > IDENTITY_COLLECTION_LIMIT) throw new IdentityDataError('identity relay list exceeded limits');
  for (const tag of tags) {
    const url = tag[1], marker = tag[2];
    if (!url || utf8Bytes(url) > 2048 || (marker !== undefined && marker !== 'read' && marker !== 'write')) throw new IdentityDataError('invalid identity relay metadata');
    try {const parsed = new URL(url); if (!['wss:', 'ws:'].includes(parsed.protocol) || !parsed.hostname) throw Error();}
    catch {throw new IdentityDataError('invalid identity relay metadata');}
    // Public preferences are data. This never adds a trusted network destination.
    const prior = result[url]; result[url] = Object.freeze({read: !!prior?.read || marker !== 'write', write: !!prior?.write || marker !== 'read'});
  }
  return Object.freeze(result);
}
export function identityProjection(request: IdentityRequest, user: string): IdentityProjection {
  let key: IdentityCacheKey, kind: number, field: string, sensitive = false;
  let project: (events: readonly NostrEvent[]) => unknown;
  switch (request.type) {
    case 'identity.getProfile': key = 'profile'; kind = 0; field = 'profile'; project = profileFromEvents; break;
    case 'identity.getRelays': key = 'relays'; kind = 10002; field = 'relays'; project = relayMap; break;
    case 'identity.getFollows': key = 'follows'; kind = 3; field = 'pubkeys'; project = events => tagValues(latestIdentityEvent(events), {p: 'key'}); break;
    case 'identity.getMutes': key = 'mutes'; kind = 10000; field = 'pubkeys'; sensitive = true; project = events => tagValues(latestIdentityEvent(events), {p: 'key'}); break;
    case 'identity.getList': {
      sensitive = true; field = 'entries';
      if (request.listType === 'bookmarks') {key = 'bookmarks'; kind = 10003; project = events => tagValues(latestIdentityEvent(events), {e: 'key', a: 'address'});}
      else if (request.listType === 'pins') {key = 'pins'; kind = 10001; project = events => tagValues(latestIdentityEvent(events), {e: 'key'});}
      else if (request.listType === 'interests') {key = 'interests'; kind = 10015; project = events => tagValues(latestIdentityEvent(events), {t: 'text', a: 'address'});}
      else throw new IdentityDataError('identity list type unsupported');
      break;
    }
    case 'identity.getBlocked': throw new IdentityDataError('identity block list unsupported');
    case 'identity.getZaps': throw new IdentityDataError('identity zaps deferred');
    default: throw new IdentityDataError('identity operation unavailable');
  }
  return Object.freeze({key, field, sensitive, project, filters: parseQueryFilters([{authors: [user], kinds: [kind], limit: 4}])});
}
