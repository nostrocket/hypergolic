import { MAX_RELAYS_PER_ROLE, normalizeRelayUrl } from '../network/relay-settings.ts';
import type { NappletLookupCoordinate } from './loader.ts';
import { MAX_PUBLISHED_QUERY_BYTES, MAX_MANIFESTS_PER_QUERY, DEFAULT_RELAY_TIMEOUT_MS } from './published-source.ts';
import { buildPublishedRelayRequest } from './published-relay-request.ts';
import { parsePublishedRelayMessage } from './published-relay-wire.ts';

export interface NativePublishedRelayPort {
  newInstanceId(): string;
  queryPublishedRelay(operationId: string, url: string, requestText: string, subscriptionId: string): Promise<string[]>;
  cancelPublishedRelay(operationId: string): void;
  revokeAllPublishedRelay(): void;
}

export class NativePublishedRelayError extends Error {
  readonly code = 'PUBLISHED_RELAY_QUERY_FAILED';
  constructor() { super('The published napplet relay query failed'); this.name = 'NativePublishedRelayError'; }
}

export type NativePublishedRelayLookup = Readonly<{
  query(coordinate: NappletLookupCoordinate, lookupRelays: readonly string[], pinnedEventId: string | null,
    signal: AbortSignal): Promise<readonly unknown[]>;
}>;

const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_NATIVE_RELAY_OPERATIONS = 4;
const MAX_NATIVE_TEXT_MESSAGES = 64;
const MAX_NATIVE_TEXT_BYTES = 2 * 1024 * 1024;
const fail = (): never => { throw new NativePublishedRelayError(); };

function selectedRelays(input: readonly string[]): string[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_RELAYS_PER_ROLE) return fail();
  const relays = input.map(value => {
    try { return normalizeRelayUrl(value); } catch { return fail(); }
  });
  if (new Set(relays).size !== relays.length) return fail();
  return relays;
}

function candidateEvents(frames: unknown, subscriptionId: string): unknown[] {
  if (!Array.isArray(frames) || Object.getPrototypeOf(frames) !== Array.prototype || frames.length < 1 ||
      frames.length > MAX_NATIVE_TEXT_MESSAGES || Reflect.ownKeys(frames).length !== frames.length + 1) return fail();
  const events: unknown[] = [];
  let eventBytes = 0;
  let textBytes = 0;
  let eose = false;
  for (let index = 0; index < frames.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(frames, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || eose || typeof descriptor.value !== 'string') return fail();
    textBytes += new TextEncoder().encode(descriptor.value).byteLength;
    if (textBytes > MAX_NATIVE_TEXT_BYTES) return fail();
    let message;
    try { message = parsePublishedRelayMessage(descriptor.value, subscriptionId); } catch { return fail(); }
    if (message.type === 'event') {
      eventBytes += encodedSize(message.event);
      if (events.length >= MAX_MANIFESTS_PER_QUERY || eventBytes > MAX_PUBLISHED_QUERY_BYTES) return fail();
      events.push(message.event);
    }
    else if (message.type === 'eose') eose = true;
    else if (message.type === 'notice' || message.type === 'auth') continue;
    else return fail();
  }
  if (!eose) return fail();
  return events;
}

function encodedSize(event: unknown): number {
  try {
    const encoded = JSON.stringify(event);
    if (typeof encoded !== 'string') return fail();
    return new TextEncoder().encode(encoded).byteLength;
  } catch { return fail(); }
}

/**
 * Query only the selected, normalized lookup relays through the app-only native
 * WSS port. One deadline covers the complete fan-out; aborts, deadline expiry,
 * and shared budget violations cancel outstanding work. Individual relay
 * failures are isolated while another selected relay can still provide results.
 * Returned events are parsed envelopes only and remain unverified until the
 * artifact loader verifies signatures and content.
 */
export function createNativePublishedRelayLookup(
  port: NativePublishedRelayPort,
  timeoutMs = DEFAULT_RELAY_TIMEOUT_MS,
): NativePublishedRelayLookup {
  if (typeof port?.newInstanceId !== 'function' || typeof port.queryPublishedRelay !== 'function' ||
      typeof port.cancelPublishedRelay !== 'function' || typeof port.revokeAllPublishedRelay !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_RELAY_TIMEOUT_MS) return fail();

  return Object.freeze({
    query(coordinate: NappletLookupCoordinate, lookupRelays: readonly string[], pinnedEventId: string | null,
      signal: AbortSignal): Promise<readonly unknown[]> {
      let relays: string[];
      let request: ReturnType<typeof buildPublishedRelayRequest>;
      try {
        relays = selectedRelays(lookupRelays);
        if (pinnedEventId !== null && !HEX64.test(pinnedEventId)) return Promise.reject(new NativePublishedRelayError());
        request = buildPublishedRelayRequest(coordinate, pinnedEventId ?? undefined);
      } catch { return Promise.reject(new NativePublishedRelayError()); }
      if (signal.aborted) return Promise.reject(new NativePublishedRelayError());

      return new Promise((resolve, reject) => {
        const outstanding = new Set<string>();
        const usedIds = new Set<string>();
        const events: unknown[] = [];
        let totalBytes = 0;
        let closed = false;
        let timer: ReturnType<typeof setTimeout>;
        const cancelOutstanding = (): void => {
          for (const id of outstanding) {
            outstanding.delete(id);
            try { port.cancelPublishedRelay(id); } catch { /* Native expiry remains the backstop. */ }
          }
        };
        const cleanup = (): void => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
        };
        const finishError = (): void => {
          if (closed) return;
          closed = true;
          cleanup();
          cancelOutstanding();
          reject(new NativePublishedRelayError());
        };
        const abort = (): void => finishError();
        timer = setTimeout(finishError, timeoutMs);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) { abort(); return; }

        let nextRelay = 0;
        let successfulRelays = 0;
        const queryRelay = async (relay: string): Promise<void> => {
          let id: string;
          try { id = port.newInstanceId(); } catch { return; }
          if (typeof id !== 'string' || !UUID.test(id) || usedIds.has(id)) return;
          usedIds.add(id);
          outstanding.add(id);
          let frames: string[];
          try { frames = await port.queryPublishedRelay(id, relay, request.wire, request.subscriptionId); }
          catch { outstanding.delete(id); return; }
          outstanding.delete(id);
          if (closed) return;
          let relayEvents: unknown[];
          try { relayEvents = candidateEvents(frames, request.subscriptionId); }
          catch { return; }
          for (const event of relayEvents) {
            const eventByteLength = encodedSize(event);
            if (events.length >= MAX_MANIFESTS_PER_QUERY || totalBytes > MAX_PUBLISHED_QUERY_BYTES - eventByteLength) {
              finishError(); return;
            }
            totalBytes += eventByteLength;
            events.push(event);
          }
          successfulRelays++;
        };
        const worker = (): Promise<void> => {
          if (closed || nextRelay >= relays.length) return Promise.resolve();
          const relay = relays[nextRelay++]!;
          return queryRelay(relay).then(worker);
        };
        const workers = Array.from({ length: Math.min(MAX_NATIVE_RELAY_OPERATIONS, relays.length) }, () => worker());

        void Promise.all(workers).then(() => {
          if (closed || signal.aborted) return;
          if (successfulRelays === 0) { finishError(); return; }
          closed = true;
          cleanup();
          resolve(Object.freeze(events));
        }, finishError);
      });
    },
  });
}
