import { mapResourceItems } from '../../src/resources/bounded-map.ts';
import type { NappletMessage, HostOperationContext } from '@kehto/runtime';
import { parseResourceRequest, resourceFailure, RESOURCE_ERRORS, RESOURCE_LIMITS, ResourceError } from '../../src/resources/resource-contract.ts';
import { classifyResourceBytes } from '../../src/resources/resource-mime.ts';
type NativeResourceClient = { request(message: NappletMessage): Promise<NappletMessage> };

type Sender = HostOperationContext['send'];
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ResourceError('decode-failed');
  return value as Record<string, unknown>;
}
async function readBlob(native: NativeResourceClient, descriptor: unknown, active: () => void): Promise<Blob> {
  const transfer = object(descriptor);
  if (Object.keys(transfer).length !== 3 || typeof transfer.handle !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(transfer.handle) ||
    !Number.isSafeInteger(transfer.length) || (transfer.length as number) < 0 || (transfer.length as number) > RESOURCE_LIMITS.fileBytes ||
    typeof transfer.mime !== 'string' || transfer.mime.length > 64) throw new ResourceError('decode-failed');
  active();
  const bytes = new Uint8Array(transfer.length as number);
  for (let offset = 0; offset < bytes.length;) {
    active();
    const response = object(await native.request({ type: 'resource.__chunk', id: crypto.randomUUID(), handle: transfer.handle, offset } as NappletMessage));
    active();
    const raw = response.base64;
    if (Object.keys(response).length !== 3 || typeof raw !== 'string' || raw.length > Math.ceil(RESOURCE_LIMITS.chunkBytes / 3) * 4 ||
      raw.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new ResourceError('decode-failed');
    const decoded = atob(raw);
    if (btoa(decoded) !== raw || decoded.length !== Math.min(RESOURCE_LIMITS.chunkBytes, bytes.length - offset)) throw new ResourceError('decode-failed');
    for (let index = 0; index < decoded.length; index++) bytes[offset + index] = decoded.charCodeAt(index);
    offset += decoded.length;
  }
  active();
  if (classifyResourceBytes(bytes) !== transfer.mime) throw new ResourceError('decode-failed');
  return new Blob([bytes], { type: transfer.mime });
}
async function project(native: NativeResourceClient, request: ReturnType<typeof parseResourceRequest>, response: unknown, active: () => void): Promise<Readonly<Record<string, unknown> & {type: string}>> {
  const result = object(response);
  if (typeof result.type !== 'string' || result.id !== request.id) throw new ResourceError('decode-failed');
  if (result.type === request.type + '.error') {
    if (Object.keys(result).length !== 3 || !RESOURCE_ERRORS.includes(result.error as never)) throw new ResourceError('decode-failed');
    return { ...result, type: result.type };
  }
  if (request.type === 'resource.bytes') {
    if (Object.keys(result).length !== 3) throw new ResourceError('decode-failed');
    const blob = await readBlob(native, result.transfer, active);
    return { type: result.type, id: request.id, blob, mime: blob.type };
  }
  if (request.type === 'resource.bytesMany') {
    if (Object.keys(result).length !== 3 || !Array.isArray(result.items) || result.items.length !== request.urls.length) throw new ResourceError('decode-failed');
    let total = 0;
    const descriptors = result.items.map((value, index) => {
      const item = object(value);
      if (Object.keys(item).length !== 3 || item.url !== request.urls[index]) throw new ResourceError('decode-failed');
      if (item.ok === false && RESOURCE_ERRORS.includes(item.error as never)) return item;
      if (item.ok !== true) throw new ResourceError('decode-failed');
      const descriptor = object(item.transfer);
      if (!Number.isSafeInteger(descriptor.length) || (descriptor.length as number) < 0 || (descriptor.length as number) > RESOURCE_LIMITS.fileBytes - total) throw new ResourceError('too-large');
      total += descriptor.length as number; return item;
    });
    const items = await mapResourceItems(descriptors, async item => {
      active();
      if (item.ok === false) return {url:item.url,ok:false,error:item.error};
      const blob = await readBlob(native,item.transfer,active);
      return {url:item.url,ok:true,blob,mime:blob.type};
    });
    return { type: result.type, id: request.id, items };
  }
  return { ...result, type: result.type };
}
/** Runs only in the trusted top document. Private descriptors and chunk verbs never reach the guest. */
export function createResourceAdapter(native: NativeResourceClient, captureRecipient: () => () => boolean) {
  const pending = new Map<string, { cancelled: boolean }>();
  const cancelNative = (id: string): void => { void native.request({ type: 'resource.cancel', id } as NappletMessage).catch(() => {}); };
  return async ({ message, send }: { message: NappletMessage | (Record<string, unknown> & {type: string}); send: Sender }): Promise<void> => {
    const live = captureRecipient();
    let request: ReturnType<typeof parseResourceRequest>;
    try { request = parseResourceRequest(message); }
    catch (error) {
      const failure = resourceFailure(message, error instanceof ResourceError ? error.code : 'invalid-request');
      if (live() && failure) send(failure); return;
    }
    if (request.type === 'resource.cancel') {
      const work = pending.get(request.id); if (work) work.cancelled = true;
      cancelNative(request.id); return;
    }
    if (pending.has(request.id) || pending.size >= 4) { send(resourceFailure(request, 'quota-exceeded')!); return; }
    const work = { cancelled: false }; pending.set(request.id, work);
    const active = (): void => { if (work.cancelled || !live()) throw new ResourceError('timeout'); };
    try {
      active(); const response = await project(native, request, await native.request(message as NappletMessage), active);
      active(); send(response);
    } catch (error) {
      cancelNative(request.id);
      if (!work.cancelled && live()) send(resourceFailure(request, error instanceof ResourceError ? error.code : 'network-error')!);
    } finally { if (pending.get(request.id) === work) pending.delete(request.id); }
  };
}
