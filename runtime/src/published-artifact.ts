import type { NativeHost } from './native-client';

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const CHUNK_BYTES = 48 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export type PublishedMetadata = Readonly<{
  publisher: string; appId: string; eventId: string; version: string; htmlHash: string;
  domains: readonly string[];
}>;
export type PublishedDocument = Readonly<{ metadata: PublishedMetadata; html: string }>;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid artifact reply');
  return value as Record<string, unknown>;
}
function decodeBase64(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length < 4 || value.length > CHUNK_BYTES / 3 * 4 ||
      value.length % 4 !== 0 || !BASE64.test(value)) throw new Error('Invalid artifact chunk');
  const binary = atob(value);
  if (binary.length < 1 || binary.length > CHUNK_BYTES || btoa(binary) !== value) throw new Error('Invalid artifact chunk');
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}
const ARTIFACT_DOMAINS = new Set(['identity', 'storage', 'theme', 'relay', 'resource', 'upload', 'link', 'intent', 'inc', 'notify', 'config', 'outbox']);
function metadata(value: Record<string, unknown>): PublishedMetadata {
  const { publisher, appId, eventId, version, htmlHash, domains } = value;
  if (typeof publisher !== 'string' || !HEX64.test(publisher) ||
      typeof eventId !== 'string' || !HEX64.test(eventId) ||
      typeof version !== 'string' || !HEX64.test(version) ||
      typeof htmlHash !== 'string' || !HEX64.test(htmlHash) ||
      typeof appId !== 'string' || !appId || appId !== appId.trim() ||
      new TextEncoder().encode(appId).length > 255 || /[\u0000-\u001f\u007f]/.test(appId) ||
      !Array.isArray(domains) || domains.length > ARTIFACT_DOMAINS.size ||
      domains.some(domain => typeof domain !== 'string' || !ARTIFACT_DOMAINS.has(domain)) ||
      domains.some((domain, index) => index > 0 && domains[index - 1] >= domain)) throw new Error('Invalid artifact metadata');
  return Object.freeze({ publisher, appId, eventId, version, htmlHash, domains: Object.freeze([...domains]) });
}
async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes);
  const hash = await crypto.subtle.digest('SHA-256', copy);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

function receiveChunk(native: NativeHost, generation: string, sequence: number, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      window.clearTimeout(timer);
      native.removeEventListener?.('message', android);
      window.removeEventListener('message', ios);
    };
    const receive = (raw: unknown) => {
      if (settled || typeof raw !== 'string' || raw.length > 70_000) return;
      try {
        const value = record(JSON.parse(raw));
        if (value.type !== 'artifact.chunk' || value.sessionId !== generation) return;
        settled = true; cleanup();
        if (value.sequence !== sequence) reject(new Error('Artifact sequence mismatch'));
        else resolve(value);
      } catch { /* Other native messages cannot satisfy this read. */ }
    };
    const android = (event: { data: unknown }) => receive(event.data);
    const ios = (event: MessageEvent) => {
      if (event.isTrusted && event.source === window && event.data?.type === 'hypergolic.native-response' &&
          Object.keys(event.data).length === 2) receive(event.data.message);
    };
    const timer = window.setTimeout(() => { settled = true; cleanup(); reject(new Error('Artifact read timed out')); }, timeoutMs);
    native.addEventListener?.('message', android);
    window.addEventListener('message', ios);
    try { native.postMessage(JSON.stringify({ type: 'artifact.read', sessionId: generation, sequence })); }
    catch { settled = true; cleanup(); reject(new Error('Artifact read unavailable')); }
  });
}

/** Reads one native-generation-bound artifact; never accepts a guest or network URL. */
export async function readPublishedArtifact(native: NativeHost, generation: string): Promise<PublishedDocument> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(generation)) throw new Error('Invalid generation');
  const started = performance.now();
  let total = 0;
  let claims: PublishedMetadata | null = null;
  const chunks: Uint8Array[] = [];
  try {
    for (let sequence = 0; sequence < Math.ceil(MAX_HTML_BYTES / CHUNK_BYTES); sequence++) {
      const remainingTime = 15_000 - (performance.now() - started);
      if (remainingTime <= 0) throw new Error('Artifact read timed out');
      const value = await receiveChunk(native, generation, sequence, Math.min(2500, remainingTime));
      if (Object.keys(value).length !== 13 || typeof value.totalBytes !== 'number' || !Number.isSafeInteger(value.totalBytes) ||
          value.totalBytes < 1 || value.totalBytes > MAX_HTML_BYTES ||
          typeof value.byteLength !== 'number' || typeof value.done !== 'boolean') throw new Error('Invalid artifact reply');
      const nextClaims = metadata(value);
      if (claims && JSON.stringify(claims) !== JSON.stringify(nextClaims)) throw new Error('Artifact claims changed');
      claims = nextClaims;
      const chunk = decodeBase64(value.base64);
      if (value.byteLength !== chunk.length || total + chunk.length > value.totalBytes) throw new Error('Artifact length mismatch');
      total += chunk.length;
      chunks.push(chunk);
      if (value.done !== (total === value.totalBytes)) throw new Error('Artifact completion mismatch');
      if (value.done) {
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const part of chunks) { bytes.set(part, offset); offset += part.length; part.fill(0); }
        try {
          const htmlHash = await sha256(bytes);
          const version = await sha256(new TextEncoder().encode(`${htmlHash} /index.html\n`));
          if (htmlHash !== claims.htmlHash || version !== claims.version) throw new Error('Artifact hash mismatch');
          const html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          return Object.freeze({ metadata: claims, html });
        } finally { bytes.fill(0); }
      }
    }
    throw new Error('Artifact exceeded chunk limit');
  } finally { for (const part of chunks) part.fill(0); }
}

/** CSP must be the first element in the head, before any publisher markup runs. */
export function injectPublishedCsp(html: string, csp: string): string {
  const start = /^\uFEFF?\s*<!doctype\s+html\s*>\s*<html(?:\s+[a-z][a-z0-9:-]*\s*=\s*(?:"[^"<>]*"|'[^'<>]*'))*\s*>\s*<head(?:\s+[a-z][a-z0-9:-]*\s*=\s*(?:"[^"<>]*"|'[^'<>]*'))*\s*>/i.exec(html);
  if (!start) throw new Error('Unsafe published document head');
  const headEnd = start[0].length;
  return html.slice(0, headEnd) + `<meta http-equiv="Content-Security-Policy" content="${csp}">` + html.slice(headEnd);
}
