// Read public UI observations only. The selected repository owns the decoder.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repo = process.argv[2];
if (!repo) throw new Error('An explicit repository is required for its installed Nostr decoder');
const require = createRequire(resolve(repo, 'package.json'));
const nip19Path = require.resolve('nostr-tools/nip19');
const { decode, npubEncode } = require('nostr-tools/nip19');
const input = JSON.parse(readFileSync(0, 'utf8'));
const names = ['headerBefore', 'settingsBefore', 'headerAfter', 'settingsAfter'];
if (Object.keys(input).sort().join(',') !== [...names].sort().join(',')) throw new Error('Unexpected identity observations');
const observed = names.map(name => input[name]);
if (!observed.every(value => typeof value === 'string' && /^npub1[023456789acdefghjklmnpqrstuvwxyz]{58}$/.test(value))
    || new Set(observed).size !== 1) throw new Error('UI identity observations are malformed or changed');
const npub = observed[0];
let publicKey;
for (const value of observed) {
  const decoded = decode(value);
  if (decoded.type !== 'npub' || typeof decoded.data !== 'string' || !/^[0-9a-f]{64}$/.test(decoded.data)
      || npubEncode(decoded.data) !== value) throw new Error('Nostr decoder did not confirm canonical npub and 32-byte public key');
  publicKey = decoded.data;
}
process.stdout.write(JSON.stringify({ passed: true, npub, publicKey, validatedCount: observed.length, decoder: 'nostr-tools/nip19', decoderPath: nip19Path,
    checksumAndCanonicalEncoding: true, privateKeyRead: false }) + '\n');
