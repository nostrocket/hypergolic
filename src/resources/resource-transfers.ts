import { RESOURCE_LIMITS, ResourceError, type ResourceBytes } from './resource-contract.ts';

type Transfer = { root: string; value: ResourceBytes; offset: number; expiry: number; timer: ReturnType<typeof setTimeout> };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function base64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!, b = bytes[i + 1], c = bytes[i + 2];
    result += alphabet[a >>> 2]! + alphabet[(a & 3) << 4 | (b ?? 0) >>> 4]!
      + (b === undefined ? '=' : alphabet[(b & 15) << 2 | (c ?? 0) >>> 6])
      + (c === undefined ? '=' : alphabet[c & 63]);
  }
  return result;
}
/** Process budget, with a separate unforgeable handle namespace for each native-captured realm.
 * These descriptors are private host transport; the adapter replaces them with actual Blobs. */
export function createResourceTransfers(newId: () => string, now: () => number = () => performance.now()) {
  let processBytes = 0;
  return Object.freeze({ bind(assertActive: () => void) {
    const transfers = new Map<string, Transfer>();
    let disposed = false, sessionBytes = 0;
    const active = () => { if (disposed) throw new ResourceError('blocked-by-policy'); assertActive(); };
    const drop = (handle: string): void => {
      const entry = transfers.get(handle); if (!entry) return;
      transfers.delete(handle); clearTimeout(entry.timer);
      sessionBytes -= entry.value.bytes.length; processBytes -= entry.value.bytes.length;
    };
    const prune = (): void => { for (const [handle, entry] of transfers) if (now() >= entry.expiry) drop(handle); };
    return Object.freeze({
      stage(root: string, value: ResourceBytes) {
        active(); prune();
        if (value.bytes.length > RESOURCE_LIMITS.fileBytes || transfers.size >= 8 ||
          sessionBytes + value.bytes.length > RESOURCE_LIMITS.sessionCacheBytes ||
          processBytes + value.bytes.length > RESOURCE_LIMITS.processCacheBytes) throw new ResourceError('quota-exceeded');
        const handle = newId();
        if (!uuid.test(handle) || transfers.has(handle)) throw new ResourceError('blocked-by-policy');
        const expiry = now() + 15_000;
        transfers.set(handle, { root, value, offset: 0, expiry, timer: setTimeout(() => drop(handle), 15_000) });
        sessionBytes += value.bytes.length; processBytes += value.bytes.length;
        // Empty bodies require no private read, so release their handle immediately.
        if (value.bytes.length === 0) drop(handle);
        return Object.freeze({ handle, length: value.bytes.length, mime: value.mime });
      },
      read(value: unknown) {
        active(); prune();
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ResourceError('invalid-request');
        const request = value as Record<string, unknown>;
        if (Object.keys(request).length !== 4 || request.type !== 'resource.__chunk' || typeof request.id !== 'string' ||
          !request.id || request.id.length > 128 || typeof request.handle !== 'string' || !uuid.test(request.handle) ||
          !Number.isSafeInteger(request.offset)) throw new ResourceError('invalid-request');
        const entry = transfers.get(request.handle);
        if (!entry || request.offset !== entry.offset) throw new ResourceError('blocked-by-policy');
        const end = Math.min(entry.offset + RESOURCE_LIMITS.chunkBytes, entry.value.bytes.length);
        const encoded = base64(entry.value.bytes.subarray(entry.offset, end)); entry.offset = end;
        if (end === entry.value.bytes.length) drop(request.handle);
        active(); return { type: 'resource.__chunk.result', id: request.id, base64: encoded };
      },
      cancel(root: string): void { active(); for (const [handle, entry] of transfers) if (entry.root === root) drop(handle); },
      revoke(): void { disposed = true; for (const handle of transfers.keys()) drop(handle); },
    });
  } });
}
export type ResourceTransferPool = ReturnType<typeof createResourceTransfers>;
