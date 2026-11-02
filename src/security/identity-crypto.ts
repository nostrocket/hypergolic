import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { decode, npubEncode } from 'nostr-tools/nip19';
import { VaultError } from './identity-vault.ts';

export function derivePublicKey(secretKey: Uint8Array): string {
  if (!(secretKey instanceof Uint8Array) || secretKey.length !== 32) throw new VaultError('INVALID_SECRET');
  try { return getPublicKey(secretKey); }
  catch { throw new VaultError('INVALID_SECRET'); }
}

export function parseNsec(value: string): Uint8Array {
  let decodedSecret: Uint8Array | undefined;
  try {
    if (typeof value !== 'string' || value.length > 2048) throw new VaultError('INVALID_NSEC');
    const trimmed = value.trim();
    if (trimmed.length !== 63 || !/^nsec1[0-9a-z]+$/i.test(trimmed)) throw new VaultError('INVALID_NSEC');
    const decoded = decode(trimmed as `nsec1${string}`);
    if (decoded.type !== 'nsec') throw new VaultError('INVALID_NSEC');
    decodedSecret = decoded.data;
    derivePublicKey(decodedSecret);
    return new Uint8Array(decodedSecret);
  } catch { throw new VaultError('INVALID_NSEC'); }
  finally { decodedSecret?.fill(0); }
}

export function publicKeyFromNsec(input: string): string {
  const secret = parseNsec(input);
  try { return derivePublicKey(secret); } finally { secret.fill(0); }
}

export function newOpaqueId(): string {
  const bytes = new Uint8Array(24);
  try {
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  } finally { bytes.fill(0); }
}

export function formatNpub(pubkey: string): string {
  if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new VaultError('INVALID_SECRET');
  return npubEncode(pubkey);
}

export const identityCrypto = Object.freeze({ generateSecretKey, derivePublicKey, parseNsec, newId: newOpaqueId, now: Date.now });
