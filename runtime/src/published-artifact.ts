import {captureLegacyReadOnly, type LegacyReadOnlyContext} from '../../src/napplets/legacy-read-only.ts';
import {captureSnapshotIdentity,type SnapshotIdentity} from '../../src/napplets/published-identity';
import {captureNativeMeshContext, type NativeMeshContext} from './mesh-native.ts';
import {captureAppDataContext,type AppDataContext} from '../../src/app-data/app-data-context';
import { publishedHtmlHead } from '../../src/napplets/html-envelope';
import { SUPPORTED_CAPABILITY_DOMAINS } from '../../src/runtime/capability-protocol';
import { MAX_HTML_BYTES } from '../../src/napplets/artifact-limits';
import type { NativeHost } from './native-client';
const CHUNK_BYTES = 256 * 1024;
const HEADER_CHARS = 24 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;

export type PublishedMetadata = Readonly<{
  publisher: string; appId: string; eventId: string; version: string; htmlHash: string;
  manifestFormat?: 'nip-5d'; snapshot?: SnapshotIdentity;
  domains: readonly string[]; appData?: AppDataContext; mesh?: NativeMeshContext; legacyReadOnly?: LegacyReadOnlyContext;
}>;
export type PublishedDocument = Readonly<{ metadata: PublishedMetadata; identityHash: string; html: string }>;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid artifact reply');
  return value as Record<string, unknown>;
}
const ARTIFACT_DOMAINS = new Set<string>(SUPPORTED_CAPABILITY_DOMAINS);
function metadata(value: Record<string, unknown>, generation: string): PublishedMetadata {
  const { publisher, appId, eventId, version, htmlHash, domains } = value;
  const mesh = value.mesh === undefined ? undefined : captureNativeMeshContext(value.mesh, generation);
  if (typeof publisher !== 'string' || !HEX64.test(publisher) ||
      typeof eventId !== 'string' || !HEX64.test(eventId) ||
      typeof version !== 'string' || !HEX64.test(version) ||
      typeof htmlHash !== 'string' || !HEX64.test(htmlHash) ||
      typeof appId !== 'string' || !appId || new TextEncoder().encode(appId).length > 255 || /[\u0000-\u001f\u007f]/.test(appId) ||
      !Array.isArray(domains) || domains.length > ARTIFACT_DOMAINS.size + (mesh ? 1 : 0) ||
      domains.some(domain => typeof domain !== 'string' || !(ARTIFACT_DOMAINS.has(domain) || domain === 'mesh' && mesh !== undefined)) ||
      domains.some((domain, index) => index > 0 && domains[index - 1] >= domain)) throw new Error('Invalid artifact metadata');
  if (value.manifestFormat !== undefined && value.manifestFormat !== 'nip-5d') throw new Error('Invalid artifact format');
  const snapshot = captureSnapshotIdentity(value.snapshot,appId);
  if (snapshot ? snapshot.eventId !== eventId || value.legacyReadOnly !== undefined || value.appData !== undefined
    : appId !== appId.trim()) throw new Error('Invalid artifact source metadata');
  if (mesh && !domains.includes('mesh')) throw new Error('Mesh context without actual grant');
  const legacyReadOnly=value.legacyReadOnly === undefined ? undefined : captureLegacyReadOnly(value.legacyReadOnly, {publisher,appId,eventId,version,htmlHash}, domains as string[]);
  const appData=value.appData===undefined?null:captureAppDataContext(value.appData,{publisher,appId,fixture:'published',domains});
  return Object.freeze({ ...(value.manifestFormat === 'nip-5d' ? {manifestFormat:'nip-5d' as const} : {}), ...(snapshot?{snapshot}:{}),...(legacyReadOnly ? {legacyReadOnly} : {}), ...(mesh ? {mesh} : {}), ...(appData?{appData}:{}),publisher, appId, eventId, version, htmlHash, domains: Object.freeze([...domains]) });
}
async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
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
      if (settled || typeof raw !== 'string' || raw.length > HEADER_CHARS + 1 + CHUNK_BYTES) return;
      try {
        const line = raw.indexOf('\n');
        if (line < 1 || line > HEADER_CHARS) return;
        const value = record(JSON.parse(raw.slice(0, line)));
        if (value.type !== 'artifact.chunk' || value.sessionId !== generation || 'text' in value) return;
        settled = true; cleanup();
        if (value.sequence !== sequence) reject(new Error('Artifact sequence mismatch'));
        else resolve({...value, text: raw.slice(line + 1)});
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
  const encoder = new TextEncoder();
  let total = 0;
  let claims: PublishedMetadata | null = null;
  let bytes: Uint8Array<ArrayBuffer> | undefined;
  try {
    for (let sequence = 0; sequence < Math.ceil(MAX_HTML_BYTES / (CHUNK_BYTES - 3)); sequence++) {
      const remainingTime = 15_000 - (performance.now() - started);
      if (remainingTime <= 0) throw new Error('Artifact read timed out');
      const value = await receiveChunk(native, generation, sequence, Math.min(2500, remainingTime));
      if (Object.keys(value).length !== (13 + (value.manifestFormat === undefined ? 0 : 1) + (value.snapshot === undefined ? 0 : 1) + (value.appData === undefined ? 0 : 1) + (value.mesh === undefined ? 0 : 1) + (value.legacyReadOnly === undefined ? 0 : 1)) || typeof value.totalBytes !== 'number' || !Number.isSafeInteger(value.totalBytes) ||
          value.totalBytes < 1 || value.totalBytes > MAX_HTML_BYTES ||
          typeof value.byteLength !== 'number' || typeof value.done !== 'boolean') throw new Error('Invalid artifact reply');
      const nextClaims = metadata(value, generation);
      if (claims && JSON.stringify(claims) !== JSON.stringify(nextClaims)) throw new Error('Artifact claims changed');
      claims = nextClaims;
      if (bytes && value.totalBytes !== bytes.length) throw new Error('Artifact length changed');
      bytes ??= new Uint8Array(value.totalBytes);
      const length = value.byteLength;
      const remaining = bytes.length - total;
      if (typeof value.text !== 'string' || !Number.isSafeInteger(length) || length < 1 ||
          length > Math.min(CHUNK_BYTES, remaining) || (!value.done && length < CHUNK_BYTES - 3)) {
        throw new Error('Artifact length mismatch');
      }
      const part = encoder.encodeInto(value.text, bytes.subarray(total, total + length));
      if (part.read !== value.text.length || part.written !== length) throw new Error('Artifact length mismatch');
      total += length;
      if (value.done !== (total === bytes.length)) throw new Error('Artifact completion mismatch');
      if (value.done) {
        const htmlHash = await sha256(bytes);
        const version = await sha256(new TextEncoder().encode(`${htmlHash} /index.html\n`));
        if (htmlHash !== claims.htmlHash || version !== claims.version) throw new Error('Artifact hash mismatch');
        const html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        return Object.freeze({ metadata: claims, identityHash:claims.manifestFormat === 'nip-5d' ? htmlHash : version, html });
      }
    }
    throw new Error('Artifact exceeded chunk limit');
  } finally { bytes?.fill(0); }
}

/** Keep untrusted prefix comments outside all CSP and bootstrap replacements. */
export function publishedCspParts(html: string, csp: string): readonly [string, string] {
  const {headEnd} = publishedHtmlHead(html);
  return [html.slice(0, headEnd), `<meta http-equiv="Content-Security-Policy" content="${csp}">` + html.slice(headEnd)];
}
