import { utf8Bytes } from '../storage/codec.ts';

export const RESOURCE_SPEC = '8c0645d32ceb159bc3e8bcec1107a92862b7e86a';
export const RESOURCE_LIMITS = Object.freeze({ fileBytes: 10 * 1024 * 1024, urls: 8, urlBytes: 8192,
  dataUrlBytes: 64 * 1024, blossomServers: 4, sessionConcurrent: 2, processConcurrent: 4, perMinute: 60,
  sessionCacheBytes: 30 * 1024 * 1024, processCacheBytes: 50 * 1024 * 1024,
  deliveredBytes: 50 * 1024 * 1024, cacheEntries: 64, requestMs: 20_000, urlMs: 15_000,
  chunkBytes: 256 * 1024 });
export const RESOURCE_ERRORS = ['invalid-request', 'not-found', 'blocked-by-policy', 'timeout',
  'too-large', 'unsupported-scheme', 'decode-failed', 'network-error', 'quota-exceeded'] as const;
export type ResourceErrorCode = typeof RESOURCE_ERRORS[number];
export class ResourceError extends Error {
  readonly code: ResourceErrorCode;
  constructor(code: ResourceErrorCode) { super(code); this.name = 'ResourceError'; this.code = code; }
}
export type ResourceTarget = Readonly<{ url: string; servers?: readonly string[] }>;
export type ResourceRequest = Readonly<{ type: 'resource.info'; id: string }> | Readonly<{ type: 'resource.cancel'; id: string }>
  | (Readonly<{ type: 'resource.bytes'; id: string }> & ResourceTarget)
  | Readonly<{ type: 'resource.bytesMany'; id: string; requests: readonly ResourceTarget[] }>;
export type ResourceBytes = Readonly<{ bytes: Uint8Array<ArrayBuffer>; mime: string }>;
export type ResourceURL = Readonly<{ scheme: 'https'; url: string }>
  | Readonly<{ scheme: 'blossom'; hash: string }>
  | Readonly<{ scheme: 'nostr'; reference: string }>
  | Readonly<{ scheme: 'data'; url: string }>;
const fail = (code: ResourceErrorCode = 'invalid-request'): never => { throw new ResourceError(code); };
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== Object.keys(descriptors).length ||
    Object.values(descriptors).some(field => !Object.hasOwn(field, 'value'))) return fail();
  return value as Record<string, unknown>;
}
function urlText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return fail();
  if (utf8Bytes(value) > (value.startsWith('data:') ? RESOURCE_LIMITS.dataUrlBytes : RESOURCE_LIMITS.urlBytes)) return fail('too-large');
  return value;
}
/** Public wire only. Caller-supplied scope, fetch options and internal byte handles are rejected. */
export function parseResourceRequest(value: unknown): ResourceRequest {
  const data = record(value);
  if (typeof data.id !== 'string' || data.id.length === 0 || utf8Bytes(data.id) > 128) return fail();
  const keys = data.type === 'resource.bytes' ? ['type', 'id', 'url']
    : data.type === 'resource.bytesMany' ? ['type', 'id', Object.hasOwn(data, 'requests') ? 'requests' : 'urls'] : ['type', 'id'];
  const allowed = new Set(keys);
  if (data.type === 'resource.bytes') allowed.add('servers');
  if (keys.some(key => !Object.hasOwn(data, key)) || Object.keys(data).some(key => !allowed.has(key))) return fail();
  if (data.type === 'resource.info' || data.type === 'resource.cancel') return Object.freeze({ type: data.type, id: data.id });
  if (data.type === 'resource.bytes') return Object.freeze({ type: data.type, id: data.id, ...resourceTarget(data) });
  if (data.type !== 'resource.bytesMany') return fail();
  const requests = Object.hasOwn(data, 'requests')
    ? boundedList(data.requests, RESOURCE_LIMITS.urls, value => {
      const item = record(value);
      if (!Object.hasOwn(item, 'url') || Object.keys(item).some(key => key !== 'url' && key !== 'servers')) return fail();
      return resourceTarget(item);
    })
    : boundedList(data.urls, RESOURCE_LIMITS.urls, url => Object.freeze({url: urlText(url)}));
  if (requests.length === 0) return fail();
  return Object.freeze({type: data.type, id: data.id, requests});
}

function boundedList<T>(value: unknown, max: number, parse: (item: unknown) => T): readonly T[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return fail();
  if (value.length > max) return fail('too-large');
  if (Reflect.ownKeys(value).length !== value.length + 1) return fail();
  const items: T[] = [];
  for (let index = 0; index < value.length; index++) {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field || !Object.hasOwn(field, 'value')) return fail();
    items.push(parse(field.value));
  }
  return Object.freeze(items);
}

function resourceTarget(fields: Record<string, unknown>): ResourceTarget {
  const url = urlText(fields.url);
  if (!Object.hasOwn(fields, 'servers')) return Object.freeze({url});
  const servers = boundedList(fields.servers, RESOURCE_LIMITS.blossomServers, value => resourceServerOrigin(urlText(value)));
  return Object.freeze({url, servers});
}
/** HTTPS destination preflight; native DNS/address pinning remains mandatory. */
export function publicResourceHttps(value: string): string {
  urlText(value);
  if (value !== value.trim() || /[\\\u0000-\u0020\u007f]/.test(value)) return fail('blocked-by-policy');
  let url: URL;
  try { url = new URL(value); } catch { return fail(); }
  if (value.slice(value.indexOf('://') + 3).split('/')[0]!.includes('@')) return fail('blocked-by-policy');
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') return fail('blocked-by-policy');
  const host = url.hostname.toLowerCase();
  if (!host.includes('.') || host.endsWith('.') || /^[0-9.]+$/.test(host) || host.includes(':') || host.includes('%') ||
    ['localhost', 'local', 'internal', 'home', 'home.arpa', 'lan', 'test', 'example', 'invalid', 'onion', 'arpa'].some(suffix => host === suffix || host.endsWith('.' + suffix)) ||
    host.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return fail('blocked-by-policy');
  if (utf8Bytes(url.href) > RESOURCE_LIMITS.urlBytes) return fail('too-large');
  return url.href;
}
export function resourceServerOrigin(value: string): string {
  const url = new URL(publicResourceHttps(value));
  if (url.pathname !== '/' || url.search !== '') return fail('blocked-by-policy');
  return url.origin;
}

export function parseResourceURL(value: string): ResourceURL {
  urlText(value);
  if (value.startsWith('https:')) return Object.freeze({ scheme: 'https', url: publicResourceHttps(value) });
  if (value.startsWith('data:')) return Object.freeze({ scheme: 'data', url: value });
  if (value.startsWith('blossom:')) {
    const match = /^blossom:sha256:([0-9a-f]{64})$/.exec(value) ?? /^blossom:([0-9a-f]{64})\.[a-zA-Z0-9]{1,12}$/.exec(value);
    if (!match) return fail('invalid-request');
    return Object.freeze({ scheme: 'blossom', hash: match[1]! });
  }
  if (value.startsWith('nostr:')) {
    const reference = value.slice(6);
    if (!/^(?:note|nevent|naddr)1[023456789acdefghjklmnpqrstuvwxyz]+$/.test(reference)) return fail('decode-failed');
    return Object.freeze({ scheme: 'nostr', reference });
  }
  return fail('unsupported-scheme');
}
export function resourceFailure(value: unknown, error: ResourceErrorCode): Readonly<Record<string, unknown> & {type: string; id: string}> | null {
  try {
    const data = record(value);
    if (typeof data.type !== 'string' || !['resource.info', 'resource.bytes', 'resource.bytesMany'].includes(data.type) ||
      typeof data.id !== 'string' || data.id.length === 0 || utf8Bytes(data.id) > 128) return null;
    return Object.freeze({ type: data.type + '.error', id: data.id, error });
  } catch { return null; }
}
export function resourceInfo(blossom = true, nostr = true) {
  return Object.freeze({ schemes: Object.freeze(['https', 'blossom', 'nostr', 'data', 'htree'].map(scheme =>
    Object.freeze({ scheme, enabled: scheme === 'blossom' ? blossom : scheme === 'nostr' ? nostr : scheme !== 'htree' }))), maxBytes: RESOURCE_LIMITS.fileBytes, maxUrls: RESOURCE_LIMITS.urls });
}
