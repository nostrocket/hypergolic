import { getEventHash, verifyEvent } from 'nostr-tools/pure';
import { isNappletIdentifier, type NappletCoordinate } from './resolve-link.ts';

export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_HTML_BYTES = 2 * 1024 * 1024;

export class NappletVerificationError extends Error {
  readonly code = 'INVALID_NAPPLET_ARTIFACT';
  constructor() { super('Napplet verification failed'); this.name = 'NappletVerificationError'; }
}

/** Only returned for an authentic event at the requested coordinate. */
export class UnsupportedNappletManifestError extends NappletVerificationError {
  constructor() { super(); this.name = 'UnsupportedNappletManifestError'; }
}

export type VerifiedNappletManifest = Readonly<{
  id: string;
  eventId: string;
  format: 'legacy-path' | 'nip-5d';
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
  optionalDomains: readonly string[];
}>;

export type VerifiedNappletArtifact = Readonly<{
  manifest: VerifiedNappletManifest;
  htmlBytes: Uint8Array;
  htmlHash: string;
  aggregateHash: string;
}>;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const DOMAIN = /^[a-z][a-z0-9-]{0,63}$/;
const LEGACY_ONLY_TAGS = new Set(['requires', 'description', 'archetype']);
const MODERN_ONLY_TAGS = new Set(['R', 'O', 'z']);
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

function domainDeclarations(tags: readonly string[][], name: string): string[] {
  const selected = tags.filter(tag => tag[0] === name);
  if (selected.some(tag => tag.length !== 2 || !DOMAIN.test(tag[1]!))) return fail();
  const domains = selected.map(tag => tag[1]!);
  if (new Set(domains).size !== domains.length) return fail();
  return domains;
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
        !isNappletIdentifier(coordinate.identifier) ||
        new TextEncoder().encode(JSON.stringify({ ...input, tags })).byteLength > MAX_MANIFEST_BYTES) return fail();

    const dTags = tags.filter(tag => tag[0] === 'd');
    if (dTags.length !== 1 || dTags[0]!.length !== 2 || dTags[0]![1] !== coordinate.identifier) return fail();
    // Verify a newly constructed plain object, so no nostr-tools verification cache can confer trust.
    const event = {
      id: input.id, pubkey: input.pubkey, created_at: input.created_at, kind: input.kind,
      tags, content: input.content, sig: input.sig,
    };
    if (getEventHash(event) !== event.id || !verifyEvent(event)) return fail();

    const paths = tags.filter(tag => tag[0] === 'path');
    const hashes = tags.filter(tag => tag[0] === 'x');
    const format = paths.length ? 'legacy-path' : 'nip-5d';
    const [path] = paths;
    const [hash] = hashes;
    let expectedHtmlHash: string;
    if (format === 'legacy-path') {
      if (paths.length !== 1 || path?.length !== 3 || path[1] !== '/index.html' || !HEX64.test(path[2]!) ||
          hashes.length > 1 || (hash && (hash.length !== 3 || hash[2] !== 'aggregate' || !HEX64.test(hash[1]!))) ||
          tags.some(tag => MODERN_ONLY_TAGS.has(tag[0]!))) throw new UnsupportedNappletManifestError();
      expectedHtmlHash = path[2]!;
    } else {
      if (hashes.length !== 1 || hash?.length !== 2 || !HEX64.test(hash[1]!) || !event.content.trim() ||
          tags.some(tag => LEGACY_ONLY_TAGS.has(tag[0]!) || tag[0] === 'a' || tag[0] === 'A')) {
        throw new UnsupportedNappletManifestError();
      }
      expectedHtmlHash = hash[1]!;
    }

    const requiredDomains = domainDeclarations(tags, format === 'legacy-path' ? 'requires' : 'R');
    const optionalDomains = format === 'legacy-path' ? [] : domainDeclarations(tags, 'O');
    const required = new Set(requiredDomains);
    if (optionalDomains.some(domain => required.has(domain))) return fail();
    const serverHints = new Set<string>();
    for (const tag of tags) {
      if (tag[0] !== 'server') continue;
      if (tag.length !== 2 || !validServerBase(tag[1]!)) return fail();
      const origin = new URL(tag[1]!).origin + '/';
      if (serverHints.has(origin)) return fail();
      serverHints.add(origin);
    }

    // Both formats project the same bytes to the same native runtime version.
    const aggregateHash = await sha256(new TextEncoder().encode(`${expectedHtmlHash} /index.html\n`));
    if (format === 'legacy-path' && hash && hash[1] !== aggregateHash) return fail();

    const frozenTags = freezeTags(event.tags);
    const manifest = Object.freeze({
      id: event.id, eventId: event.id, format, versionId: aggregateHash, pubkey: event.pubkey, created_at: event.created_at,
      kind: 35129, tags: frozenTags, content: event.content, sig: event.sig,
      expectedHtmlHash, aggregateHash,
      serverHints: Object.freeze([...serverHints]), requiredDomains: Object.freeze(requiredDomains),
      optionalDomains: Object.freeze(optionalDomains),
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
const SVG_GRAPHICS = new Set(['circle', 'ellipse', 'line', 'path', 'polygon', 'polyline', 'rect', 'stop', 'use']);
const SVG_HTML_INTEGRATION = new Set(['desc', 'foreignobject', 'title']);
const SVG_HTML_BREAKOUT = new Set([
  'b', 'big', 'blockquote', 'body', 'br', 'center', 'code', 'dd', 'div', 'dl', 'dt', 'em', 'embed',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'hr', 'i', 'img', 'li', 'listing', 'menu', 'meta',
  'nobr', 'ol', 'p', 'pre', 'ruby', 's', 'small', 'span', 'strong', 'strike', 'sub', 'sup', 'table', 'tt', 'u', 'ul', 'var',
]);
type Namespace = 'html' | 'svg' | 'math';

function breaksSvgContext(name: string, tagText: string): boolean {
  if (SVG_HTML_BREAKOUT.has(name)) return true;
  return name === 'font' && /\s(?:color|face|size)[\s=/>]/i.test(tagText.replace(/"[^"]*"|'[^']*'/g, '""'));
}

function explicitSelfClosing(tagText: string): boolean {
  return /[\s"']\/\s*>$/.test(tagText) || /^<[a-z][a-z0-9:-]*\/\s*>$/i.test(tagText);
}

/** Accepts a conservative, explicitly balanced HTML document envelope. */
function validateHtmlEnvelope(html: string): void {
  if (!/^\uFEFF?\s*<!doctype\s+html\s*>/i.test(html)) return fail();
  // The trusted host inserts CSP as the first head child before mounting any
  // publisher markup. Reject documents that could execute before that point.
  if (!/^\uFEFF?\s*<!doctype\s+html\s*>\s*<html(?:\s+[a-z][a-z0-9:-]*\s*=\s*(?:"[^"<>]*"|'[^'<>]*'))*\s*>\s*<head(?:\s+[a-z][a-z0-9:-]*\s*=\s*(?:"[^"<>]*"|'[^'<>]*'))*\s*>/i.test(html)) return fail();
  const doctype = /^\uFEFF?\s*<!doctype\s+html\s*>/i.exec(html)!;
  const stack: {name: string; children: Namespace}[] = [];
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
      if (stack.pop()?.name !== name) return fail();
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
    const parent = stack.at(-1);
    const context = parent?.children ?? 'html';
    const namespace = context === 'html' && (name === 'svg' || name === 'math') ? name : context;
    const inSvg = namespace === 'svg';
    if (inSvg && breaksSvgContext(name, tagText)) return fail();
    const isVoid = !inSvg && VOID_ELEMENTS.has(name);
    const selfClosing = explicitSelfClosing(tagText);
    if (selfClosing && !isVoid && !(inSvg && SVG_GRAPHICS.has(name) && tagText.endsWith('/>'))) return fail();
    if (name === 'html') { htmlCount++; if (htmlCount !== 1 || stack.length !== 0) return fail(); }
    if (name === 'head') { headCount++; if (headCount !== 1 || parent?.name !== 'html' || bodySeen) return fail(); }
    if (name === 'body') { bodyCount++; bodySeen = true; if (bodyCount !== 1 || parent?.name !== 'html' || headCount !== 1) return fail(); }
    if (!isVoid && !selfClosing) stack.push({name, children: inSvg && SVG_HTML_INTEGRATION.has(name) ? 'html' : namespace});
    cursor = end + 1;
    if (RAW_TEXT_ELEMENTS.has(name) && !(inSvg && name === 'title')) {
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
