import { getEventHash, verifyEvent } from 'nostr-tools/pure';
import type { EventSnapshot } from './event-snapshot.ts';

export type VerifiedSignedEvent = Readonly<{
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: readonly (readonly string[])[];
  content: string;
  sig: string;
}>;

export class SignedEventError extends Error {
  readonly code = 'INVALID_SIGNED_EVENT';
  constructor() { super('Invalid signed event'); this.name = 'SignedEventError'; }
}

const fail = (): never => { throw new SignedEventError(); };
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

function cloneRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== fields.length || fields.some(key => !own(descriptors, key) || !own(descriptors[key]!, 'value'))) return fail();
  return value as Record<string, unknown>;
}

function cloneTags(value: unknown): unknown[][] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) return fail();
  const result: unknown[][] = [];
  for (let i = 0; i < value.length; i++) {
    const tagDescriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!tagDescriptor || !own(tagDescriptor, 'value')) return fail();
    const tag = tagDescriptor.value;
    if (!Array.isArray(tag) || Object.getPrototypeOf(tag) !== Array.prototype || Reflect.ownKeys(tag).length !== tag.length + 1) return fail();
    const cloned: unknown[] = [];
    for (let j = 0; j < tag.length; j++) {
      const itemDescriptor = Object.getOwnPropertyDescriptor(tag, String(j));
      if (!itemDescriptor || !own(itemDescriptor, 'value') || typeof itemDescriptor.value !== 'string') return fail();
      cloned.push(itemDescriptor.value);
    }
    result.push(cloned);
  }
  return result;
}

function cloneInput(value: unknown): Record<string, unknown> {
  const input = cloneRecord(value, ['id', 'pubkey', 'created_at', 'kind', 'tags', 'content', 'sig']);
  return {
    id: input.id, pubkey: input.pubkey, created_at: input.created_at, kind: input.kind,
    tags: cloneTags(input.tags), content: input.content, sig: input.sig,
  };
}

function strings(tags: unknown): string[][] {
  if (!Array.isArray(tags)) return fail();
  return tags.map(tag => {
    if (tag.length === 0) return fail();
    return [...tag] as string[];
  });
}

function equalTags(left: readonly (readonly string[])[], right: readonly (readonly string[])[]): boolean {
  return left.length === right.length && left.every((tag, i) => tag.length === right[i]!.length && tag.every((value, j) => value === right[i]![j]));
}

/** Re-validates a signer result against the immutable approval snapshot. */
export function validateSignedEvent(snapshot: EventSnapshot, result: unknown): VerifiedSignedEvent {
  try {
    const event = cloneInput(result);
    if (typeof event.id !== 'string' || !HEX64.test(event.id) || typeof event.pubkey !== 'string' || !HEX64.test(event.pubkey) ||
        typeof event.sig !== 'string' || !HEX128.test(event.sig) || typeof event.content !== 'string' ||
        typeof event.kind !== 'number' || !Number.isSafeInteger(event.kind) || typeof event.created_at !== 'number' ||
        !Number.isSafeInteger(event.created_at) || event.kind !== snapshot.event.kind || event.created_at !== snapshot.event.created_at ||
        event.pubkey !== snapshot.selectedPubkey || event.content !== snapshot.event.content) return fail();
    const tags = strings(event.tags);
    if (!equalTags(tags, snapshot.event.tags)) return fail();
    const mutable = { id: event.id, pubkey: event.pubkey, created_at: event.created_at, kind: event.kind,
      tags: tags.map(tag => [...tag]), content: event.content, sig: event.sig };
    if (mutable.id !== snapshot.hash || getEventHash(mutable) !== snapshot.hash || !verifyEvent(mutable)) return fail();
    return Object.freeze({ id: mutable.id, pubkey: mutable.pubkey, created_at: mutable.created_at,
      kind: mutable.kind, tags: Object.freeze(mutable.tags.map(tag => Object.freeze(tag))),
      content: mutable.content, sig: mutable.sig });
  } catch (error) {
    if (error instanceof SignedEventError) throw error;
    throw new SignedEventError();
  }
}
