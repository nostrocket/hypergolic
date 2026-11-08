import { decode, npubEncode } from 'nostr-tools/nip19';
import { VaultError } from './identity-vault-model.ts';

export function formatNpub(pubkey: string): string {
  if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new VaultError('INVALID_SECRET');
  return npubEncode(pubkey);
}

/** Public identifiers only. Secret-key prefixes never enter the NIP-19 decoder. */
export function parsePublicIdentity(input: string): string {
  const trimmed = input.trim(), value = trimmed.toLowerCase();
  if (/^[0-9a-f]{64}$/.test(value)) return value;
  if (trimmed !== value && trimmed !== trimmed.toUpperCase()) throw new Error('INVALID_PUBLIC_KEY');
  if (!/^npub1[023456789acdefghjklmnpqrstuvwxyz]{58}$/.test(value)) throw new Error('INVALID_PUBLIC_KEY');
  const decoded = decode(value);
  if (decoded.type !== 'npub' || npubEncode(decoded.data) !== value) throw new Error('INVALID_PUBLIC_KEY');
  return decoded.data;
}
