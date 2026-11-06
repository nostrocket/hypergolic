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
  query(coordinate: NappletLookupCoordinate, relays: readonly string[], pinnedEventId: string | null,
    signal: AbortSignal, discovery?: true): Promise<readonly unknown[]>;
}>;

const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_NATIVE_RELAY_OPERATIONS = 4;
const MAX_NATIVE_TEXT_MESSAGES = 64;
const MAX_NATIVE_TEXT_BYTES = 2 * 1024 * 1024;
const fail = (): never => { throw new NativePublishedRelayError(); };

function selectedRelays(input: readonly string[], discovery?: true): string[] {
  const maximum = discovery ? MAX_RELAYS_PER_ROLE * 2 : MAX_RELAYS_PER_ROLE;
  if (!Array.isArray(input) || input.length < 1 || input.length > maximum) return fail();
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
 * Query selected, normalized destinations through the app-only native WSS port.
 * One deadline covers fan-out and a Discover retry of an incomplete empty read.
 * Aborts, deadline expiry,
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
    query(coordinate: NappletLookupCoordinate, destinations: readonly string[], pinnedEventId: string | null,
      signal: AbortSignal, discovery?: true): Promise<readonly unknown[]> {
      let relays: string[];
      let request: ReturnType<typeof buildPublishedRelayRequest>;
      try {
        relays = selectedRelays(destinations, discovery);
        if (pinnedEventId !== null && (discovery || !HEX64.test(pinnedEventId))) return Promise.reject(new NativePublishedRelayError());
        request = buildPublishedRelayRequest(coordinate, pinnedEventId ?? undefined);
      } catch { return Promise.reject(new NativePublishedRelayError()); }
      if (signal.aborted) return Promise.reject(new NativePublishedRelayError());

      return new Promise((resolve, reject) => {
        const outstanding = new Set<string>();
        const attempted = new Set<string>();
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
        const finish = (success: boolean): void => {
          if (closed) return;
          closed = true;
          cleanup();
          cancelOutstanding();
          if (success && !signal.aborted) resolve(Object.freeze(events));
          else reject(new NativePublishedRelayError());
        };
        const abort = (): void => finish(false);
        timer = setTimeout(() => finish(discovery === true && attempted.size === relays.length && events.length > 0), timeoutMs);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) { abort(); return; }

        const queryRelay = async (relay: string): Promise<boolean> => {
          let id: string;
          try { id = port.newInstanceId(); } catch { return false; }
          if (typeof id !== 'string' || !UUID.test(id) || usedIds.has(id)) return false;
          usedIds.add(id);
          outstanding.add(id);
          attempted.add(relay);
          let frames: string[];
          try { frames = await port.queryPublishedRelay(id, relay, request.wire, request.subscriptionId); }
          catch { outstanding.delete(id); return false; }
          outstanding.delete(id);
          if (closed) return false;
          let relayEvents: unknown[];
          try { relayEvents = candidateEvents(frames, request.subscriptionId); }
          catch { return false; }
          for (const event of relayEvents) {
            const eventByteLength = encodedSize(event);
            if (events.length >= MAX_MANIFESTS_PER_QUERY || totalBytes > MAX_PUBLISHED_QUERY_BYTES - eventByteLength) {
              finish(false); return false;
            }
            totalBytes += eventByteLength;
            events.push(event);
          }
          return true;
        };
        const queryRound = async (queue: readonly string[]): Promise<string[]> => {
          let next = 0;
          const failed: string[] = [];
          const worker = async (): Promise<void> => {
            while (!closed && next < queue.length) {
              const relay = queue[next++]!;
              if (!await queryRelay(relay)) failed.push(relay);
            }
          };
          await Promise.all(Array.from({ length: Math.min(MAX_NATIVE_RELAY_OPERATIONS, queue.length) }, worker));
          return failed;
        };
        const complete = async () => {
          let failed = await queryRound(relays);
          if (discovery && !closed && events.length === 0 && failed.length > 0) failed = await queryRound(failed);
          if (closed || signal.aborted) return;
          finish(failed.length !== relays.length && (!discovery || events.length > 0 || failed.length === 0));
        };
        void complete().catch(() => finish(false));
      });
    },
  });
}
