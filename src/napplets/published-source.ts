import { RelayGroup } from 'applesauce-relay';
import type { GroupRequestOptions, RelayPool } from 'applesauce-relay';
import type { Filter } from 'applesauce-core/helpers/filter';
import { MAX_RELAYS_PER_ROLE, normalizeRelayUrl } from '../network/relay-settings.ts';
import type { NappletLookupCoordinate, PublishedArtifactSource } from './loader.ts';
import type { NativePublishedRelayLookup } from './native-published-relay.ts';
import { MAX_HTML_BYTES, MAX_MANIFEST_BYTES } from './verified-artifact.ts';

export const MAX_MANIFESTS_PER_QUERY = 32;
export const MAX_PUBLISHED_QUERY_BYTES = MAX_MANIFESTS_PER_QUERY * MAX_MANIFEST_BYTES;
export const MAX_BLOSSOM_SERVERS = 8;
export const DEFAULT_RELAY_TIMEOUT_MS = 10_000;
export const MAX_RELAY_TIMEOUT_MS = 60_000;
export const DEFAULT_BLOSSOM_TIMEOUT_MS = 15_000;
export const MAX_BLOSSOM_TIMEOUT_MS = 60_000;
export const MAX_RELAY_FRAME_BYTES = MAX_MANIFEST_BYTES + 1024;

export type PublishedRelayPool = Pick<RelayPool, 'request' | 'close'> & Readonly<{
  /** Asserted by the injected platform port: cap raw inbound WS frames before parsing. */
  safeguards: Readonly<{ maxFrameBytes: number; pinsPublicAddresses: true }>;
}>;
export type BoundedRelayPoolFactory = () => PublishedRelayPool;
export type BoundedFetchInit = Readonly<{
  method: 'GET';
  redirect: 'manual';
  credentials: 'omit';
  cache: 'no-store';
  signal: AbortSignal;
}>;
/**
 * The injected HTTPS port must enforce public-IP destination policy at connection
 * time and pin the validated address. React Native fetch alone cannot prevent DNS rebinding.
 */
export type PublishedHttpsFetch = (url: string, init: BoundedFetchInit) => Promise<Response>;

export type PublishedSourceOptions = Readonly<{
  /** Required: caller supplies the platform transport that enforces public-IP pinning. */
  fetchPublicHttps: PublishedHttpsFetch;
  /** Required: caps raw frames before JSON parsing and pins each relay's public IP at connection time. */
  createRelayPool: BoundedRelayPoolFactory;
  relayTimeoutMs?: number;
  blossomTimeoutMs?: number;
}>;
export type NativePublishedSourceOptions = Readonly<{
  /** App-only native WSS lookup port. It receives only the selected lookup relays. */
  relayLookup: NativePublishedRelayLookup;
  /** Required: platform transport enforces public-IP pinning for Blossom HTTPS. */
  fetchPublicHttps: PublishedHttpsFetch;
  blossomTimeoutMs?: number;
}>;

class PublishedSourceError extends Error {
  constructor(cause?: unknown) { super('Published napplet transport failed', { cause }); this.name = 'PublishedSourceError'; }
}
const fail = (): never => { throw new PublishedSourceError(); };
const HEX64 = /^[0-9a-f]{64}$/;
const nativeBoundedBodies = new WeakMap<Response, Uint8Array>();

/** Native already capped and decoded these bytes; never grant this fallback to an ordinary network Response. */
export function createNativeBoundedResponse(bytes: Uint8Array): Response {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_HTML_BYTES) return fail();
  const boundedBytes = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  boundedBytes.set(bytes);
  const response = new Response(boundedBytes, { status: 200, headers: { 'content-length': String(boundedBytes.byteLength) } });
  nativeBoundedBodies.set(response, boundedBytes);
  return response;
}

function boundedTimeout(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) return fail();
  return value;
}

function checkedLookupRelays(input: readonly string[]): string[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_RELAYS_PER_ROLE) return fail();
  const relays = input.map(value => {
    try { return normalizeRelayUrl(value); } catch { return fail(); }
  });
  if (new Set(relays).size !== relays.length) return fail();
  return relays;
}

function safeQueryEvent(value: unknown): { event: unknown; byteLength: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors).filter((key): key is string => typeof key === 'string');
  const fields = ['id', 'pubkey', 'created_at', 'kind', 'tags', 'content', 'sig'] as const;
  if (keys.length !== fields.length || fields.some(key => !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key]!, 'value'))) return fail();
  const record = Object.fromEntries(fields.map(key => [key, descriptors[key]!.value]));
  if (typeof record.id !== 'string' || typeof record.pubkey !== 'string' || typeof record.sig !== 'string' ||
      typeof record.content !== 'string' || typeof record.created_at !== 'number' || !Number.isFinite(record.created_at) ||
      typeof record.kind !== 'number' || !Number.isFinite(record.kind)) return fail();
  const encodedStringLength = (value: string, limit: number): number => {
    let size = 2;
    for (let index = 0; index < value.length; index++) {
      const unit = value.charCodeAt(index);
      if (unit === 0x22 || unit === 0x5c || unit < 0x20) size += unit < 0x20 ? 6 : 2;
      else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < value.length && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
        size += 4; index++;
      } else if (unit >= 0xd800 && unit <= 0xdfff) size += 6;
      else if (unit <= 0x7f) size++;
      else if (unit <= 0x7ff) size += 2;
      else size += 3;
      if (size > limit) return limit + 1;
    }
    return size;
  };
  let byteLength = new TextEncoder().encode('{"id":"","pubkey":"","created_at":0,"kind":0,"tags":[],"content":"","sig":""}').byteLength;
  const addString = (value: string, baselineQuotes = true): void => {
    const length = encodedStringLength(value, MAX_MANIFEST_BYTES - byteLength + (baselineQuotes ? 2 : 0));
    byteLength += length - (baselineQuotes ? 2 : 0);
    if (byteLength > MAX_MANIFEST_BYTES) fail();
  };
  addString(record.id as string);
  addString(record.pubkey as string);
  addString(record.content as string);
  addString(record.sig as string);
  byteLength += JSON.stringify(record.created_at).length - 1 + JSON.stringify(record.kind).length - 1;
  if (byteLength > MAX_MANIFEST_BYTES) return fail();
  const tags = record.tags;
  if (!Array.isArray(tags) || Object.getPrototypeOf(tags) !== Array.prototype || tags.length > MAX_MANIFEST_BYTES || Reflect.ownKeys(tags).length !== tags.length + 1) return fail();
  const copiedTags: string[][] = [];
  for (let index = 0; index < tags.length; index++) {
    const tagDescriptor = Object.getOwnPropertyDescriptor(tags, String(index));
    if (!tagDescriptor || !Object.hasOwn(tagDescriptor, 'value')) return fail();
    const tag = tagDescriptor.value;
    if (!Array.isArray(tag) || Object.getPrototypeOf(tag) !== Array.prototype || tag.length > MAX_MANIFEST_BYTES ||
        Reflect.ownKeys(tag).length !== tag.length + 1) return fail();
    const copied: string[] = [];
    for (let item = 0; item < tag.length; item++) {
      const itemDescriptor = Object.getOwnPropertyDescriptor(tag, String(item));
      if (!itemDescriptor || !Object.hasOwn(itemDescriptor, 'value') || typeof itemDescriptor.value !== 'string') return fail();
      byteLength += encodedStringLength(itemDescriptor.value, MAX_MANIFEST_BYTES - byteLength);
      if (byteLength > MAX_MANIFEST_BYTES) return fail();
      if (item > 0) byteLength++;
      copied.push(itemDescriptor.value);
    }
    byteLength += 2;
    if (index > 0) byteLength++;
    if (byteLength > MAX_MANIFEST_BYTES) return fail();
    copiedTags.push(copied);
  }
  const event = { ...record, tags: copiedTags };
  let exactByteLength: number;
  try { exactByteLength = new TextEncoder().encode(JSON.stringify(event)).byteLength; } catch { return fail(); }
  if (exactByteLength > MAX_MANIFEST_BYTES) return fail();
  return { event, byteLength: exactByteLength };
}

function publicHttpsBase(value: string): URL {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  const labels = hostname.split('.');
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      !hostname.includes('.') || hostname.includes(':') || /^[0-9.]+$/.test(hostname) ||
      labels.some(label => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) ||
      ['localhost', 'local', 'internal', 'home.arpa', 'lan', 'test', 'example', 'invalid', 'onion', 'arpa'].some(suffix => hostname === suffix || hostname.endsWith(`.${suffix}`))) throw new PublishedSourceError();
  return url;
}

function makeAbortScope(parent: AbortSignal, timeoutMs: number): { signal: AbortSignal; close: () => void } {
  const controller = new AbortController();
  const abortFromParent = (): void => controller.abort(parent.reason);
  if (parent.aborted) abortFromParent();
  else parent.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('transport timeout')), timeoutMs);
  return { signal: controller.signal, close: () => { clearTimeout(timer); parent.removeEventListener('abort', abortFromParent); } };
}

async function readBoundedBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const lengthHeader = response.headers.get('content-length');
  if (lengthHeader !== null) {
    if (!/^\d+$/.test(lengthHeader)) return fail();
    const declared = Number(lengthHeader);
    if (!Number.isSafeInteger(declared) || declared > maxBytes) return fail();
  }
  const nativeBytes = nativeBoundedBodies.get(response);
  if (nativeBytes !== undefined) {
    if (signal.aborted || nativeBytes.byteLength > maxBytes) return fail();
    return new Uint8Array(nativeBytes);
  }
  const reader = response.body?.getReader();
  if (!reader) return fail();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) return fail();
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) { await reader.cancel(); return fail(); }
      chunks.push(new Uint8Array(result.value));
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function queryManifests(poolFactory: BoundedRelayPoolFactory, relayTimeoutMs: number, coordinate: NappletLookupCoordinate,
  relaysInput: readonly string[], pinnedEventId: string | null, signal: AbortSignal): Promise<readonly unknown[]> {
  const relays = checkedLookupRelays(relaysInput);
  if (coordinate.kind !== 35129 || !/^[0-9a-f]{64}$/.test(coordinate.pubkey) || typeof coordinate.identifier !== 'string' || signal.aborted ||
      (pinnedEventId !== null && !HEX64.test(pinnedEventId))) return Promise.reject(new PublishedSourceError());
  const filter = { kinds: [35129], authors: [coordinate.pubkey], '#d': [coordinate.identifier], limit: MAX_MANIFESTS_PER_QUERY,
    ...(pinnedEventId === null ? {} : { ids: [pinnedEventId] }) } as Filter;
  const options: GroupRequestOptions = {
    timeout: relayTimeoutMs, reconnect: false, waitForAuth: false, eventStore: null,
    complete: RelayGroup.completeOnAllEose(),
  };
  const pool = poolFactory();
  if (typeof pool?.request !== 'function' || typeof pool.close !== 'function' ||
      pool.safeguards?.pinsPublicAddresses !== true || !Number.isSafeInteger(pool.safeguards.maxFrameBytes) ||
      pool.safeguards.maxFrameBytes > MAX_RELAY_FRAME_BYTES || pool.safeguards.maxFrameBytes < 1) {
    return Promise.reject(new PublishedSourceError());
  }
  return new Promise((resolve, reject) => {
    const events: unknown[] = [];
    let totalBytes = 0;
    let settled = false;
    let subscription: { unsubscribe: () => void } | null = null;
    const timer = setTimeout(() => finish(new PublishedSourceError()), relayTimeoutMs);
    const abort = (): void => finish(new PublishedSourceError());
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      try { subscription?.unsubscribe(); } catch { /* cleanup */ }
      try { pool.close(); } catch { /* cleanup */ }
    };
    function finish(error?: Error): void {
      if (settled) return;
      settled = true; cleanup();
      if (error) reject(error); else resolve(Object.freeze(events.slice()));
    }
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    try {
      const stream = pool.request(relays, filter, options);
      subscription = stream.subscribe({
        next(event) {
          if (settled || signal.aborted || events.length >= MAX_MANIFESTS_PER_QUERY) { finish(new PublishedSourceError()); return; }
          try {
            const bounded = safeQueryEvent(event);
            totalBytes += bounded.byteLength;
            if (totalBytes > MAX_PUBLISHED_QUERY_BYTES) { finish(new PublishedSourceError()); return; }
            events.push(bounded.event);
          } catch { finish(new PublishedSourceError()); }
        },
        error() { finish(new PublishedSourceError()); },
        complete() { finish(); },
      });
    } catch { finish(new PublishedSourceError()); }
  });
}

async function readBlossom(expectedHash: string, serverHints: readonly string[], maxBytes: number,
  timeoutMs: number, signal: AbortSignal, fetchPublicHttps: PublishedHttpsFetch): Promise<Uint8Array> {
  if (!HEX64.test(expectedHash) || !Array.isArray(serverHints) || serverHints.length === 0 || serverHints.length > MAX_BLOSSOM_SERVERS ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_HTML_BYTES || signal.aborted) return fail();
  const failures: unknown[] = [];
  for (const hint of serverHints) {
    if (signal.aborted) return fail();
    let base: URL;
    try {
      if (typeof hint !== 'string') throw new PublishedSourceError();
      base = publicHttpsBase(hint);
    } catch (error) { failures.push(error); continue; }
    const target = new URL(`/${expectedHash}`, base);
    const scope = makeAbortScope(signal, timeoutMs);
    try {
      const response = await fetchPublicHttps(target.href, {
        method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: scope.signal,
      });
      if (signal.aborted || scope.signal.aborted || response.status !== 200 || response.redirected || response.type === 'opaqueredirect' ||
          (response.url !== '' && new URL(response.url).origin !== target.origin)) {
        try { await response.body?.cancel(); } catch { /* rejected response */ }
        throw new PublishedSourceError();
      }
      const bytes = await readBoundedBody(response, maxBytes, scope.signal);
      if (await sha256(bytes) !== expectedHash) throw new PublishedSourceError();
      return bytes;
    } catch (error) {
      if (signal.aborted) return fail();
      failures.push(error);
    } finally { scope.close(); }
  }
  throw new PublishedSourceError(failures.at(-1));
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  let digest: ArrayBuffer;
  if (globalThis.crypto?.subtle) digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
  else {
    const { digest: expoDigest, CryptoDigestAlgorithm } = await import('expo-crypto');
    digest = await expoDigest(CryptoDigestAlgorithm.SHA256, new Uint8Array(buffer));
  }
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Creates a relay/Blossom source. The supplied HTTPS port must enforce connection-time public-IP pinning. */
export function createPublishedArtifactSource(options: PublishedSourceOptions): PublishedArtifactSource {
  const relayTimeoutMs = boundedTimeout(options.relayTimeoutMs, DEFAULT_RELAY_TIMEOUT_MS, MAX_RELAY_TIMEOUT_MS);
  const blossomTimeoutMs = boundedTimeout(options.blossomTimeoutMs, DEFAULT_BLOSSOM_TIMEOUT_MS, MAX_BLOSSOM_TIMEOUT_MS);
  if (typeof options.fetchPublicHttps !== 'function' || typeof options.createRelayPool !== 'function') return fail();
  const poolFactory = options.createRelayPool;
  return Object.freeze({
    query: (coordinate: NappletLookupCoordinate, lookupRelays: readonly string[], pinnedEventId: string | null, signal: AbortSignal) =>
      queryManifests(poolFactory, relayTimeoutMs, coordinate, lookupRelays, pinnedEventId, signal),
    readHtml: (expectedHash: string, serverHints: readonly string[], maxBytes: number, signal: AbortSignal) =>
      readBlossom(expectedHash, serverHints, maxBytes, blossomTimeoutMs, signal, options.fetchPublicHttps),
  });
}

/** Uses the native WSS lookup path while sharing the existing bounded Blossom/hash reader. */
export function createNativePublishedArtifactSource(options: NativePublishedSourceOptions): PublishedArtifactSource {
  const blossomTimeoutMs = boundedTimeout(options.blossomTimeoutMs, DEFAULT_BLOSSOM_TIMEOUT_MS, MAX_BLOSSOM_TIMEOUT_MS);
  if (typeof options.fetchPublicHttps !== 'function' || typeof options.relayLookup?.query !== 'function') return fail();
  return Object.freeze({
    query: (coordinate: NappletLookupCoordinate, lookupRelays: readonly string[], pinnedEventId: string | null, signal: AbortSignal) =>
      options.relayLookup.query(coordinate, lookupRelays, pinnedEventId, signal),
    readHtml: (expectedHash: string, serverHints: readonly string[], maxBytes: number, signal: AbortSignal) =>
      readBlossom(expectedHash, serverHints, maxBytes, blossomTimeoutMs, signal, options.fetchPublicHttps),
  });
}
