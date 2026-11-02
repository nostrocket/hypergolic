import { npubEncode } from 'nostr-tools/nip19';
import { VaultError } from './identity-vault-model.ts';

export function formatNpub(pubkey: string): string {
  if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new VaultError('INVALID_SECRET');
  return npubEncode(pubkey);
}
