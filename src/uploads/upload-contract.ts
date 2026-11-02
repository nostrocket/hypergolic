import { utf8Bytes } from '../storage/codec.ts';
import { publicResourceHttps } from '../resources/resource-contract.ts';

export const UPLOAD_SPEC = 'a7cc17463cbf5d9cb87884b31071bc4fc826034c';
export const BLOSSOM_SPEC = 'b5bd2801d1763aa635fc8fea7a76597e0eb18990';
export const UPLOAD_LIMITS = Object.freeze({ fileBytes: 10 * 1024 * 1024, chunkBytes: 256 * 1024,
  sessionConcurrent: 1, processConcurrent: 2, pendingReviews: 8, retainedStatuses: 128,
  requestMs: 60_000, authorizationSeconds: 120, idBytes: 128, filenameBytes: 256,
  captionBytes: 4096, metadataBytes: 16 * 1024, metadataDepth: 8, metadataNodes: 256 });
export const UPLOAD_ERRORS = ['invalid request', 'unsupported rail', 'policy denied', 'no server configured',
  'file too large', 'unsupported media type', 'user cancelled', 'server rejected', 'upload failed',
  'quota exceeded', 'outcome unknown'] as const;
export type UploadErrorCode = typeof UPLOAD_ERRORS[number];
export class UploadError extends Error {
  readonly code: UploadErrorCode;
  constructor(code: UploadErrorCode) { super(code); this.name = 'UploadError'; this.code = code; }
}
export type UploadState = 'pending' | 'uploading' | 'complete' | 'failed' | 'cancelled';
export type UploadJSON = null | boolean | number | string | readonly UploadJSON[] | Readonly<{ [key: string]: UploadJSON }>;
export type UploadPayload = Readonly<{ rail: 'blossom'; data: Blob | ArrayBuffer; mimeType?: string;
  filename?: string; caption?: string; noTransform?: boolean; metadata?: Readonly<Record<string, UploadJSON>> }>;
export type UploadRequest = Readonly<{ type: 'upload.info'; id: string }>
  | Readonly<{ type: 'upload.status'; id: string; uploadId: string }>
  | Readonly<{ type: 'upload.upload'; id: string; request: UploadPayload }>;
export type BlobDescriptor = Readonly<Record<string, UploadJSON> & { url: string; sha256: string; size: number; type: string; uploaded: number }>;
const fail = (code: UploadErrorCode = 'invalid request'): never => { throw new UploadError(code); };

function record(value: unknown, nullPrototype = false): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && !(nullPrototype && Object.getPrototypeOf(value) === null))) return fail();
  for (const key of Reflect.ownKeys(value)) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !field || !Object.hasOwn(field, 'value') || !field.enumerable) return fail();
  }
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !allowed.has(key))) fail();
}
function text(value: unknown, limit: number, empty = false): string {
  if (typeof value !== 'string' || (!empty && value.length === 0) || value.length > limit) return fail();
  try { if (utf8Bytes(value) > limit) return fail(); } catch { return fail(); }
  return value;
}
export function uploadMime(value: unknown): string {
  const result = text(value, 128).toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(result)) return fail('unsupported media type');
  return result;
}
export function uploadHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) return fail();
  return value;
}
export function normalizeUploadServer(value: unknown): string {
  try {
    const url = new URL(publicResourceHttps(text(value, 2048)));
    if (url.pathname !== '/' || url.search !== '') return fail('policy denied');
    return url.origin;
  } catch { return fail('policy denied'); }
}
function metadata(value: unknown): Readonly<Record<string, UploadJSON>> {
  let nodes = 0;
  function copy(value: unknown, depth: number): UploadJSON {
    if (++nodes > UPLOAD_LIMITS.metadataNodes || depth > UPLOAD_LIMITS.metadataDepth) return fail();
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : fail();
    if (typeof value === 'string') return text(value, UPLOAD_LIMITS.metadataBytes, true);
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > UPLOAD_LIMITS.metadataNodes ||
          Reflect.ownKeys(value).length !== value.length + 1) return fail();
      const output: UploadJSON[] = [];
      for (let i = 0; i < value.length; i++) {
        const field = Object.getOwnPropertyDescriptor(value, String(i));
        if (!field || !Object.hasOwn(field, 'value') || !field.enumerable) return fail();
        output.push(copy(field.value, depth + 1));
      }
      return Object.freeze(output);
    }
    const input = record(value, true), output: Record<string, UploadJSON> = Object.create(null);
    for (const key of Object.keys(input)) { text(key, 256, true); output[key] = copy(input[key], depth + 1); }
    return Object.freeze(output);
  }
  record(value, true);
  const result = copy(value, 0) as Readonly<Record<string, UploadJSON>>;
  if (utf8Bytes(JSON.stringify(result)) > UPLOAD_LIMITS.metadataBytes) return fail();
  return result;
}
/** Select the public draft shape only; caller-supplied destination, auth and private handles are rejected. */
export function parseUploadRequest(value: unknown): UploadRequest {
  try {
    const input = record(value), id = text(input.id, UPLOAD_LIMITS.idBytes);
    if (input.type === 'upload.info') { fields(input, ['type', 'id']); return Object.freeze({type: input.type, id}); }
    if (input.type === 'upload.status') {
      fields(input, ['type', 'id', 'uploadId']);
      return Object.freeze({type: input.type, id, uploadId: text(input.uploadId, UPLOAD_LIMITS.idBytes)});
    }
    if (input.type !== 'upload.upload') return fail();
    fields(input, ['type', 'id', 'request']);
    const payload = record(input.request);
    fields(payload, ['data'], ['rail', 'mimeType', 'filename', 'caption', 'noTransform', 'metadata']);
    if (Object.hasOwn(payload, 'rail') && payload.rail !== 'blossom') return fail('unsupported rail');
    const data = payload.data;
    if (!(data instanceof Blob) && !(data instanceof ArrayBuffer)) return fail();
    if (Object.hasOwn(payload, 'noTransform') && typeof payload.noTransform !== 'boolean') return fail();
    const request: UploadPayload = Object.freeze({rail: 'blossom', data,
      ...(Object.hasOwn(payload, 'mimeType') ? {mimeType: uploadMime(payload.mimeType)} : {}),
      ...(Object.hasOwn(payload, 'filename') ? {filename: text(payload.filename, UPLOAD_LIMITS.filenameBytes, true)} : {}),
      ...(Object.hasOwn(payload, 'caption') ? {caption: text(payload.caption, UPLOAD_LIMITS.captionBytes, true)} : {}),
      ...(Object.hasOwn(payload, 'noTransform') ? {noTransform: payload.noTransform as boolean} : {}),
      ...(Object.hasOwn(payload, 'metadata') ? {metadata: metadata(payload.metadata)} : {})});
    return Object.freeze({type: input.type, id, request});
  } catch (error) { if (error instanceof UploadError) throw error; return fail(); }
}
/** Capture before the first await. ArrayBuffer may be mutable or detached; Blob contents are immutable. */
export function captureUploadBytes(value: Blob | ArrayBuffer): Promise<Uint8Array<ArrayBuffer>> {
  try {
    if (value instanceof ArrayBuffer) {
      const length = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!.call(value) as number;
      if (length > UPLOAD_LIMITS.fileBytes) return Promise.reject(new UploadError('file too large'));
      const copy = new Uint8Array(length);
      copy.set(new Uint8Array(value));
      return Promise.resolve(copy);
    }
    if (!(value instanceof Blob)) return Promise.reject(new UploadError('invalid request'));
    const length = Object.getOwnPropertyDescriptor(Blob.prototype, 'size')!.get!.call(value) as number;
    if (length > UPLOAD_LIMITS.fileBytes) return Promise.reject(new UploadError('file too large'));
    return Blob.prototype.arrayBuffer.call(value).then(buffer => {
      if (buffer.byteLength !== length) return fail();
      return new Uint8Array(buffer);
    }, () => fail());
  } catch { return Promise.reject(new UploadError('invalid request')); }
}
/** Only structurally validated WAV bytes qualify for the selected provider MIME alias. */
export function matchesUploadMime(provider: string, reviewed: string, bytes: Uint8Array): boolean {
  if (provider === reviewed) return true;
  if (reviewed !== 'audio/wav' || provider !== 'audio/x-wav' || bytes.length < 12) return false;
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || view.getUint32(4, true) !== bytes.length - 8) return false;
  let cursor = 12, chunks = 0, format = false, data = false;
  while (cursor <= bytes.length - 8) {
    if (++chunks > 4096) return false;
    const length = view.getUint32(cursor + 4, true), name = tag(cursor);
    if (length > bytes.length - cursor - 8) return false;
    if (name === 'fmt ') {if (format || length < 16) return false; format = true;}
    if (name === 'data') {if (data || length < 1) return false; data = true;}
    cursor += 8 + length + (length & 1);
  }
  return cursor === bytes.length && format && data;
}

/** Untrusted provider receipt: advisory fields do not grant a second upload destination. */
export function captureBlobDescriptor(value: unknown, hash: string, size: number): BlobDescriptor {
  try {
    const input = record(value);
    if (['url', 'sha256', 'size', 'type', 'uploaded'].some(key => !Object.hasOwn(input, key)) || Object.keys(input).length > 32) return fail('upload failed');
    if (uploadHash(input.sha256) !== uploadHash(hash) || input.size !== size || !Number.isSafeInteger(size) || size < 0 || size > UPLOAD_LIMITS.fileBytes ||
        !Number.isSafeInteger(input.uploaded) || (input.uploaded as number) < 0) return fail('upload failed');
    const url = publicResourceHttps(text(input.url, 2048));
    const path = new URL(url).pathname;
    if (!new RegExp('^/' + hash + '\\.[A-Za-z0-9]{1,16}$').test(path) || new URL(url).search !== '') return fail('upload failed');
    const captured = metadata(input);
    return Object.freeze({...captured, url, sha256: hash, size, type: uploadMime(input.type), uploaded: input.uploaded as number});
  } catch { return fail('upload failed'); }
}
export function uploadInfo() {
  return Object.freeze({rails: Object.freeze([Object.freeze({rail: 'blossom', enabled: true, returns: Object.freeze(['https', 'blossom'])}),
    Object.freeze({rail: 'nip96', enabled: false})]), maxBytes: UPLOAD_LIMITS.fileBytes});
}

export type UploadResult = Readonly<{ok: boolean; uploadId: string; status: UploadState; rail: 'blossom';
  url?: string; sha256?: string; size?: number; mimeType?: string; error?: UploadErrorCode; bytesSent?: number; bytesTotal?: number}>;
/** Selected wire projection. Native credentials, private handles and provider extras never reach the guest. */
export function captureUploadResult(value: unknown, expectedUploadId: string): UploadResult {
  const input = record(value);
  fields(input, ['ok', 'uploadId', 'status', 'rail'], ['url', 'sha256', 'size', 'mimeType', 'error', 'bytesSent', 'bytesTotal']);
  if (input.uploadId !== text(expectedUploadId, UPLOAD_LIMITS.idBytes) || input.rail !== 'blossom' || typeof input.ok !== 'boolean' ||
    !['pending', 'uploading', 'complete', 'failed', 'cancelled'].includes(input.status as string) ||
    input.ok !== !['failed', 'cancelled'].includes(input.status as string)) return fail('upload failed');
  const result: Record<string, unknown> = {ok: input.ok, uploadId: expectedUploadId, status: input.status, rail: 'blossom'};
  if (Object.hasOwn(input, 'error')) {
    if (!UPLOAD_ERRORS.includes(input.error as never) || input.ok) return fail('upload failed'); result.error = input.error;
  }
  if (Object.hasOwn(input, 'sha256')) result.sha256 = uploadHash(input.sha256);
  if (Object.hasOwn(input, 'mimeType')) result.mimeType = uploadMime(input.mimeType);
  for (const key of ['size', 'bytesSent', 'bytesTotal']) if (Object.hasOwn(input, key)) {
    if (!Number.isSafeInteger(input[key]) || (input[key] as number) < 0 || (input[key] as number) > UPLOAD_LIMITS.fileBytes) return fail('upload failed');
    result[key] = input[key];
  }
  if (Object.hasOwn(input, 'bytesSent') && (!Object.hasOwn(input, 'bytesTotal') || (input.bytesSent as number) > (input.bytesTotal as number))) return fail('upload failed');
  if (Object.hasOwn(input, 'url')) {
    if (input.status !== 'complete' || typeof result.sha256 !== 'string' || typeof result.size !== 'number' || typeof result.mimeType !== 'string') return fail('upload failed');
    const descriptor = captureBlobDescriptor({url: input.url, sha256: result.sha256, size: result.size, type: result.mimeType, uploaded: 0}, result.sha256, result.size);
    result.url = descriptor.url;
  }
  if (input.status === 'complete' && !Object.hasOwn(result, 'url') || !input.ok && !Object.hasOwn(result, 'error')) return fail('upload failed');
  return Object.freeze(result) as UploadResult;
}
