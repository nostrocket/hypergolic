import { getEventHash, verifyEvent } from 'nostr-tools/pure';
import type { NappletCoordinate } from './resolve-link.ts';

export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_HTML_BYTES = 2 * 1024 * 1024;

export class NappletVerificationError extends Error {
  readonly code = 'INVALID_NAPPLET_ARTIFACT';
  constructor() { super('Napplet verification failed'); this.name = 'NappletVerificationError'; }
}

export type VerifiedNappletManifest = Readonly<{
  id: string;
  eventId: string;
  /** Content identity from the NIP-5A path aggregate, stable across equivalent event publications. */
  versionId: string;
  pubkey: string;
  created_at: number;
  kind: 35129;
  tags: readonly (readonly string[])[];
  content: string;
  sig: string;
  expectedHtmlHash: string;
  aggregateHash: string;
  serverHints: readonly string[];
  requiredDomains: readonly string[];
}>;

export type VerifiedNappletArtifact = Readonly<{
  manifest: VerifiedNappletManifest;
  htmlBytes: Uint8Array;
  htmlHash: string;
  aggregateHash: string;
}>;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const verifiedManifests = new WeakSet<object>();
const verifiedArtifacts = new WeakSet<object>();
const fail = (): never => { throw new NappletVerificationError(); };

/** Reject structural lookalikes before a trusted native staging caller reads bytes. */
export function assertVerifiedArtifact(value: unknown): asserts value is VerifiedNappletArtifact {
  if (typeof value !== 'object' || value === null || !verifiedArtifacts.has(value)) fail();
}
const hasOwn = (value: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, key);

function plainRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const stringKeys = Reflect.ownKeys(descriptors).filter((key): key is string => typeof key === 'string');
  if (stringKeys.length !== fields.length || fields.some(key => !hasOwn(descriptors, key) || !hasOwn(descriptors[key]!, 'value'))) return fail();
  return Object.fromEntries(fields.map(key => [key, descriptors[key]!.value]));
}

function plainStringArray(value: unknown, maxLength = MAX_MANIFEST_BYTES): string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maxLength ||
      Reflect.ownKeys(value).length !== value.length + 1) return fail();
  const result: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') return fail();
    result.push(descriptor.value);
  }
  return result;
}

function cloneTags(value: unknown): string[][] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_MANIFEST_BYTES ||
      Reflect.ownKeys(value).length !== value.length + 1) return fail();
  const tags: string[][] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !hasOwn(descriptor, 'value')) return fail();
    tags.push(plainStringArray(descriptor.value));
  }
  return tags;
}

function validPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  const labels = host.split('.');
  return host.includes('.') && !host.includes(':') && !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) &&
    !['localhost', 'local', 'internal', 'test', 'invalid', 'example'].some(suffix => host === suffix || host.endsWith(`.${suffix}`)) &&
    labels.every(label => /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
}

function validServerBase(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' &&
      validPublicHostname(url.hostname);
  } catch { return false; }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  const stableBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(stableBuffer).set(bytes);
  let digest: ArrayBuffer;
  if (subtle) {
    digest = await subtle.digest('SHA-256', stableBuffer);
  } else {
    const { digest: expoDigest, CryptoDigestAlgorithm } = await import('expo-crypto');
    digest = await expoDigest(CryptoDigestAlgorithm.SHA256, new Uint8Array(stableBuffer));
  }
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function freezeTags(tags: readonly (readonly string[])[]): readonly (readonly string[])[] {
  return Object.freeze(tags.map(tag => Object.freeze([...tag])));
}

/** Verifies and clones a kind-35129 manifest before any artifact fetch or execution. */
export async function verifyManifest(coordinate: NappletCoordinate, signedEvent: unknown): Promise<VerifiedNappletManifest> {
  try {
    const input = plainRecord(signedEvent, ['id', 'pubkey', 'created_at', 'kind', 'tags', 'content', 'sig']);
    const tags = cloneTags(input.tags);
    if (typeof input.id !== 'string' || !HEX64.test(input.id) || typeof input.pubkey !== 'string' || !HEX64.test(input.pubkey) ||
        typeof input.sig !== 'string' || !HEX128.test(input.sig) || typeof input.content !== 'string' ||
        typeof input.created_at !== 'number' || !Number.isSafeInteger(input.created_at) || input.created_at < 0 ||
        input.kind !== 35129 || coordinate.kind !== 35129 || input.pubkey !== coordinate.pubkey ||
        typeof coordinate.identifier !== 'string' ||
        new TextEncoder().encode(JSON.stringify({ ...input, tags })).byteLength > MAX_MANIFEST_BYTES) return fail();

    const dTags: string[][] = [];
    const pathTags: string[][] = [];
    const xTags: string[][] = [];
    const serverHints: string[] = [];
    const requiredDomains: string[] = [];
    for (const tag of tags) {
      if (tag[0] === 'd') dTags.push(tag);
      else if (tag[0] === 'path') pathTags.push(tag);
      else if (tag[0] === 'x') xTags.push(tag);
      else if (tag[0] === 'server') {
        if (tag.length !== 2 || !validServerBase(tag[1]!)) return fail();
        serverHints.push(new URL(tag[1]!).origin + '/');
      } else if (tag[0] === 'requires') {
        if (tag.length !== 2 || !/^[a-z][a-z0-9-]{0,63}$/.test(tag[1]!)) return fail();
        requiredDomains.push(tag[1]!);
      }
    }
    if (dTags.length !== 1 || dTags[0]!.length !== 2 || dTags[0]![1] !== coordinate.identifier ||
        pathTags.length !== 1 || pathTags[0]!.length !== 3 || pathTags[0]![1] !== '/index.html' || !HEX64.test(pathTags[0]![2]!) ||
        xTags.length > 1 || xTags.some(tag => tag.length !== 3 || tag[2] !== 'aggregate' || !HEX64.test(tag[1]!))) return fail();
    const expectedHtmlHash = pathTags[0]![2]!;
    const aggregateHash = await sha256(new TextEncoder().encode(`${expectedHtmlHash} /index.html\n`));
    if (xTags.length === 1 && xTags[0]![1] !== aggregateHash) return fail();
    if (new Set(serverHints).size !== serverHints.length || new Set(requiredDomains).size !== requiredDomains.length) return fail();

    // Verify a newly constructed plain object, so no nostr-tools verification cache can confer trust.
    const event = {
      id: input.id, pubkey: input.pubkey, created_at: input.created_at, kind: input.kind,
      tags: tags.map(tag => [...tag]), content: input.content, sig: input.sig,
    };
    if (getEventHash(event) !== event.id || !verifyEvent(event)) return fail();

    const frozenTags = freezeTags(event.tags);
    const manifest = Object.freeze({
      id: event.id, eventId: event.id, versionId: aggregateHash, pubkey: event.pubkey, created_at: event.created_at,
      kind: 35129, tags: frozenTags, content: event.content, sig: event.sig,
      expectedHtmlHash, aggregateHash,
      serverHints: Object.freeze([...serverHints]), requiredDomains: Object.freeze([...requiredDomains]),
    });
    verifiedManifests.add(manifest);
    return manifest;
  } catch (error) {
    if (error instanceof NappletVerificationError) throw error;
    throw new NappletVerificationError();
  }
}

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title']);

/** Accepts a conservative, explicitly balanced HTML document envelope. */
function validateHtmlEnvelope(html: string): void {
  if (!/^\uFEFF?\s*<!doctype\s+html\s*>/i.test(html)) return fail();
  // The trusted host inserts CSP as the first head child before mounting any
  // publisher markup. Reject documents that could execute before that point.
  if (!/^\uFEFF?\s*<!doctype\s+html\s*>\s*<html(?:\s+[a-z][a-z0-9:-]*\s*=\s*(?:"[^"<>]*"|'[^'<>]*'))*\s*>\s*<head(?:\s+[a-z][a-z0-9:-]*\s*=\s*(?:"[^"<>]*"|'[^'<>]*'))*\s*>/i.test(html)) return fail();
  const doctype = /^\uFEFF?\s*<!doctype\s+html\s*>/i.exec(html)!;
  const stack: string[] = [];
  let cursor = doctype[0].length;
  let htmlCount = 0; let headCount = 0; let bodyCount = 0; let bodySeen = false;
  while (cursor < html.length) {
    const open = html.indexOf('<', cursor);
    if (open < 0) {
      if (stack.length || html.slice(cursor).trim()) return fail();
      break;
    }
    if (stack.length === 0 && html.slice(cursor, open).trim()) return fail();
    if (html.startsWith('<!--', open)) {
      const end = html.indexOf('-->', open + 4);
      if (end < 0) return fail();
      cursor = end + 3; continue;
    }
    const closing = /^<\/([a-z][a-z0-9:-]*)\s*>/i.exec(html.slice(open));
    if (closing) {
      const name = closing[1]!.toLowerCase();
      if (stack.pop() !== name) return fail();
      cursor = open + closing[0].length; continue;
    }
    if (/^<!|^<\?/.test(html.slice(open))) return fail();
    const nameMatch = /^<([a-z][a-z0-9:-]*)(?=[\s/>])/i.exec(html.slice(open));
    if (!nameMatch) return fail();
    const name = nameMatch[1]!.toLowerCase();
    let quote = '';
    let end = open + nameMatch[0].length;
    for (; end < html.length; end++) {
      const char = html[end]!;
      if (quote) { if (char === quote) quote = ''; continue; }
      if (char === '"' || char === "'") { quote = char; continue; }
      if (char === '<') return fail();
      if (char === '>') break;
    }
    if (end >= html.length || quote) return fail();
    const tagText = html.slice(open, end + 1);
    if (/\s\/\s*>$/.test(tagText) && !VOID_ELEMENTS.has(name)) return fail();
    if (name === 'html') { htmlCount++; if (htmlCount !== 1 || stack.length !== 0) return fail(); }
    if (name === 'head') { headCount++; if (headCount !== 1 || stack.at(-1) !== 'html' || bodySeen) return fail(); }
    if (name === 'body') { bodyCount++; bodySeen = true; if (bodyCount !== 1 || stack.at(-1) !== 'html' || headCount !== 1) return fail(); }
    if (!VOID_ELEMENTS.has(name)) stack.push(name);
    cursor = end + 1;
    if (RAW_TEXT_ELEMENTS.has(name) && !VOID_ELEMENTS.has(name)) {
      const endTag = new RegExp(`</${name}\\s*>`, 'ig'); endTag.lastIndex = cursor;
      const match = endTag.exec(html); if (!match) return fail();
      cursor = match.index;
    }
  }
  if (htmlCount !== 1 || headCount !== 1 || bodyCount !== 1 || stack.length !== 0) return fail();
}

/** Verifies immutable original UTF-8 bytes; it does not prepare or execute HTML. */
export async function verifyArtifact(manifest: VerifiedNappletManifest, htmlBytes: Uint8Array): Promise<VerifiedNappletArtifact> {
  try {
    if (typeof manifest !== 'object' || manifest === null || !verifiedManifests.has(manifest) ||
        !(htmlBytes instanceof Uint8Array) || htmlBytes.byteLength === 0 || htmlBytes.byteLength > MAX_HTML_BYTES) return fail();
    const copy = new Uint8Array(htmlBytes);
    const html = new TextDecoder('utf-8', { fatal: true }).decode(copy);
    validateHtmlEnvelope(html);
    const htmlHash = await sha256(copy);
    if (htmlHash !== manifest.expectedHtmlHash) return fail();
    const aggregateInput = new TextEncoder().encode(`${htmlHash} /index.html\n`);
    const aggregateHash = await sha256(aggregateInput);
    if (aggregateHash !== manifest.aggregateHash) return fail();
    const verifiedBytes = new Uint8Array(copy);
    const artifact = Object.freeze({
      manifest,
      get htmlBytes(): Uint8Array { return new Uint8Array(verifiedBytes); },
      htmlHash,
      aggregateHash,
    });
    verifiedArtifacts.add(artifact);
    return artifact;
  } catch (error) {
    if (error instanceof NappletVerificationError) throw error;
    throw new NappletVerificationError();
  }
}
