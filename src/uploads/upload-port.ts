import { decodeNativeRegistration } from '../runtime/capability-protocol.ts';
import { text } from '../storage/codec.ts';
import { parseUploadRequest, UPLOAD_ERRORS, UploadError, UPLOAD_LIMITS, captureUploadResult } from './upload-contract.ts';
import type { TakenUpload, UploadLease, UploadNativePort, UploadReview } from './upload-service.ts';

export interface UploadModule {
  listUploadRecovery?(): string;
  checkUploadRecovery?(uploadId: string): Promise<string>;
  addListener?(name: 'onUploadProgress', listener: (event: unknown) => void): {remove(): void};
  takeUpload(token: string): string | null;
  isUploadLive(token: string): boolean;
  mayReviewUpload(token: string): boolean;
  readUploadPreview(token: string, offset: number): string | null;
  approveUpload(token: string): boolean;
  isUploadApproved(token: string): boolean;
  claimUploadSigning(token: string): boolean;
  putUpload(token: string, credential: string): Promise<string>;
  wasUploadDispatched(token: string): boolean;
  cancelUpload(token: string): void;
  finishUpload(token: string, result: string): void;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new UploadError('policy denied');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== Object.keys(descriptors).length ||
    Object.values(descriptors).some(field => !Object.hasOwn(field, 'value') || !field.enumerable)) throw new UploadError('policy denied');
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) throw new UploadError('policy denied');
}
function decode(raw: string): Omit<TakenUpload, 'lease'> {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > 40 * 1024) throw new UploadError('policy denied');
  const value = record(JSON.parse(raw)); exact(value, ['registration','request','uploadId','review']);
  const registration = record(value.registration);
  if (!Array.isArray(registration.domains) || registration.domains.filter(domain => domain === 'upload').length !== 1) throw new UploadError('policy denied');
  const captured = decodeNativeRegistration(registration);
  if (typeof value.request !== 'string') throw new UploadError('policy denied');
  const header = record(JSON.parse(value.request));
  if (Object.hasOwn(header, 'data')) throw new UploadError('policy denied');
  const request = parseUploadRequest({type: 'upload.upload', id: 'native-upload-capture', request: {...header, data: new ArrayBuffer(0)}});
  if (request.type !== 'upload.upload') throw new UploadError('policy denied');
  const review = record(value.review); exact(review, ['purpose','identity','destination','sha256','size','mimeType','metadataPolicy']);
  if (review.purpose !== 'blossom-upload' || review.identity !== captured.user || typeof review.destination !== 'string' ||
    typeof review.sha256 !== 'string' || !Number.isSafeInteger(review.size) || (review.size as number) < 0 || (review.size as number) > UPLOAD_LIMITS.fileBytes ||
    typeof review.mimeType !== 'string' || !['photo-stripped','attachment-unchanged'].includes(review.metadataPolicy as string)) throw new UploadError('policy denied');
  const {data: _data, ...capturedHeader} = request.request;
  return Object.freeze({origin: captured, request: Object.freeze(capturedHeader), uploadId: text(value.uploadId, UPLOAD_LIMITS.idBytes),
    filename: request.request.filename ?? '', caption: request.request.caption ?? '', review: Object.freeze({...review}) as UploadReview});
}
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function bytes(raw: string | null): Uint8Array<ArrayBuffer> {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > Math.ceil(UPLOAD_LIMITS.chunkBytes / 3) * 4 ||
    raw.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new UploadError('policy denied');
  const padding = raw.endsWith('==') ? 2 : raw.endsWith('=') ? 1 : 0, output = new Uint8Array(raw.length / 4 * 3 - padding);
  let cursor = 0;
  for (let index = 0; index < raw.length; index += 4) {
    const a = alphabet.indexOf(raw[index]!), b = alphabet.indexOf(raw[index+1]!),
      c = raw[index+2] === '=' ? 0 : alphabet.indexOf(raw[index+2]!), d = raw[index+3] === '=' ? 0 : alphabet.indexOf(raw[index+3]!);
    if ((raw[index+2] === '=' && (b & 15) !== 0) || (raw[index+3] === '=' && raw[index+2] !== '=' && (c & 3) !== 0)) throw new UploadError('policy denied');
    output[cursor++] = (a << 2) | (b >> 4);
    if (cursor < output.length) output[cursor++] = ((b & 15) << 4) | (c >> 2);
    if (cursor < output.length) output[cursor++] = ((c & 3) << 6) | d;
  }
  return output;
}
/** App-only adapter. A token cannot be selected by a guest or replaced through a structurally forged lease. */
export function createNativeUploadPort(module: UploadModule): UploadNativePort {
  const tokens = new WeakMap<UploadLease, string>(), uploads = new WeakMap<UploadLease, string>();
  const tokenFor = (lease: UploadLease): string => {const token = tokens.get(lease); if (!token) throw new UploadError('policy denied'); return token;};
  const recovery = module.listUploadRecovery && module.checkUploadRecovery ? Object.freeze({
    list: () => {
      const raw = module.listUploadRecovery!();
      if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > 256 * 1024) throw new UploadError('policy denied');
      return JSON.parse(raw) as unknown;
    },
    check: async (uploadId: string) => {
      const raw = await module.checkUploadRecovery!(text(uploadId, 36));
      if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > 1024) throw new UploadError('policy denied');
      return JSON.parse(raw) as unknown;
    },
  }) : undefined;
  return Object.freeze<UploadNativePort>({
    ...(recovery ? {recovery} : {}),
    take(token: string) {
      const raw = module.takeUpload(token); if (raw === null) return null;
      try {
        const captured = decode(raw), lease = Object.freeze({}); tokens.set(lease, token); uploads.set(lease, captured.uploadId);
        return Object.freeze({...captured, lease});
      } catch {
        try {module.cancelUpload(token);} catch { /* Native malformed capture remains denied. */ }
        return null;
      }
    },
    observeProgress(lease, update) {
      const token = tokenFor(lease); let sent = -1;
      const listener = module.addListener?.('onUploadProgress', input => {
        try {
          const event = record(input); exact(event, ['token', 'bytesSent', 'bytesTotal']);
          if (event.token !== token || tokens.get(lease) !== token || !Number.isSafeInteger(event.bytesSent) ||
            !Number.isSafeInteger(event.bytesTotal) || (event.bytesSent as number) < 0 || (event.bytesSent as number) < sent ||
            (event.bytesSent as number) > (event.bytesTotal as number) || (event.bytesTotal as number) > UPLOAD_LIMITS.fileBytes ||
            !module.isUploadApproved(token)) return;
          sent = event.bytesSent as number; update(sent, event.bytesTotal as number);
        } catch { /* Progress carries no approval authority. */ }
      });
      return () => listener?.remove();
    },
    signingSource: lease => Object.freeze({ kind: 'upload', token: tokenFor(lease) }),
    isLive: lease => module.isUploadLive(tokenFor(lease)), mayReview: lease => module.mayReviewUpload(tokenFor(lease)),
    readPreview: (lease, offset) => {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset % UPLOAD_LIMITS.chunkBytes !== 0) throw new UploadError('policy denied');
      return bytes(module.readUploadPreview(tokenFor(lease), offset));
    },
    approveOnce: lease => module.approveUpload(tokenFor(lease)), isApproved: lease => module.isUploadApproved(tokenFor(lease)),
    claimSigning: lease => module.claimUploadSigning(tokenFor(lease)),
    async put(lease, credential) {
      const raw = await module.putUpload(tokenFor(lease), credential);
      if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > 40 * 1024) throw new UploadError('outcome unknown');
      const response = record(JSON.parse(raw));
      if (response.ok === false) {
        exact(response, ['ok','error']);
        throw new UploadError(UPLOAD_ERRORS.includes(response.error as never) ? response.error as never : 'outcome unknown');
      }
      exact(response, ['ok','descriptor']); if (response.ok !== true) throw new UploadError('outcome unknown'); return response.descriptor;
    },
    wasDispatched: lease => module.wasUploadDispatched(tokenFor(lease)), cancel: lease => module.cancelUpload(tokenFor(lease)),
    finish(lease, result) {
      const token = tokenFor(lease), uploadId = uploads.get(lease)!;
      const captured = captureUploadResult(result, uploadId);
      try {module.finishUpload(token, JSON.stringify(captured));}
      catch (error) {try {module.cancelUpload(token);} catch { /* Terminal delivery loss cannot retain authority. */ } throw error;}
      finally {tokens.delete(lease); uploads.delete(lease);}
    },
  });
}
