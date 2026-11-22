import { MAX_HTML_BYTES } from './artifact-limits.ts';

/** App-only file owner. Guest content never receives these operations or tokens. */
export interface NativePublishedBodyPort {
  publishedBodyDatabase(token: string, user: string, length: number): Promise<string>;
  createPublishedBodyToken(): string | Promise<string>;
  verifyCachedPublishedBody(token: string, hash: string): Promise<number>;
  releasePublishedBody(token: string): void;
  stagePublishedBody(token: string, claims: string): Promise<string | null>;
}

export type NativePublishedBody = Readonly<{
  token: string; hash: string; byteLength: number;
  retain(): NativePublishedBody; dispose(): void;
}>;

const branded = new WeakSet<object>();
export const isNativePublishedBody = (value: unknown): value is NativePublishedBody =>
  typeof value === 'object' && value !== null && branded.has(value);

export function adoptNativePublishedBody(port: NativePublishedBodyPort, token: string, hash: string, length: number): NativePublishedBody {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(token) ||
      !/^[a-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(length) || length < 1 || length > MAX_HTML_BYTES) {
    throw new Error('Invalid native publication body');
  }
  let references = 0;
  function lease(): NativePublishedBody {
    references++;
    let active = true;
    const body = Object.freeze({
      get token() { if (!active) throw new Error('Publication body released'); return token; },
      hash, byteLength: length,
      retain() { if (!active) throw new Error('Publication body released'); return lease(); },
      dispose() {
        if (!active) return;
        active = false;
        if (--references === 0) port.releasePublishedBody(token);
      },
    });
    branded.add(body);
    return body;
  }
  return lease();
}
