import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = process.env.HYPERGOLIC_NOSTR_REPO;
if (!repo) throw new Error('Set HYPERGOLIC_NOSTR_REPO to the app checkout with its installed dependencies');
const require = createRequire(resolve(repo, 'package.json'));
const { npubEncode, nprofileEncode } = require('nostr-tools/nip19');
const valid = npubEncode('01'.repeat(32));
function observations(value = valid) { return Object.fromEntries(['headerBefore', 'settingsBefore', 'headerAfter', 'settingsAfter'].map(name => [name, value])); }
function check(input) {
  return spawnSync(process.execPath, [fileURLToPath(new URL('./identity-encoding.mjs', import.meta.url)), repo], {input: JSON.stringify(input), encoding: 'utf8'});
}
test('owning decoder accepts four identical canonical public npubs', () => {
  const run = check(observations());
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.publicKey, '01'.repeat(32));
  assert.equal(result.checksumAndCanonicalEncoding, true);
  assert.equal(result.validatedCount, 4);
});
test('valid-length invalid checksum, different prefix and malformed shape fail', () => {
  for (const value of [valid.slice(0, -1) + (valid.endsWith('q') ? 'p' : 'q'), nprofileEncode({pubkey:'01'.repeat(32)}), valid.toUpperCase(), valid.slice(1)]) {
    assert.notEqual(check(observations(value)).status, 0, value);
  }
});
test('individually valid changed identity or missing observation fails', () => {
  assert.notEqual(check({...observations(), headerAfter: npubEncode('02'.repeat(32))}).status, 0);
  const partial = observations(); delete partial.settingsAfter;
  assert.notEqual(check(partial).status, 0);
});
