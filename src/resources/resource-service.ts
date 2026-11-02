import { mapResourceItems } from './bounded-map.ts';
import { decode } from 'nostr-tools/nip19';
import type { NativeRegistration } from '../runtime/capability-protocol.ts';
import type { RelayQueryService } from '../network/native-relay-query.ts';
import { parseQueryFilters, verifyQueryEvent } from '../network/relay-query-contract.ts';
import { decodeNativePublishedBody } from '../napplets/native-published-https.ts';
import { classifyResourceBytes } from './resource-mime.ts';
import { ResourceError, RESOURCE_LIMITS, parseResourceURL, publicResourceHttps, resourceInfo,
  type ResourceRequest, type ResourceBytes, type ResourceErrorCode } from './resource-contract.ts';

export type ResourceAuthority = Readonly<{ nativeToken: string; assertActive(): void }>;
export interface ResourceResolvers {
  /** App-only native port: DNS/pinned TLS/body bound and captured native lease are mandatory. */
  https(url: string, signal: AbortSignal, assertActive: () => void, nativeToken: string): Promise<Uint8Array<ArrayBuffer>>;
  servers(): readonly string[];
  query?: RelayQueryService;
  sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string>;
  now?: () => number;
}
type Item = Readonly<{ url: string; ok: true; value: ResourceBytes }> |
  Readonly<{ url: string; ok: false; error: ResourceErrorCode }>;
type CacheEntry = { value: ResourceBytes; used: number };
type Active = (signal?: AbortSignal, authority?: ResourceAuthority) => void;
async function executeResource(request: ResourceRequest, authority: ResourceAuthority, active: Active,
  pending: Map<string, AbortController>, seen: Set<string>, info: () => ReturnType<typeof resourceInfo>,
  bytes: (url: string, signal: AbortSignal, authority: ResourceAuthority) => Promise<ResourceBytes>)
  : Promise<Readonly<Record<string, unknown>> | null> {
active(undefined, authority);
if (request.type === 'resource.cancel') { pending.get(request.id)?.abort(); return null; }
if (seen.has(request.id) || seen.size >= 1024) throw new ResourceError('invalid-request');
seen.add(request.id);
if (request.type === 'resource.info') return { type: 'resource.info.result', id: request.id, info: info() };
const controller = new AbortController(); pending.set(request.id, controller);
const timer = setTimeout(() => controller.abort(), RESOURCE_LIMITS.requestMs);
const watcher = setInterval(() => { try { active(undefined, authority); } catch { controller.abort(); } }, 25);
try {
  if (request.type === 'resource.bytes') return { type: 'resource.bytes.result', id: request.id, value: await bytes(request.url, controller.signal, authority) };
  const resolved = await mapResourceItems(request.urls, async url => {
    active(controller.signal, authority);
    try { return {url, ok:true, value:await bytes(url, controller.signal, authority)} as const; }
    catch(error) { active(controller.signal, authority); return {url, ok:false,
      error:error instanceof ResourceError ? error.code : 'network-error'} as const; }
  });
  let aggregate = 0;
  const items: Item[] = resolved.map(item => {
    if (!item.ok) return item;
    if (item.value.bytes.byteLength > RESOURCE_LIMITS.fileBytes - aggregate) return {url:item.url,ok:false,error:'quota-exceeded'};
    aggregate += item.value.bytes.byteLength; return item;
  });
  return { type: 'resource.bytesMany.result', id: request.id, items };
} finally { controller.abort(); clearTimeout(timer); clearInterval(watcher); pending.delete(request.id); }
}
async function nostr(resolvers: ResourceResolvers, active: Active, reference: string, signal: AbortSignal, authority: ResourceAuthority): Promise<Uint8Array<ArrayBuffer>> {
  if (!resolvers.query) throw new ResourceError('unsupported-scheme');
  let pointer: ReturnType<typeof decode>;
  try { pointer = decode(reference); } catch { throw new ResourceError('decode-failed'); }
  const filter = pointer.type === 'note' ? { ids: [pointer.data], limit: 1 }
    : pointer.type === 'nevent' ? { ids: [pointer.data.id], ...(pointer.data.author ? { authors: [pointer.data.author] } : {}), limit: 1 }
    : pointer.type === 'naddr' ? { authors: [pointer.data.pubkey], kinds: [pointer.data.kind], '#d': [pointer.data.identifier], limit: 1 } : null;
  if (!filter) throw new ResourceError('decode-failed');
  const filters = parseQueryFilters([filter]);
  const result = await resolvers.query.query(filters, signal, () => active(signal, authority));
  active(signal, authority);
  if (!result.length) throw new ResourceError('not-found');
  const event = verifyQueryEvent(result[0]!.event, filters);
  if (event.kind === 4 || event.kind === 1059) throw new ResourceError('blocked-by-policy');
  return new TextEncoder().encode(JSON.stringify(event));
}
async function resolve(resolvers: ResourceResolvers, active: Active, url: string, signal: AbortSignal, authority: ResourceAuthority): Promise<Uint8Array<ArrayBuffer>> {
  const target = parseResourceURL(url);
  if (target.scheme === 'https') return resolvers.https(target.url, signal, () => active(signal, authority), authority.nativeToken);
  if (target.scheme === 'nostr') return nostr(resolvers, active, target.reference, signal, authority);
  if (target.scheme === 'data') {
    const match = /^data:([^,]*),(.*)$/s.exec(target.url);
    if (!match) throw new ResourceError('decode-failed');
    try {
      if (/;base64$/i.test(match[1]!)) return match[2] === '' ? new Uint8Array() : decodeNativePublishedBody(match[2]);
      const output: number[] = [];
      const data = match[2]!;
      for (let i = 0; i < data.length;) {
        if (data[i] === '%') {
          if (!/^[0-9a-f]{2}$/i.test(data.slice(i + 1, i + 3))) throw new ResourceError('decode-failed');
          output.push(Number.parseInt(data.slice(i + 1, i + 3), 16)); i += 3;
        } else {
          const char = String.fromCodePoint(data.codePointAt(i)!);
          output.push(...new TextEncoder().encode(char)); i += char.length;
        }
      }
      return new Uint8Array(output);
    } catch { throw new ResourceError('decode-failed'); }
  }
  const configured = resolvers.servers();
  if (!Array.isArray(configured) || configured.length === 0 || configured.length > 4) throw new ResourceError('blocked-by-policy');
  let failure: ResourceErrorCode = 'not-found';
  for (const server of configured) {
    active(signal, authority);
    try {
      const base = new URL(publicResourceHttps(server));
      if (base.pathname !== '/' || base.search !== '') throw new ResourceError('blocked-by-policy');
      const bytes = await resolvers.https(new URL('/' + target.hash, base).href, signal, () => active(signal, authority), authority.nativeToken);
      active(signal, authority);
      if (await resolvers.sha256(bytes) !== target.hash) throw new ResourceError('decode-failed');
      active(signal, authority); return bytes;
    } catch (error) { active(signal, authority); failure = error instanceof ResourceError ? error.code : 'network-error'; }
  }
  throw new ResourceError(failure);
}
function bindResourceSession(resolvers: ResourceResolvers, process: ResourceProcess, registration: NativeRegistration, assertOwner: () => void) {
  const { sessions, now } = process;
      const captured = Object.freeze({ ...registration, domains: Object.freeze([...registration.domains]) });
      const cache = new Map<string, CacheEntry>();
      const pending = new Map<string, AbortController>();
      const seen = new Set<string>();
      let disposed = false, fetching = 0, cacheBytes = 0, deliveredBytes = 0;
      let windowStart = now(), requests = 0;
      const active = (signal?: AbortSignal, authority?: ResourceAuthority): void => {
        if (disposed || signal?.aborted) throw new ResourceError('timeout');
        assertOwner(); authority?.assertActive();
      };
      const evict = (): number => {
        const key = cache.keys().next().value;
        if (key === undefined) return 0;
        const entry = cache.get(key);
        if (!entry) return 0;
        const length = entry.value.bytes.byteLength;
        cache.delete(key); cacheBytes -= length; return length;
      };
      const lifetime = { destroy() {
        if (disposed) return;
        disposed = true; for (const value of pending.values()) value.abort(); pending.clear();
        process.cacheBytes -= cacheBytes; cacheBytes = 0; cache.clear(); seen.clear(); sessions.delete(lifetime);
      }, evict, oldest: () => cache.values().next().value?.used ?? Infinity };
      sessions.add(lifetime);
      function countURL(): void {
        const time = now();
        if (!Number.isFinite(time) || time < windowStart) throw new ResourceError('quota-exceeded');
        if (time - windowStart >= 60_000) { windowStart = time; requests = 0; }
        if (requests >= RESOURCE_LIMITS.perMinute) throw new ResourceError('quota-exceeded');
        requests++;
      }
      function charge(value: ResourceBytes): ResourceBytes {
        if (value.bytes.byteLength > RESOURCE_LIMITS.deliveredBytes - deliveredBytes) throw new ResourceError('quota-exceeded');
        deliveredBytes += value.bytes.byteLength;
        return Object.freeze({ mime: value.mime, bytes: new Uint8Array(value.bytes) });
      }
      async function bytes(url: string, signal: AbortSignal, authority: ResourceAuthority): Promise<ResourceBytes> {
        active(signal, authority); countURL(); parseResourceURL(url);
        const hit = cache.get(url);
        if (hit) { cache.delete(url); hit.used = ++process.revision; cache.set(url, hit); return charge(hit.value); }
        if (fetching >= RESOURCE_LIMITS.sessionConcurrent || process.fetching >= RESOURCE_LIMITS.processConcurrent) throw new ResourceError('quota-exceeded');
        fetching++; process.fetching++;
        const scoped = new AbortController();
        const cancelURL = () => scoped.abort();
        signal.addEventListener('abort', cancelURL, { once: true });
        if (signal.aborted) cancelURL();
        const timeout = setTimeout(cancelURL, RESOURCE_LIMITS.urlMs);
        const work = resolve(resolvers, active, url, scoped.signal, authority);
        const settled = work.finally(() => { fetching--; process.fetching--; });
        // Timeout drops delivery; an uncooperative resolver retains its reservation until it really settles.
        let abort!: () => void;
        const cancelled = new Promise<never>((_, reject) => { abort = () => reject(new ResourceError('timeout')); });
        scoped.signal.addEventListener('abort', abort, { once: true });
        try {
          if (scoped.signal.aborted) abort();
          const body = await Promise.race([settled, cancelled]); active(signal, authority); active(scoped.signal, authority);
          if (!(body instanceof Uint8Array) || body.byteLength > RESOURCE_LIMITS.fileBytes) throw new ResourceError('too-large');
          const value = Object.freeze({ bytes: new Uint8Array(body), mime: classifyResourceBytes(body) });
          const result = charge(value);
          const previous = cache.get(url);
          if (previous) { cacheBytes -= previous.value.bytes.length; process.cacheBytes -= previous.value.bytes.length; cache.delete(url); }
          cache.set(url, { value, used: ++process.revision }); cacheBytes += body.byteLength; process.cacheBytes += body.byteLength;
          while (cacheBytes > RESOURCE_LIMITS.sessionCacheBytes || cache.size > RESOURCE_LIMITS.cacheEntries) process.cacheBytes -= evict();
          evictProcess(process); return result;
        } finally { clearTimeout(timeout); signal.removeEventListener('abort', cancelURL); scoped.signal.removeEventListener('abort', abort); }
      }
      return Object.freeze({ registration: captured, revoke: lifetime.destroy,
        execute: (request: ResourceRequest, authority: ResourceAuthority) => executeResource(request, authority, active, pending, seen, () => resourceInfo(resolvers.servers().length > 0, Boolean(resolvers.query)), bytes) });

}
type ResourceProcess = { sessions: Set<{ destroy(): void; evict(): number; oldest(): number }>; now: () => number;
  fetching: number; cacheBytes: number; revision: number };
function evictProcess(process: ResourceProcess): void {
  while (process.cacheBytes > RESOURCE_LIMITS.processCacheBytes) {
    const oldest = [...process.sessions].sort((a, b) => a.oldest() - b.oldest())[0];
    if (!oldest || oldest.oldest() === Infinity) throw new ResourceError('quota-exceeded');
    process.cacheBytes -= oldest.evict();
  }
}
export function createResourceService(resolvers: ResourceResolvers) {
  const process: ResourceProcess = { sessions: new Set(), now: resolvers.now ?? (() => performance.now()), fetching: 0, cacheBytes: 0, revision: 0 };
  return Object.freeze({
    bind: (registration: NativeRegistration, assertOwner: () => void) => bindResourceSession(resolvers, process, registration, assertOwner),
    revokeAll(): void { for (const session of process.sessions) session.destroy(); },
  });
}
