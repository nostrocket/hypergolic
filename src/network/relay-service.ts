import { Relay, type RelayOptions } from 'applesauce-relay';
import { captureEventSnapshot } from '../security/event-snapshot.ts';
import { validateSignedEvent, type VerifiedSignedEvent } from '../security/signed-event.ts';

export type RelayOutcomeStatus = 'accepted' | 'rejected' | 'unknown' | 'cancelled-before-send';
export type RelayOutcome = Readonly<{ relay: string; eventId: string; status: RelayOutcomeStatus; reason: string }>;
export type RelayExecution = Readonly<{ assertActive: () => void; signal: AbortSignal }>;
export type RelayPublishOptions = Readonly<{ WebSocket?: RelayOptions['WebSocket']; timeoutMs?: number }>;

export class RelayServiceError extends Error {
  readonly code = 'INVALID_RELAY_INPUT';
  constructor() { super('Invalid relay input'); this.name = 'RelayServiceError'; }
}

const FIELDS = ['id', 'pubkey', 'created_at', 'kind', 'tags', 'content', 'sig'] as const;
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const fail = (): never => { throw new RelayServiceError(); };
type WebSocketConstructor = NonNullable<RelayOptions['WebSocket']>;

function wireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== FIELDS.length || FIELDS.some((key) => !own(descriptors, key) || !own(descriptors[key]!, 'value'))) return fail();
  return value as Record<string, unknown>;
}

function prepare(event: unknown, destinations: readonly string[]): { event: VerifiedSignedEvent; destinations: readonly string[] } {
  try {
    const wire = wireRecord(event);
    if (wire.kind === 22242) return fail();
    const snapshot = captureEventSnapshot({ kind: wire.kind, content: wire.content, tags: wire.tags, created_at: wire.created_at }, wire.pubkey, destinations);
    const verified = validateSignedEvent(snapshot, wire);
    return { event: verified, destinations: snapshot.destinations };
  } catch (error) {
    if (error instanceof RelayServiceError) throw error;
    throw new RelayServiceError();
  }
}

type GuardState = { attempted: boolean; terminal: boolean };

function guardedWebSocket(Base: WebSocketConstructor, expectedFrame: string, execution: RelayExecution, state: GuardState): WebSocketConstructor {
  class GuardedWebSocket extends Base {
    constructor(url: string, protocols?: string | string[]) {
      if (state.terminal || execution.signal.aborted) throw new Error('RELAY_REVOKED');
      execution.assertActive();
      super(url, protocols);
      const send = this.send.bind(this);
      this.send = (frame: string | ArrayBufferLike | Blob | ArrayBufferView) => {
        if (state.terminal || state.attempted) throw new Error('RELAY_FRAME_DENIED');
        execution.assertActive();
        if (execution.signal.aborted || typeof frame !== 'string' || frame !== expectedFrame) throw new Error('RELAY_FRAME_DENIED');
        state.attempted = true;
        send(frame);
      };
    }
  }
  return GuardedWebSocket;
}

function publishOne(event: VerifiedSignedEvent, relayUrl: string, execution: RelayExecution, options: RelayPublishOptions): Promise<RelayOutcome> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const wireEvent = { ...event, tags: event.tags.map((tag) => [...tag]) };
  const expectedFrame = JSON.stringify(['EVENT', wireEvent]);
  const state: GuardState = { attempted: false, terminal: false };
  let relay: Relay | null = null;
  let eventSubscription: { unsubscribe: () => void } | null = null;
  let rawSubscription: { unsubscribe: () => void } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  return new Promise((resolve) => {
    let finished = false;
    const cleanup = (): void => {
      try { eventSubscription?.unsubscribe(); } catch { /* terminal cleanup */ }
      try { rawSubscription?.unsubscribe(); } catch { /* terminal cleanup */ }
      try { relay?.close(); } catch { /* terminal cleanup */ }
    };
    const finish = (status: RelayOutcomeStatus, reason: string): void => {
      if (finished) return;
      finished = true; state.terminal = true;
      if (timer !== null) clearTimeout(timer);
      execution.signal.removeEventListener('abort', onAbort);
      cleanup();
      resolve(Object.freeze({ relay: relayUrl, eventId: event.id, status, reason }));
    };
    const onAbort = (): void => finish(state.attempted ? 'unknown' : 'cancelled-before-send', 'aborted');
    const cancelled = (): RelayOutcomeStatus => state.attempted ? 'unknown' : 'cancelled-before-send';
    if (execution.signal.aborted) return onAbort();
    execution.signal.addEventListener('abort', onAbort, { once: true });
    try {
      execution.assertActive();
      const Base = options.WebSocket ?? (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
      if (!Base) return finish('cancelled-before-send', 'websocket unavailable');
      const Guarded = guardedWebSocket(Base, expectedFrame, execution, state);
      relay = new Relay(relayUrl, { WebSocket: Guarded, eventTimeout: timeoutMs, enablePing: false, onUnresponsive: () => 'close' });
      const raw = relay.message$.subscribe((message: unknown) => {
        if (!state.attempted || state.terminal || !Array.isArray(message) || message[0] !== 'OK' || message[1] !== event.id) return;
        try { execution.assertActive(); } catch { finish('unknown', 'revoked'); return; }
        if (execution.signal.aborted) { finish('unknown', 'aborted'); return; }
        if (message.length !== 4 || typeof message[2] !== 'boolean' || typeof message[3] !== 'string' || message[3].length > 4096) { finish('unknown', 'malformed OK'); return; }
        finish(message[2] ? 'accepted' : 'rejected', message[3]);
      });
      rawSubscription = raw;
      if (finished) raw.unsubscribe();
      const eventSub = relay.event(wireEvent).subscribe({ error: () => finish(cancelled(), 'relay error') });
      eventSubscription = eventSub;
      if (finished) eventSub.unsubscribe();
      timer = setTimeout(() => finish(cancelled(), 'timeout'), timeoutMs);
      if (finished) clearTimeout(timer);
    } catch {
      finish(cancelled(), 'relay setup');
    }
  });
}

export async function publishEvent(event: VerifiedSignedEvent, destinations: readonly string[], execution: RelayExecution, options: RelayPublishOptions = {}): Promise<readonly RelayOutcome[]> {
  const prepared = prepare(event, destinations);
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 600_000)) fail();
  return Object.freeze(await Promise.all(prepared.destinations.map((relay) => publishOne(prepared.event, relay, execution, options))));
}
