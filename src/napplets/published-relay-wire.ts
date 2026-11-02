import { MAX_RELAY_FRAME_BYTES } from './published-source.ts';

export class PublishedRelayWireError extends Error {
  readonly code = 'PUBLISHED_RELAY_WIRE_FAILED';
  constructor() { super('The published napplet relay response was invalid'); this.name = 'PublishedRelayWireError'; }
}

export type PublishedRelayMessage =
  | Readonly<{ type: 'event'; event: unknown }>
  | Readonly<{ type: 'eose' }>
  | Readonly<{ type: 'auth' }>
  | Readonly<{ type: 'closed'; reason: string }>
  | Readonly<{ type: 'notice'; message: string }>;

const SUBSCRIPTION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const fail = (): never => { throw new PublishedRelayWireError(); };

/** Parses one bounded NIP-01 relay message after the native raw-frame gate. */
export function parsePublishedRelayMessage(text: unknown, subscriptionId: string): PublishedRelayMessage {
  if (typeof text !== 'string' || text.length > MAX_RELAY_FRAME_BYTES || !SUBSCRIPTION_ID.test(subscriptionId) ||
      new TextEncoder().encode(text).byteLength > MAX_RELAY_FRAME_BYTES) return fail();
  let message: unknown;
  try { message = JSON.parse(text); } catch { return fail(); }
  if (!Array.isArray(message) || message.length < 2 || typeof message[0] !== 'string') return fail();
  if (message[0] === 'EVENT' && message.length === 3 && message[1] === subscriptionId &&
      typeof message[2] === 'object' && message[2] !== null && !Array.isArray(message[2])) {
    return Object.freeze({ type: 'event', event: message[2] });
  }
  if (message[0] === 'EOSE' && message.length === 2 && message[1] === subscriptionId) {
    return Object.freeze({ type: 'eose' });
  }
  if (message[0] === 'CLOSED' && message.length === 3 && message[1] === subscriptionId &&
      typeof message[2] === 'string' && message[2].length <= 256 && new TextEncoder().encode(message[2]).byteLength <= 256) {
    return Object.freeze({ type: 'closed', reason: message[2] });
  }
  // A relay may announce optional NIP-42 support without requiring authentication.
  // Do not retain or expose its challenge, and never construct a client AUTH reply.
  if (message[0] === 'AUTH' && message.length === 2 && typeof message[1] === 'string') {
    return Object.freeze({ type: 'auth' });
  }
  if (message[0] === 'NOTICE' && message.length === 2 && typeof message[1] === 'string' && message[1].length <= 256 &&
      new TextEncoder().encode(message[1]).byteLength <= 256) {
    return Object.freeze({ type: 'notice', message: message[1] });
  }
  return fail();
}
