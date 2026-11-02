import { getEventHash } from 'nostr-tools/pure';
import { CAPABILITY_LIMITS } from '../runtime/capability-protocol.ts';
import { publicKey, utf8Bytes } from '../storage/codec.ts';

/** NIP-01 unsigned event fields accepted by the trusted approval boundary. */
export type UnsignedEventTemplate = Readonly<{
  kind: number;
  content: string;
  tags: readonly (readonly string[])[];
  created_at: number;
}>;
export type EventSnapshot = Readonly<{
  event: UnsignedEventTemplate;
  selectedPubkey: string;
  destinations: readonly string[];
  hash: string;
}>;

export class EventSnapshotError extends Error {
  constructor() { super('Invalid event snapshot'); this.name = 'EventSnapshotError'; }
}

const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const fail = (): never => { throw new EventSnapshotError(); };

function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== fields.length || fields.some(key => !own(descriptors, key) || !own(descriptors[key]!, 'value'))) return fail();
  return value as Record<string, unknown>;
}

function denseArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) return fail();
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !own(descriptor, 'value')) return fail();
  }
  return value;
}

function string(value: unknown): string {
  if (typeof value !== 'string' || value.length > CAPABILITY_LIMITS.messageBytes) return fail();
  try { utf8Bytes(value); } catch { return fail(); }
  return value;
}

function event(value: unknown, selectedPubkey: string): UnsignedEventTemplate {
  const input = record(value, ['kind', 'content', 'tags', 'created_at']);
  if (typeof input.kind !== 'number' || !Number.isSafeInteger(input.kind) || input.kind < 0 || input.kind > 65535) return fail();
  if (typeof input.created_at !== 'number' || !Number.isSafeInteger(input.created_at) || input.created_at < 0) return fail();
  const content = string(input.content);
  let capturedBytes = utf8Bytes(JSON.stringify(content));
  const rawTags = denseArray(input.tags);
  if (rawTags.length > CAPABILITY_LIMITS.messageBytes) return fail();
  const tags = rawTags.map(tag => {
    const values = denseArray(tag);
    if (values.length === 0 || values.length > CAPABILITY_LIMITS.messageBytes) return fail();
    capturedBytes += 3;
    return Object.freeze(values.map(value => {
      const text = string(value);
      capturedBytes += utf8Bytes(JSON.stringify(text)) + 1;
      if (capturedBytes > CAPABILITY_LIMITS.messageBytes) return fail();
      return text;
    }));
  });
  const result = Object.freeze({ kind: input.kind, content, tags: Object.freeze(tags), created_at: input.created_at });
  const serialized = JSON.stringify([0, selectedPubkey, result.created_at, result.kind, result.tags, result.content]);
  if (typeof serialized !== 'string' || utf8Bytes(serialized) > CAPABILITY_LIMITS.messageBytes) return fail();
  return result;
}

function destination(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return fail();
  try {
    utf8Bytes(value);
    const url = new URL(value);
    if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash || !url.hostname) return fail();
    const host = url.hostname.toLowerCase();
    // This metadata profile accepts public DNS names only. Final DNS/network
    // policy remains a native authority concern; this is not DNS safety proof.
    if (host.includes('[') || host.includes(']') || host.length > 253 || !host.includes('.') ||
        /\.(?:localhost|local|internal|test|invalid|example|home|lan)$/.test(host) ||
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host) ||
        !/[a-z]/.test(host)) return fail();
    return url.href;
  } catch { return fail(); }
}

/** Capture only the unsigned template before asynchronous routing; no destination or signing authority is granted. */
export function captureUnsignedEventTemplate(value: unknown, selectedPubkeyValue: unknown): UnsignedEventTemplate {
  try { return event(value, publicKey(selectedPubkeyValue)); }
  catch (error) {
    if (error instanceof EventSnapshotError) throw error;
    throw new EventSnapshotError();
  }
}

/** NIP-01 reviewed at nostr-protocol/nips@01e707bacdc87cf262db80545aecaa8f17ac2a4f. */
export function captureEventSnapshot(value: unknown, selectedPubkeyValue: unknown, writeDestinations: unknown): EventSnapshot {
  try {
    const selectedPubkey = publicKey(selectedPubkeyValue);
    const eventValue = event(value, selectedPubkey);
    const list = denseArray(writeDestinations);
    if (list.length === 0 || list.length > 16) return fail();
    const destinations = list.map(destination);
    if (new Set(destinations).size !== destinations.length) return fail();
    const hash = getEventHash({ kind: eventValue.kind, content: eventValue.content,
      tags: eventValue.tags.map(tag => [...tag]), created_at: eventValue.created_at, pubkey: selectedPubkey });
    return Object.freeze({ event: eventValue, selectedPubkey, destinations: Object.freeze(destinations), hash });
  } catch (error) {
    if (error instanceof EventSnapshotError) throw error;
    throw new EventSnapshotError();
  }
}
