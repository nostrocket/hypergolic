import { decodeNativePublishedBody } from '../napplets/native-published-https.ts';
import { ResourceError, RESOURCE_ERRORS, RESOURCE_LIMITS, publicResourceHttps } from './resource-contract.ts';

export interface NativeResourceHttpsPort {
  newInstanceId(): string;
  fetchResourceHttps(token: string, operationId: string, url: string): Promise<string>;
  readResourceHttpsChunk(token: string, operationId: string, offset: number): string | null;
  cancelResourceHttps(operationId: string): void;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Only app-side code can call this port. Chunk authority never enters SDK resource envelopes. */
export function createNativeResourceHttps(port: NativeResourceHttpsPort) {
  return async (url: string, signal: AbortSignal, assertActive: () => void, nativeToken: string): Promise<Uint8Array<ArrayBuffer>> => {
    const target = publicResourceHttps(url);
    const active = () => { if (signal.aborted) throw new ResourceError('timeout'); assertActive(); };
    active();
    if (!uuid.test(nativeToken)) throw new ResourceError('blocked-by-policy');
    const operation = port.newInstanceId();
    if (!uuid.test(operation)) throw new ResourceError('blocked-by-policy');
    const cancel = () => { try { port.cancelResourceHttps(operation); } catch { /* Native lease/deadline independently revoke. */ } };
    signal.addEventListener('abort', cancel, {once:true});
    try {
      active();
      const raw = await port.fetchResourceHttps(nativeToken, operation, target); active();
      if (typeof raw !== 'string' || raw.length > 256) throw new ResourceError('network-error');
      const metadata = JSON.parse(raw);
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || Object.keys(metadata).length !== 2) throw new ResourceError('network-error');
      if (metadata.ok === false && Object.hasOwn(metadata,'error') && RESOURCE_ERRORS.includes(metadata.error)) throw new ResourceError(metadata.error);
      if (metadata.ok !== true || !Object.hasOwn(metadata,'length') || !Number.isSafeInteger(metadata.length) || metadata.length < 0 || metadata.length > RESOURCE_LIMITS.fileBytes) throw new ResourceError('too-large');
      const bytes = new Uint8Array(metadata.length);
      for (let offset = 0; offset < bytes.length;) {
        active();
        const rawChunk = port.readResourceHttpsChunk(nativeToken, operation, offset); active();
        if (typeof rawChunk !== 'string' || rawChunk.length > Math.ceil(RESOURCE_LIMITS.chunkBytes / 3) * 4) throw new ResourceError('decode-failed');
        const chunk = decodeNativePublishedBody(rawChunk);
        if (chunk.byteLength !== Math.min(RESOURCE_LIMITS.chunkBytes, bytes.length-offset)) throw new ResourceError('decode-failed');
        bytes.set(chunk, offset); offset += chunk.length;
      }
      active(); return bytes;
    } catch(error) { if(error instanceof ResourceError)throw error; throw new ResourceError('network-error'); }
    finally { signal.removeEventListener('abort',cancel);cancel(); }
  };
}
