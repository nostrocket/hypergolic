import { validateSignedEvent, type VerifiedSignedEvent } from '../security/signed-event.ts';
import { UploadError, UPLOAD_LIMITS } from './upload-contract.ts';
import type { UploadSnapshot } from './upload-snapshot.ts';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function base64url(bytes: Uint8Array): string {
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const a = bytes[offset]!, b = bytes[offset + 1] ?? 0, c = bytes[offset + 2] ?? 0;
    result += alphabet[a >> 2]! + alphabet[((a & 3) << 4) | (b >> 4)]!;
    if (offset + 1 < bytes.length) result += alphabet[((b & 15) << 2) | (c >> 6)]!;
    if (offset + 2 < bytes.length) result += alphabet[c & 63]!;
  }
  return result;
}
/** App-only credential. Revalidate a fresh signed copy; no verifier cache or signer-added scope is trusted. */
export function captureUploadAuthorization(snapshot: UploadSnapshot, signed: unknown, now: number):
  Readonly<{ event: VerifiedSignedEvent; token: string }> {
  try {
    const created = snapshot.authorization.created_at;
    if (snapshot.purpose !== 'blossom-upload' || !Number.isSafeInteger(now) || now < 1 || created >= now ||
      now >= created + UPLOAD_LIMITS.authorizationSeconds) throw new UploadError('policy denied');
    const event = validateSignedEvent({event: snapshot.authorization, selectedPubkey: snapshot.selectedPubkey,
      hash: snapshot.eventHash, destinations: Object.freeze([snapshot.destination])}, signed);
    const token = base64url(new TextEncoder().encode(JSON.stringify(event)));
    if (token.length > 4096) throw new UploadError('policy denied');
    return Object.freeze({event, token});
  } catch { throw new UploadError('policy denied'); }
}
