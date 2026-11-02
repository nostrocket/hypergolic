import type { HostOperationContext, NappletMessage } from '@kehto/runtime';
import { captureUploadBytes, parseUploadRequest, captureUploadResult, UploadError, UPLOAD_ERRORS, UPLOAD_LIMITS } from '../../src/uploads/upload-contract';
type NativeUploadClient = {request(message: NappletMessage, upload?: Readonly<{uploadId: string; onStatus(message: NappletMessage): void}>): Promise<NappletMessage>};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UploadError('upload failed');
  return value as Record<string, unknown>;
}
function base64(bytes: Uint8Array): string {
  let text = ''; for (const byte of bytes) text += String.fromCharCode(byte); return btoa(text);
}
/** Trusted top document reverse byte carrier. Public callers still supply Blob/ArrayBuffer through structured clone. */
export function createUploadAdapter(native: NativeUploadClient, captureRecipient: () => () => boolean) {
  let busy = false;
  const callerIds = new Set<string>();
  return async ({message, send}: HostOperationContext): Promise<void> => {
    const live = captureRecipient();
    let request: ReturnType<typeof parseUploadRequest>;
    try {request = parseUploadRequest(message);}
    catch (error) {
      const raw = object(message);
      if (live() && typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= 128 && typeof raw.type === 'string')
        send({type: raw.type + '.result', id: raw.id, error: error instanceof UploadError ? error.code : 'invalid request'});
      return;
    }
    if (request.type !== 'upload.upload') {
      try { const response = await native.request(message); if (live()) send({...response}); }
      catch {if (live()) send({type: request.type + '.result', id: request.id, error: 'policy denied'});}
      return;
    }
    if (busy || callerIds.has(request.id) || callerIds.size >= 1024) {
      if (live()) send({type: 'upload.upload.result', id: request.id, error: 'quota exceeded'}); return;
    }
    busy = true; callerIds.add(request.id);
    // This starts the intrinsic copy synchronously, before any asynchronous native work.
    const captured = captureUploadBytes(request.request.data);
    let token: string | null = null, sealed = false;
    let bytes: Uint8Array<ArrayBuffer> | null = null;
    const active = (): void => {if (!live()) throw new UploadError('user cancelled');};
    const call = async (type: string, fields: Record<string, unknown>, upload?: Readonly<{uploadId: string; onStatus(message: NappletMessage): void}>) => {
      active(); const id = crypto.randomUUID();
      const response = object(await native.request({type, id, ...fields} as NappletMessage, upload)); active();
      if (response.type !== type + '.result' || response.id !== id) throw new UploadError('upload failed');
      if (Object.hasOwn(response, 'error')) throw new UploadError(UPLOAD_ERRORS.includes(response.error as never) ? response.error as never : 'upload failed');
      return response;
    };
    try {
      bytes = await captured; active();
      const {data: _data, ...metadata} = request.request;
      const begin = await call('upload.__begin', {wireId: request.id, byteLength: bytes.length, request: metadata});
      if (Object.keys(begin).length !== 4 || typeof begin.token !== 'string' || typeof begin.uploadId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(begin.token) ||
        begin.token === begin.uploadId || begin.uploadId.length > UPLOAD_LIMITS.idBytes) throw new UploadError('upload failed');
      token = begin.token;
      // Native cursor acknowledgements are dependent: each bounded chunk must finish before the next begins.
      const offsets = Array.from({length: Math.ceil(bytes.length / UPLOAD_LIMITS.chunkBytes)}, (_, index) => index * UPLOAD_LIMITS.chunkBytes);
      await offsets.reduce((previous, offset) => previous.then(async () => {
        const response = await call('upload.__append', {token, offset, base64: base64(bytes!.subarray(offset, offset + UPLOAD_LIMITS.chunkBytes))});
        if (Object.keys(response).length !== 3 || response.cursor !== Math.min(bytes!.length, offset + UPLOAD_LIMITS.chunkBytes)) throw new UploadError('upload failed');
      }), Promise.resolve());
      const response = await call('upload.__seal', {token}, {uploadId: begin.uploadId, onStatus: status => {if (live()) send({...status});}});
      if (Object.keys(response).length !== 3) throw new UploadError('upload failed');
      const result = captureUploadResult(response.result, begin.uploadId);
      sealed = true; if (live()) send({type: 'upload.upload.result', id: request.id, result});
    } catch (error) {
      if (live()) send({type: 'upload.upload.result', id: request.id, error: error instanceof UploadError ? error.code : 'upload failed'});
    } finally {
      bytes?.fill(0); busy = false;
      if (token !== null && !sealed) void native.request({type: 'upload.__cancel', id: crypto.randomUUID(), token} as NappletMessage).catch(() => {});
    }
  };
}
