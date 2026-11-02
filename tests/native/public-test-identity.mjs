// PUBLIC DISPOSABLE TEST KEY: scalar 2, never use for any real identity or funds.
import { getPublicKey } from 'nostr-tools/pure';
import { decode, nsecEncode, npubEncode } from 'nostr-tools/nip19';
const input = process.argv[2];
if (input) {
  const value = decode(input);
  if (value.type !== 'npub') throw Error('Expected public identity');
  process.stdout.write(JSON.stringify({ pubkey: value.data }));
} else {
  const secret = new Uint8Array(32); secret[31] = 2;
  try { const pubkey = getPublicKey(secret); process.stdout.write(JSON.stringify({ nsec: nsecEncode(secret), pubkey, npub: npubEncode(pubkey) })); }
  finally { secret.fill(0); }
}
