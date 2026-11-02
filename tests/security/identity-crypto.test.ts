import test from 'node:test';
import assert from 'node:assert/strict';
import { nsecEncode, npubEncode } from 'nostr-tools/nip19';
import { parseNsec, derivePublicKey, formatNpub } from '../../src/security/identity-crypto.ts';
import { VaultError } from '../../src/security/identity-vault.ts';

const secret = new Uint8Array(32); secret[31] = 3;
const pubkey = 'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9';

test('NIP-19 import accepts a trimmed valid scalar and derives the BIP340 vector public key', () => {
  const encoded = nsecEncode(secret);
  for (const input of [encoded, ` \n${encoded}\t`, encoded.toUpperCase()]) {
    const parsed = parseNsec(input);
    assert.deepEqual(parsed, secret);
    assert.notEqual(parsed, secret);
    assert.equal(derivePublicKey(parsed), pubkey);
    parsed.fill(0);
  }
  assert.equal(formatNpub(pubkey), npubEncode(pubkey));
});

test('wrong identifiers, checksum, mixed case and invalid scalars fail without echoing input', () => {
  const valid = nsecEncode(secret);
  const order = Uint8Array.from(Buffer.from('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141', 'hex'));
  for (const input of [npubEncode(pubkey), `nostr:${valid}`, '03'.repeat(32), valid.slice(0, -1) + (valid.endsWith('a') ? 'q' : 'a'),
    'N' + valid.slice(1), nsecEncode(new Uint8Array(32)), nsecEncode(order), nsecEncode(new Uint8Array(32).fill(255)), ' '.repeat(2049)]) {
    assert.throws(() => parseNsec(input), error => error instanceof VaultError && error.code === 'INVALID_NSEC' && error.message === 'INVALID_NSEC');
  }
  assert.throws(() => derivePublicKey(new Uint8Array(31)), VaultError);
});
