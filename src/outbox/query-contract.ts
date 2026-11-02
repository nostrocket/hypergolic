import { parseQueryFilters, QUERY_LIMITS, type QueryFilter } from '../network/relay-query-contract.ts';
import { normalizeRelayUrl } from '../network/relay-settings.ts';
import { publicKey, text } from '../storage/codec.ts';
import { OUTBOX_LIST_LIMITS } from './relay-list.ts';

export class OutboxQueryError extends Error {
  constructor(message = 'invalid filter') { super(message); this.name = 'OutboxQueryError'; }
}
export type OutboxQueryRequest = Readonly<{type: 'outbox.query'; id: string; filters: readonly QueryFilter[];
  options: Readonly<{authors: readonly string[]; relays: readonly string[]; limit: number; timeoutMs: number}>}>;
const fail = (): never => {throw new OutboxQueryError();};
export function outboxRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== Object.keys(fields).length || Object.values(fields).some(field => !Object.hasOwn(field, 'value'))) return fail();
  return value as Record<string, unknown>;
}
export function outboxList(input: unknown, max: number, parse: (value: unknown) => string): readonly string[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length > max || Reflect.ownKeys(input).length !== input.length + 1) return fail();
  const values: string[] = [];
  for (let index = 0; index < input.length; index++) {
    const field = Object.getOwnPropertyDescriptor(input, String(index));
    if (!field || !Object.hasOwn(field, 'value')) return fail();
    values.push(parse(field.value));
  }
  return Object.freeze([...new Set(values)]);
}
export function outboxUint(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return fail();
  return value;
}
/** Supported bounded NIP-01 query profile; options never select a native owner. */
export function parseOutboxQuery(input: unknown): OutboxQueryRequest {
  try {
    const source = outboxRecord(input);
    if (source.type !== 'outbox.query' || !Object.hasOwn(source, 'filters') || Object.keys(source).some(key => !['type','id','filters','options'].includes(key))) return fail();
    const options = Object.hasOwn(source, 'options') ? outboxRecord(source.options) : {};
    if (Object.keys(options).some(key => !['authors','relays','limit','timeoutMs'].includes(key))) return fail();
    return Object.freeze({type: 'outbox.query', id: text(source.id, 128),
      filters: parseQueryFilters(Array.isArray(source.filters) ? source.filters : [source.filters]),
      options: Object.freeze({authors: Object.hasOwn(options,'authors') ? outboxList(options.authors, OUTBOX_LIST_LIMITS.authors, publicKey) : Object.freeze([]),
        relays: Object.hasOwn(options,'relays') ? outboxList(options.relays, OUTBOX_LIST_LIMITS.relays, normalizeRelayUrl) : Object.freeze([]),
        limit: Object.hasOwn(options,'limit') ? outboxUint(options.limit, 0, QUERY_LIMITS.events) : QUERY_LIMITS.events,
        timeoutMs: Object.hasOwn(options,'timeoutMs') ? outboxUint(options.timeoutMs, 1, QUERY_LIMITS.timeoutMs) : QUERY_LIMITS.timeoutMs})});
  } catch { return fail(); }
}

export function outboxQueryFailure(input: unknown, error: string): Readonly<{type: 'outbox.query.result'; id: string; events: readonly never[]; error: string}> | null {
  try {
    const source = outboxRecord(input);
    if (source.type !== 'outbox.query') return null;
    return Object.freeze({type: 'outbox.query.result', id: text(source.id,128), events: Object.freeze([]), error});
  } catch {return null;}
}

export type OutboxEventRequest = Readonly<{type: 'outbox.getEvent'; id: string; eventId: string;
  options: Readonly<{author?: string; relays: readonly string[]; timeoutMs: number}>}>;
export type OutboxResolveRequest = Readonly<{type: 'outbox.resolveRelays'; id: string;
  target: Readonly<{authors: readonly string[]; direction: 'read' | 'write'}>}>;
export type OutboxReadRequest = OutboxQueryRequest | OutboxEventRequest | OutboxResolveRequest;
export function parseOutboxEvent(input: unknown): OutboxEventRequest {
  try {
    const source = outboxRecord(input);
    if (source.type !== 'outbox.getEvent' || Object.keys(source).some(key => !['type','id','eventId','options'].includes(key))) return fail();
    const options = Object.hasOwn(source,'options') ? outboxRecord(source.options) : {};
    if (Object.keys(options).some(key => !['author','relays','timeoutMs'].includes(key))) return fail();
    return Object.freeze({type:'outbox.getEvent', id:text(source.id,128), eventId:publicKey(source.eventId),
      options:Object.freeze({...(Object.hasOwn(options,'author') ? {author:publicKey(options.author)} : {}),
        relays:Object.hasOwn(options,'relays') ? outboxList(options.relays,OUTBOX_LIST_LIMITS.relays,normalizeRelayUrl) : Object.freeze([]),
        timeoutMs:Object.hasOwn(options,'timeoutMs') ? outboxUint(options.timeoutMs,1,QUERY_LIMITS.timeoutMs) : QUERY_LIMITS.timeoutMs})});
  } catch {return fail();}
}
export function parseOutboxResolve(input: unknown): OutboxResolveRequest {
  try {
    const source = outboxRecord(input);
    if (source.type !== 'outbox.resolveRelays' || Object.keys(source).length !== 3 || !Object.hasOwn(source,'target')) return fail();
    const target = outboxRecord(source.target);
    if (Object.keys(target).some(key => !['authors','pubkey','direction'].includes(key))) return fail();
    if (Object.hasOwn(target,'direction') && target.direction !== 'read' && target.direction !== 'write') return fail();
    const authors = new Set(Object.hasOwn(target,'authors') ? outboxList(target.authors,OUTBOX_LIST_LIMITS.authors,publicKey) : []);
    if (Object.hasOwn(target,'pubkey')) authors.add(publicKey(target.pubkey));
    if (authors.size > OUTBOX_LIST_LIMITS.authors) return fail();
    return Object.freeze({type:'outbox.resolveRelays',id:text(source.id,128),
      target:Object.freeze({authors:Object.freeze([...authors]),direction:target.direction === 'write' ? 'write' : 'read'})});
  } catch {return fail();}
}
export function parseOutboxRead(input: unknown): OutboxReadRequest {
  const source = outboxRecord(input);
  if (source.type === 'outbox.query') return parseOutboxQuery(input);
  if (source.type === 'outbox.getEvent') return parseOutboxEvent(input);
  return parseOutboxResolve(input);
}
export function outboxReadFailure(input: unknown, error: string): Readonly<Record<string,unknown> & {type:string;id:string}> | null {
  try {
    const source = outboxRecord(input);
    if (!['outbox.query','outbox.getEvent','outbox.resolveRelays'].includes(source.type as string)) return null;
    return Object.freeze({type:`${source.type}.result`,id:text(source.id,128),...(source.type === 'outbox.query' ? {events:Object.freeze([])} : {}),error});
  } catch {return null;}
}
