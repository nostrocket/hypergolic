import { assertVerifiedArtifact, MAX_HTML_BYTES, type VerifiedNappletArtifact } from './verified-artifact.ts';

/** App-only Expo module surface. The WebView and napplet never receive this port. */
export interface NativePublishedTransferPort {
  registerPublishedSession(sessionId: string): boolean;
  beginPublishedArtifact(sessionId: string, publisher: string, identifier: string, eventId: string,
    aggregateHash: string, htmlHash: string, byteLength: number): string | null;
  appendPublishedArtifact(uploadId: string, sequence: number, base64Chunk: string): boolean;
  finishPublishedArtifact(uploadId: string): string | null;
  cancelPublishedArtifact(uploadId: string): void;
  revokePublishedSession(sessionId: string): void;
  revokeAllPublishedArtifacts(): void;
}

export class PublishedTransferError extends Error {
  readonly code = 'PUBLISHED_TRANSFER_FAILED';
  constructor() { super('The published napplet could not be prepared'); this.name = 'PublishedTransferError'; }
}

/** Divisible by three, so every full chunk has canonical unpadded Base64. */
export const TRANSFER_CHUNK_BYTES = 48 * 1024;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const SESSION = /^[A-Za-z0-9_-]{1,80}$/;

function encodeBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    parts.push(ALPHABET[first >> 2]!, ALPHABET[((first & 3) << 4) | ((second ?? 0) >> 4)]!,
      second === undefined ? '=' : ALPHABET[((second & 15) << 2) | ((third ?? 0) >> 6)]!,
      third === undefined ? '=' : ALPHABET[third & 63]!);
  }
  return parts.join('');
}

function active(signal: AbortSignal, assertActive: () => void): void {
  if (signal.aborted) throw new PublishedTransferError();
  try { assertActive(); } catch { throw new PublishedTransferError(); }
  if (signal.aborted) throw new PublishedTransferError();
}

/**
 * Stage only a verifier-branded artifact into an already registered native session.
 * Callers must establish first-open consent before invoking this function. The
 * returned handle is for one exact native host claim, never for a WebView prop
 * containing bytes, a URL, or a filesystem path.
 */
export async function stageVerifiedArtifact(artifactInput: unknown, sessionId: string,
  port: NativePublishedTransferPort, signal: AbortSignal, assertActive: () => void): Promise<string> {
  assertVerifiedArtifact(artifactInput);
  const artifact: VerifiedNappletArtifact = artifactInput;
  if (!SESSION.test(sessionId)) throw new PublishedTransferError();
  const identifier = artifact.manifest.tags.find(tag => tag[0] === 'd')?.[1];
  if (!identifier) throw new PublishedTransferError();
  const bytes = artifact.htmlBytes;
  if (bytes.length < 1 || bytes.length > MAX_HTML_BYTES) throw new PublishedTransferError();
  let uploadId: string | null = null;
  let handle: string | null = null;
  try {
    active(signal, assertActive);
    uploadId = port.beginPublishedArtifact(sessionId, artifact.manifest.pubkey, identifier,
      artifact.manifest.eventId, artifact.aggregateHash, artifact.htmlHash, bytes.length);
    if (!uploadId) throw new PublishedTransferError();
    for (let offset = 0, sequence = 0; offset < bytes.length; offset += TRANSFER_CHUNK_BYTES, sequence++) {
      active(signal, assertActive);
      if (!port.appendPublishedArtifact(uploadId, sequence,
        encodeBase64(bytes.subarray(offset, offset + TRANSFER_CHUNK_BYTES)))) throw new PublishedTransferError();
      active(signal, assertActive);
      // Give close, background and identity changes a chance to revoke long transfers.
      if (sequence % 4 === 3) await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    active(signal, assertActive);
    handle = port.finishPublishedArtifact(uploadId);
    uploadId = null; // Finish consumes an upload even when native verification rejects it.
    if (!handle) throw new PublishedTransferError();
    active(signal, assertActive);
    return handle;
  } catch {
    // A late revocation after finalize must also destroy the staged native bytes.
    if (handle) try { port.revokePublishedSession(sessionId); } catch { /* Native also expires the handle. */ }
    throw new PublishedTransferError();
  } finally {
    if (uploadId) try { port.cancelPublishedArtifact(uploadId); } catch { /* Native expiry is the backstop. */ }
    bytes.fill(0);
  }
}
