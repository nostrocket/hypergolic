import { getEventHash } from 'nostr-tools/pure';
import { publicKey } from '../storage/codec.ts';
import type { EventSnapshot, UnsignedEventTemplate } from '../security/event-snapshot.ts';
import { normalizeUploadServer, uploadHash, uploadMime, UploadError, UPLOAD_LIMITS } from './upload-contract.ts';

export type UploadSnapshot = Readonly<{ purpose: 'blossom-upload'; selectedPubkey: string; destination: string;
  sha256: string; size: number; mimeType: string; authorization: UnsignedEventTemplate; eventHash: string;
  copyBytes(): Uint8Array<ArrayBuffer> }>;
const snapshots = new WeakSet<object>();

/** App-only output-byte snapshot. Sanitization and native origin capture must precede this boundary. */
export async function captureUploadSnapshot(bytes: Uint8Array, selectedPubkeyValue: string, destinationValue: string,
  mimeTypeValue: string, createdAt: number, sha256: (bytes: Uint8Array<ArrayBuffer>) => Promise<string>): Promise<UploadSnapshot> {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > UPLOAD_LIMITS.fileBytes || !Number.isSafeInteger(createdAt) || createdAt < 1 ||
        createdAt > Number.MAX_SAFE_INTEGER - UPLOAD_LIMITS.authorizationSeconds) throw new UploadError('invalid request');
    const owned = new Uint8Array(bytes), selectedPubkey = publicKey(selectedPubkeyValue);
    const destination = normalizeUploadServer(destinationValue), mimeType = uploadMime(mimeTypeValue);
    // A hashing port gets a copy too: no app callback can mutate the reviewed body.
    const hash = uploadHash(await sha256(new Uint8Array(owned)));
    const tags = Object.freeze([['t', 'upload'], ['x', hash], ['server', new URL(destination).hostname],
      ['expiration', String(createdAt + UPLOAD_LIMITS.authorizationSeconds)]].map(tag => Object.freeze(tag)));
    const authorization: UnsignedEventTemplate = Object.freeze({kind: 24242, created_at: createdAt,
      content: 'Upload reviewed file to ' + destination, tags});
    const eventHash = getEventHash({...authorization, tags: tags.map(tag => [...tag]), pubkey: selectedPubkey});
    const snapshot: UploadSnapshot = Object.freeze({purpose: 'blossom-upload', selectedPubkey, destination, sha256: hash, size: owned.byteLength,
      mimeType, authorization, eventHash, copyBytes: () => new Uint8Array(owned)});
    snapshots.add(snapshot);
    return snapshot;
  } catch (error) { if (error instanceof UploadError) throw error; throw new UploadError('invalid request'); }
}

/** Purpose-specific projection for the protected signer; structural lookalikes have no authority. */
export function uploadSigningSnapshot(snapshot: UploadSnapshot): EventSnapshot {
  if (!snapshots.has(snapshot)) throw new UploadError('policy denied');
  return Object.freeze({event: snapshot.authorization, selectedPubkey: snapshot.selectedPubkey,
    destinations: Object.freeze([snapshot.destination]), hash: snapshot.eventHash});
}
