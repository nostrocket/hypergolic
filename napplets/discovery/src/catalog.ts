import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { getEventHash, verifyEvent, type Event } from 'nostr-tools/pure';
import { naddrEncode, npubEncode } from 'nostr-tools/nip19';
import type { NostrFilter } from '@napplet/sdk';

const HEX64 = /^[0-9a-f]{64}$/;
const DOMAIN = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_EVENT_BYTES = 64 * 1024;
const encoder = new TextEncoder();
export const KIND = 35129;
export const MAX_FUTURE_SKEW = 120;

export type ManifestFormat = 'legacy' | 'nip-5d';
export type Category = 'Games' | 'Tools' | 'Creative';
const topicsByCategory: Record<Category, ReadonlySet<string>> = {
  Games: new Set(['game', 'games', 'gaming']),
  Tools: new Set(['tool', 'tools', 'utility', 'utilities', 'productivity']),
  Creative: new Set(['art', 'creative', 'creativity', 'design', 'drawing', 'music', 'photography', 'paint']),
};
const MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type ImageMime = typeof MIMES[number];
export const isImageMime = (mime: string): mime is ImageMime => MIMES.some(item => item === mime);
export type Media = { hash: string; mime?: ImageMime; alt?: string; servers?: string[] };

export type VerifiedEvent = { event: Event; bytes: number };
export type Publication = {
  signed: VerifiedEvent;
  address: string;
  identifier: string;
  publisher: string;
  npub: string;
  format: ManifestFormat;
  artifactHash: string;
  title: string;
  description: string;
  topics: string[];
  categories: Category[];
  required: string[];
  optional: string[];
  icon?: Media;
  screenshots: Media[];
};
export type CatalogEntry = { publication: Publication; conflict: boolean };
export type Profile = { eventId: string; timestamp: number; name: string; about: string };

export function digest(data: Uint8Array): string {
  return bytesToHex(sha256(data));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function verifySignedEvent(raw: unknown, filter: NostrFilter, now: number): VerifiedEvent | undefined {
  const value = record(raw);
  if (!value) return;
  const { id, pubkey, sig, kind, created_at, tags, content } = value;
  if (typeof id !== 'string' || !HEX64.test(id) || typeof pubkey !== 'string' || !HEX64.test(pubkey) ||
    typeof sig !== 'string' || !/^[0-9a-f]{128}$/.test(sig) || typeof kind !== 'number' ||
    typeof created_at !== 'number' || !Number.isSafeInteger(created_at) || created_at < 0 ||
    created_at > now + MAX_FUTURE_SKEW || created_at > (filter.until ?? Infinity) ||
    created_at < (filter.since ?? 0) || (filter.kinds && !filter.kinds.includes(kind)) ||
    (filter.authors && !filter.authors.includes(pubkey)) || typeof content !== 'string' ||
    content.length > MAX_EVENT_BYTES || !Array.isArray(tags) || tags.length > 512) return;
  let chars = content.length;
  const safeTags: string[][] = [];
  for (const tag of tags) {
    if (!Array.isArray(tag) || tag.length > 256) return;
    const safeTag: string[] = [];
    for (const field of tag) {
      if (typeof field !== 'string' || (chars += field.length) > MAX_EVENT_BYTES) return;
      safeTag.push(field);
    }
    safeTags.push(safeTag);
  }
  // Clone the signed fields before verifying so a cached verification flag cannot be inherited.
  const event = { id, pubkey, sig, kind, created_at, tags: safeTags, content };
  const bytes = encoder.encode(JSON.stringify(event)).length;
  if (bytes > MAX_EVENT_BYTES || getEventHash(event) !== id || !verifyEvent(event)) return;
  return { event, bytes };
}

function capabilityTags(tags: string[][]): string[] | undefined {
  const names = new Set<string>();
  for (const tag of tags) {
    if (tag.length !== 2 || !DOMAIN.test(tag[1]!) || names.has(tag[1]!)) return;
    names.add(tag[1]!);
  }
  return [...names].sort();
}

function optionalText(tags: string[][], max: number): string {
  return tags.length === 1 && tags[0]!.length === 2 ? displayText(tags[0]![1]!, max) : '';
}

function displayText(value: string, max: number): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, '').trim().slice(0, max);
}

function iconTag(tags: string[][]): Media | undefined {
  const tag = tags.length === 1 ? tags[0] : undefined;
  if (tag?.length === 3 && HEX64.test(tag[1]!) && isImageMime(tag[2]!)) {
    return { hash: tag[1]!, mime: tag[2]!, alt: '' };
  }
}

function screenshotTag(tag: string[]): Media | undefined {
  const fields = new Map<string, string[]>();
  for (const field of tag.slice(1)) {
    const split = field.indexOf(' ');
    if (split < 1) continue;
    const key = field.slice(0, split);
    fields.set(key, [...(fields.get(key) ?? []), field.slice(split + 1)]);
  }
  const singleton = (key: string) => fields.get(key)?.length === 1 ? fields.get(key)?.[0] : undefined;
  const hash = singleton('x');
  if (!hash || !HEX64.test(hash)) return;
  const mime = singleton('m');
  if (mime && /^image\/[a-z0-9.+-]+$/i.test(mime) && !isImageMime(mime)) return;
  return { hash, mime: mime && isImageMime(mime) ? mime : undefined, alt: displayText(singleton('alt') ?? '', 240) };
}

function validServerHints(tags: string[][]): boolean {
  const origins = new Set<string>();
  for (const tag of tags) {
    if (tag.length !== 2) return false;
    try {
      const url = new URL(tag[1]!);
      const host = url.hostname.toLowerCase().replace(/\.$/, '');
      const labels = host.split('.');
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
        labels.length < 2 || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) ||
        ['localhost', 'local', 'internal', 'test', 'invalid', 'example'].some(suffix => host.endsWith(`.${suffix}`)) ||
        !labels.every(label => /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)) ||
        origins.has(url.origin)) return false;
      origins.add(url.origin);
    } catch {
      return false;
    }
  }
  return true;
}

export function validIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= 255 && value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value) && encoder.encode(value).length <= 255 &&
    new TextDecoder().decode(encoder.encode(value)) === value;
}

export function parsePublication(signed: VerifiedEvent): Publication | undefined {
  const { event } = signed;
  if (event.kind !== KIND) return;
  const tags = (name: string) => event.tags.filter(tag => tag[0] === name);
  const identifier = tags('d')[0]?.[1];
  if (!identifier || !validIdentifier(identifier) || tags('d').length !== 1 ||
    tags('d')[0]!.length !== 2 || !validServerHints(tags('server'))) return;
  const path = tags('path');
  const hashes = tags('x');
  let format: ManifestFormat;
  let artifactHash: string;
  let required: string[] | undefined;
  let optional: string[] | undefined;
  let description: string;
  if (path.length) {
    if (path.length !== 1 || path[0]!.length !== 3 || path[0]![1] !== '/index.html' ||
      !HEX64.test(path[0]![2]!) || ['R', 'O', 'z'].some(name => tags(name).length)) return;
    artifactHash = path[0]![2]!;
    const aggregate = hashes[0];
    if (hashes.length > 1 || (aggregate && (aggregate.length !== 3 || aggregate[2] !== 'aggregate' ||
      aggregate[1] !== digest(encoder.encode(`${artifactHash} /index.html\n`))))) return;
    format = 'legacy';
    description = optionalText(tags('description'), 8192);
    required = capabilityTags(tags('requires'));
    optional = [];
  } else {
    if (hashes.length !== 1 || hashes[0]!.length !== 2 || !HEX64.test(hashes[0]![1]!) ||
      !event.content.trim() || ['requires', 'description', 'archetype', 'a', 'A'].some(name => tags(name).length)) return;
    format = 'nip-5d';
    artifactHash = hashes[0]![1]!;
    description = displayText(event.content, 8192);
    required = capabilityTags(tags('R'));
    optional = capabilityTags(tags('O'));
  }
  if (!required || !optional) return;
  const requiredSet = new Set(required);
  if (optional.some(name => requiredSet.has(name))) return;
  const topics = new Set<string>();
  for (const tag of tags('t')) {
    const topic = tag[1] && displayText(tag[1], 100);
    if (topic) topics.add(topic);
  }
  const categories = (Object.keys(topicsByCategory) as Category[]).filter(category =>
    [...topics].some(topic => topicsByCategory[category].has(topic.toLowerCase())));
  const screenshots: Media[] = [];
  if (format === 'nip-5d') {
    for (const tag of tags('screenshot')) {
      const descriptor = screenshotTag(tag);
      if (descriptor) screenshots.push(descriptor);
      if (screenshots.length === 4) break;
    }
  }
  // Only validated origins from this signed publication accompany its artwork.
  const servers = tags('server').map(tag => new URL(tag[1]!).origin);
  const icon = iconTag(tags('icon'));
  return {
    signed, identifier, format, artifactHash, description, required, optional, topics: [...topics], categories,
    title: optionalText(tags('title'), 150) || displayText(identifier, 150) || 'Untitled Napplet',
    publisher: event.pubkey, npub: npubEncode(event.pubkey),
    address: naddrEncode({ kind: KIND, pubkey: event.pubkey, identifier }),
    icon: icon && { ...icon, ...(servers.length && { servers }) },
    screenshots: screenshots.map(media => ({ ...media, ...(servers.length && { servers }) })),
  };
}

export function parseProfile(signed: VerifiedEvent): Profile | undefined {
  const { event } = signed;
  if (event.kind !== 0 || event.content.length > 16384) return;
  try {
    const value = record(JSON.parse(event.content));
    if (!value) return;
    const field = (name: string, max: number) => typeof value[name] === 'string' ? displayText(value[name], max) : '';
    return { eventId: event.id, timestamp: event.created_at, name: field('display_name', 120) || field('name', 120), about: field('about', 1200) };
  } catch {
    return;
  }
}

export function revisionOrder(first: Event, second: Event): number {
  return second.created_at - first.created_at || (first.id < second.id ? -1 : Number(first.id > second.id));
}

export function matchesSearch(app: Publication, query: string, profile?: Profile): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  const identifier = normalized.replace(/^nostr:/, '');
  if ([app.address, app.npub, app.publisher, app.signed.event.id].includes(identifier)) return true;
  const text = [app.title, app.description, app.identifier, ...app.topics, profile?.name ?? ''].join('\n').toLowerCase();
  return normalized.split(/\s+/).every(term => text.includes(term));
}
