import type { NappletLookupCoordinate } from './loader.ts';
import {isPublishedEventId} from './published-identity.ts';

export const MAX_PUBLISHED_REQ_BYTES = 8 * 1024;
const MAX_SUBSCRIPTION_ID_BYTES = 64;
const HEX64 = /^[0-9a-f]{64}$/;
const SUBSCRIPTION_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class PublishedRelayRequestError extends Error {
  readonly code = 'PUBLISHED_RELAY_REQUEST_FAILED';
  constructor() { super('The published napplet relay request was invalid'); this.name = 'PublishedRelayRequestError'; }
}

export type PublishedRelayRequest = Readonly<{ subscriptionId: string; wire: string }>;

const fail = (): never => { throw new PublishedRelayRequestError(); };

function coordinateFields(value: unknown): NappletLookupCoordinate {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (descriptors.kind?.value === 5129) {
    const fields = ['kind','eventId',...(Object.hasOwn(descriptors,'pubkey') ? ['pubkey'] : [])];
    if (Reflect.ownKeys(descriptors).length !== fields.length ||
        fields.some(field => !descriptors[field] || !Object.hasOwn(descriptors[field]!, 'value'))) return fail();
    const eventId = descriptors.eventId?.value, pubkey = descriptors.pubkey?.value;
    if (!isPublishedEventId(eventId) || (fields.length === 3 && !isPublishedEventId(pubkey))) return fail();
    return Object.freeze({kind:5129,eventId,...(pubkey === undefined ? {} : {pubkey})});
  }
  const fields = ['kind', 'pubkey', 'identifier'] as const;
  if (Reflect.ownKeys(descriptors).length !== fields.length || fields.some(field => {
    const descriptor = descriptors[field];
    return descriptor === undefined || !Object.hasOwn(descriptor, 'value');
  })) return fail();
  const kind = descriptors.kind!.value;
  const pubkey = descriptors.pubkey!.value;
  const identifier = descriptors.identifier!.value;
  if (kind !== 35129 || typeof pubkey !== 'string' || !HEX64.test(pubkey) || typeof identifier !== 'string' ||
      identifier.length === 0 || identifier.trim() !== identifier || /[\u0000-\u001f\u007f]/.test(identifier) ||
      new TextEncoder().encode(identifier).byteLength > 255) return fail();
  return Object.freeze({ kind: 35129, pubkey, identifier });
}

function generatedSubscriptionId(): string {
  try {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    let value = '';
    for (const byte of bytes) value += byte.toString(16).padStart(2, '0');
    bytes.fill(0);
    return value;
  } catch { return fail(); }
}

export function publishedRelayFilter(coordinateInput: NappletLookupCoordinate, pinnedEventId?: string) {
  const coordinate = coordinateFields(coordinateInput);
  if (pinnedEventId !== undefined && (typeof pinnedEventId !== 'string' || !HEX64.test(pinnedEventId))) return fail();
  if (coordinate.kind === 5129) {
    if (pinnedEventId !== undefined && pinnedEventId !== coordinate.eventId) return fail();
    return Object.freeze({ids:[coordinate.eventId],kinds:[5129],
      ...(coordinate.pubkey ? {authors:[coordinate.pubkey]} : {}),limit:1});
  }
  return Object.freeze({
    ...(pinnedEventId === undefined ? {} : { ids: Object.freeze([pinnedEventId]) }),
    kinds: Object.freeze([35129]),
    authors: Object.freeze([coordinate.pubkey]),
    '#d': Object.freeze([coordinate.identifier]),
    limit: 32,
  });
}

/** Build one bounded NIP-01 REQ for a named coordinate or exact snapshot. */
export function buildPublishedRelayRequest(coordinateInput: NappletLookupCoordinate, pinnedEventId?: string): PublishedRelayRequest {
  const filter = publishedRelayFilter(coordinateInput,pinnedEventId);
  const subscriptionId = generatedSubscriptionId();
  if (!SUBSCRIPTION_ID.test(subscriptionId) || new TextEncoder().encode(subscriptionId).byteLength > MAX_SUBSCRIPTION_ID_BYTES) return fail();
  const wire = JSON.stringify(['REQ', subscriptionId, filter]);
  const byteLength = new TextEncoder().encode(wire).byteLength;
  if (byteLength > MAX_PUBLISHED_REQ_BYTES) return fail();
  return Object.freeze({ subscriptionId, wire });
}
