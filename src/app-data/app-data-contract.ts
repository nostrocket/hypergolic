import { hashPayload } from 'nostr-tools/nip98';
import { routingRecord, routingPayload, type JsonValue } from '../routing/routing-contract.ts';
import { publicKey, utf8Bytes } from '../storage/codec.ts';
import { captureUnsignedEventTemplate, type UnsignedEventTemplate } from '../security/event-snapshot.ts';
import type { NostrEvent } from 'nostr-tools/pure';

/** Public convention soyli@a50f9946; independent implementation, not a new NAP domain. */
export const APP_DATA_PROFILE = 'soy.app-data/1';
export const APP_DATA_KIND = 30078;
// Selected host write policy; format recognition remains the convention's 16 KiB.
export const APP_DATA_MAX_CONTENT_BYTES = 3072;
export const APP_DATA_READ_MAX_CONTENT_BYTES = 16 * 1024;
export type AppDataErrorCode = 'app-data-invalid-id' | 'app-data-invalid-json' |
  'app-data-too-complex' | 'app-data-too-large' | 'app-data-invalid-record' |
  'app-data-invalid-tags' | 'app-data-scope-mismatch';
const appDataErrors = new WeakSet<object>();
export class AppDataError extends Error {
  readonly code: AppDataErrorCode;
  constructor(code: AppDataErrorCode) { super(code); this.name = 'AppDataError'; this.code = code; appDataErrors.add(this); }
}
const fail = (code: AppDataErrorCode): never => { throw new AppDataError(code); };
const hex = /^[a-f0-9]{64}$/;
const schemaPattern = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,95}$/;
const versionValid = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 1_000_000;
function guarded<T>(code: AppDataErrorCode, operation: () => T): T {
  try { return operation(); } catch (error) { if (typeof error === 'object' && error !== null && appDataErrors.has(error)) throw error; return fail(code); }
}
export type AppDataBody = Readonly<{
  schema: string; version: number; title: string; previous: string | null; deleted: boolean; data: JsonValue;
}>;
export type AppDataRecord = Readonly<{scope: string; collection: string; id: string; identifier: string; body: AppDataBody}>;

/** Input must come from the verified manifest adapter; this pure hash grants no authority. */
export function deriveAppDataScope(input: unknown): string {
  return guarded('app-data-invalid-id', () => {
    const row = routingRecord(input, ['publisher', 'kind', 'identifier']);
    const publisher = publicKey(row.publisher);
    if (row.kind !== 35129 || typeof row.identifier !== 'string' || !row.identifier.length || utf8Bytes(row.identifier) > 1024) return fail('app-data-invalid-id');
    const stable = `${publisher}:35129:${row.identifier}`;
    return hashPayload([APP_DATA_PROFILE, stable]);
  });
}
export function dataIdentifier(scope: string, collection: string, id: string): string {
  if (typeof scope !== 'string' || !hex.test(scope) || typeof collection !== 'string' ||
      !/^[a-z][a-z0-9_-]{0,47}$/.test(collection) || typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return fail('app-data-invalid-id');
  return `${APP_DATA_PROFILE}:${scope}:${collection}:${id}`;
}
export function dataTags(scope: string, collection: string, id: string, schema: string, version: number): readonly (readonly string[])[] {
  if (typeof schema !== 'string' || !schemaPattern.test(schema) || !versionValid(version)) return fail('app-data-invalid-record');
  return Object.freeze([
    ['d', dataIdentifier(scope, collection, id)], ['s', scope], ['c', collection],
    ['L', APP_DATA_PROFILE], ['l', schema, APP_DATA_PROFILE], ['v', String(version)],
  ].map(tag => Object.freeze(tag)));
}

/** JSON.parse supplies own data values; freeze while enforcing the convention's exact limits. */
function captureBodyJson(input: unknown): JsonValue {
  let nodes = 0;
  function visit(value: unknown, depth: number): JsonValue {
    if (++nodes > 4096 || depth > 12) return fail('app-data-too-complex');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.length <= APP_DATA_READ_MAX_CONTENT_BYTES) return value;
    if (typeof value !== 'object' || value === null) return fail('app-data-invalid-json');
    if (Array.isArray(value)) {
      if (value.length > 1024) return fail('app-data-too-complex');
      return Object.freeze(value.map(item => visit(item, depth + 1)));
    }
    const entries = Object.entries(value);
    if (entries.length > 128 || entries.some(([key]) => key.length > 128 || ['__proto__', 'constructor', 'prototype'].includes(key))) return fail('app-data-invalid-json');
    return Object.freeze(Object.fromEntries(entries.map(([key, item]) => [key, visit(item, depth + 1)])));
  }
  return visit(input, 0);
}
function decodeBody(content: string): AppDataBody {
  const parsed = guarded('app-data-invalid-json', () => JSON.parse(content) as unknown);
  const body = captureBodyJson(parsed);
  return guarded('app-data-invalid-record', () => {
    const row = routingRecord(body, ['schema', 'version', 'title', 'previous', 'deleted', 'data']);
    if (typeof row.schema !== 'string' || !schemaPattern.test(row.schema) || !versionValid(row.version) ||
        typeof row.title !== 'string' || !row.title.trim() || row.title.length > 160 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(row.title) ||
        !(row.previous === null || typeof row.previous === 'string' && hex.test(row.previous)) || typeof row.deleted !== 'boolean' ||
        row.deleted && (row.data !== null || row.previous === null)) return fail('app-data-invalid-record');
    return Object.freeze(row) as AppDataBody;
  });
}
export function decodeAppDataRecord(input: unknown, maxContentBytes = APP_DATA_READ_MAX_CONTENT_BYTES): AppDataRecord {
  return guarded('app-data-invalid-record', () => {
    const row = routingRecord(input, ['kind', 'content', 'tags'], ['created_at', 'id', 'pubkey', 'sig']);
    if (row.kind !== APP_DATA_KIND || typeof row.content !== 'string') return fail('app-data-invalid-record');
    if (!Number.isSafeInteger(maxContentBytes) || maxContentBytes < 1 || maxContentBytes > APP_DATA_READ_MAX_CONTENT_BYTES) return fail('app-data-invalid-record');
    if (utf8Bytes(row.content) > maxContentBytes) return fail('app-data-too-large');
    const body = decodeBody(row.content);
    const tags = guarded('app-data-invalid-tags', () => routingPayload(row.tags));
    if (!Array.isArray(tags) || tags.length !== 6 || tags.some(tag => !Array.isArray(tag) || tag.length < 2 || tag.length > 3 || tag.some(field => typeof field !== 'string'))) return fail('app-data-invalid-tags');
    const identifier = tags.find(tag => tag[0] === 'd')?.[1];
    if (typeof identifier !== 'string') return fail('app-data-invalid-id');
    const [profile, scope, collection, id, extra] = identifier.split(':');
    if (profile !== APP_DATA_PROFILE || extra !== undefined || scope === undefined || collection === undefined || id === undefined) return fail('app-data-invalid-id');
    const expected = dataTags(scope, collection, id, body.schema, body.version);
    if (!expected.every(tag => tags.filter(candidate => JSON.stringify(candidate) === JSON.stringify(tag)).length === 1)) return fail('app-data-invalid-tags');
    return Object.freeze({scope, collection, id, identifier, body});
  });
}

/** Capture canonical event bytes first; no signature, destination, clock or permission is provided here. */
export function captureAppDataTemplate(input: unknown, selectedPubkey: string, expectedScope: string): UnsignedEventTemplate {
  return guarded('app-data-invalid-record', () => {
    const event = captureUnsignedEventTemplate(input, selectedPubkey);
    const record = decodeAppDataRecord(event, APP_DATA_MAX_CONTENT_BYTES);
    if (!hex.test(expectedScope) || record.scope !== expectedScope) return fail('app-data-scope-mismatch');
    return event;
  });
}

/** Reserve only soy markers, leaving unrelated valid NIP-78 records on their existing path. */
export function claimsAppDataTemplate(input: unknown): boolean {
  try {
    if (typeof input !== 'object' || input === null) return false;
    const descriptor = Object.getOwnPropertyDescriptor(input, 'tags');
    if (!descriptor) return false;
    if (!Object.hasOwn(descriptor, 'value') || !Array.isArray(descriptor.value)) return true;
    const tags = descriptor.value as unknown[];
    if (tags.length > 8192) return true;
    for (let i = 0; i < tags.length; i++) {
      const item = Object.getOwnPropertyDescriptor(tags, String(i));
      if (!item || !Object.hasOwn(item, 'value') || !Array.isArray(item.value)) return true;
      const fields = Object.getOwnPropertyDescriptors(item.value);
      const name = fields['0'];
      if (!name || !Object.hasOwn(name, 'value')) return true;
      for (const [key, field] of Object.entries(fields)) {
        if (key === 'length') continue;
        if (!Object.hasOwn(field, 'value')) return true;
        if (name.value === 'd' && key === '1' && typeof field.value === 'string' &&
            (field.value === APP_DATA_PROFILE || field.value.startsWith(APP_DATA_PROFILE + ':'))) return true;
        if ((name.value === 'L' || name.value === 'l') && field.value === APP_DATA_PROFILE) return true;
      }
    }
    return false;
  } catch { return true; }
}

/** Existing verified-event pipeline owns structural/hash/signature checks. Never decode before selection. */
export function selectLatestAppDataEvent(events: readonly NostrEvent[], author: string, identifier: string): NostrEvent | null {
  publicKey(author);
  let current: NostrEvent | null = null;
  for (const event of events) {
    if (event.kind !== APP_DATA_KIND || event.pubkey !== author || !event.tags.some(tag => tag[0] === 'd' && tag[1] === identifier)) continue;
    if (!current || event.created_at > current.created_at || event.created_at === current.created_at && event.id < current.id) current = event;
  }
  return current;
}
