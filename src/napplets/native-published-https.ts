import { MAX_HTML_BYTES } from './verified-artifact.ts';
import { createNativeBoundedResponse, type BoundedFetchInit, type PublishedHttpsFetch } from './published-source.ts';

/** Trusted React Native module only; never expose this object to the WebView. */
export interface NativePublishedHttpsPort {
  newInstanceId(): string;
  fetchPublishedHttps(operationId: string, url: string): Promise<string>;
  cancelPublishedHttps(operationId: string): void;
  revokeAllPublishedHttps(): void;
}

export class PublishedNativeHttpsError extends Error {
  readonly code = 'PUBLISHED_HTTPS_FAILED';
  constructor() { super('The published napplet could not be retrieved'); this.name = 'PublishedNativeHttpsError'; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_BASE64_BYTES = Math.ceil(MAX_HTML_BYTES / 3) * 4;
function sextet(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return -1;
}

/** Native checked a 2 MiB wire body; recheck canonical Base64 before allocating JS bytes. */
export function decodeNativePublishedBody(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_BASE64_BYTES || value.length % 4 !== 0) throw new PublishedNativeHttpsError();
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const length = value.length / 4 * 3 - padding;
  if (length < 1 || length > MAX_HTML_BYTES) throw new PublishedNativeHttpsError();
  const bytes = new Uint8Array(new ArrayBuffer(length));
  for (let offset = 0, index = 0; offset < value.length; offset += 4) {
    const last = offset + 4 === value.length;
    const a = sextet(value.charCodeAt(offset)), b = sextet(value.charCodeAt(offset + 1));
    const c = last && padding === 2 ? 0 : sextet(value.charCodeAt(offset + 2));
    const d = last && padding > 0 ? 0 : sextet(value.charCodeAt(offset + 3));
    if (a < 0 || b < 0 || c < 0 || d < 0 ||
        (last && padding === 2 && (value.charCodeAt(offset + 2) !== 61 || value.charCodeAt(offset + 3) !== 61 || (b & 15) !== 0)) ||
        (last && padding === 1 && (value.charCodeAt(offset + 3) !== 61 || (c & 3) !== 0))) throw new PublishedNativeHttpsError();
    bytes[index++] = (a << 2) | (b >> 4);
    if (!last || padding < 2) bytes[index++] = ((b & 15) << 4) | (c >> 2);
    if (!last || padding === 0) bytes[index++] = ((c & 3) << 6) | d;
  }
  return bytes;
}

export function createNativePublishedHttpsFetch(port: NativePublishedHttpsPort): PublishedHttpsFetch {
  return async (url: string, init: BoundedFetchInit): Promise<Response> => {
    if (typeof url !== 'string' || init?.method !== 'GET' || init.redirect !== 'manual' ||
        init.credentials !== 'omit' || init.cache !== 'no-store' || !init.signal || init.signal.aborted) throw new PublishedNativeHttpsError();
    const operationId = port.newInstanceId();
    if (!UUID.test(operationId)) throw new PublishedNativeHttpsError();
    const cancel = () => { try { port.cancelPublishedHttps(operationId); } catch { /* Native deadline is the backstop. */ } };
    init.signal.addEventListener('abort', cancel, { once: true });
    try {
      if (init.signal.aborted) throw new PublishedNativeHttpsError();
      const encoded = await port.fetchPublishedHttps(operationId, url);
      if (init.signal.aborted) throw new PublishedNativeHttpsError();
      const bytes = decodeNativePublishedBody(encoded);
      return createNativeBoundedResponse(bytes);
    } catch { throw new PublishedNativeHttpsError(); }
    finally { init.signal.removeEventListener('abort', cancel); }
  };
}
