import test from 'node:test';
import assert from 'node:assert/strict';
import { VaultError } from '../../src/security/identity-vault.ts';
import { decodeDatabase, decodeInventory, encodeSecret } from '../../src/security/identity-codec.ts';
import { INVENTORY_KEY, secretStorageKey } from '../../src/security/android-encrypted-secrets.ts';
import { Integrated, pubkey } from './harness.ts';

for (const platform of ['android', 'ios'] as const) test(`${platform} SQL settings plus fake Android protected envelopes preserve initialize/import/select/duplicate/delete/restart`, async t => {
  const h = new Integrated(); t.after(() => h.sqlite.cleanup()); let { vault, database } = await h.owner(platform);
  assert.equal((await vault.open()).selectedPubkey, pubkey(1));
  await vault.importNsec('nsec1fixture-2'); await vault.select(pubkey(1));
  const keyBefore = h.secure.values.get(secretStorageKey(pubkey(2)));
  await vault.importNsec('nsec1fixture-2'); assert.equal(h.secure.values.get(secretStorageKey(pubkey(2))), keyBefore);
  await vault.deleteIdentity(pubkey(1)); assert.equal(h.authCalls, 1);
  await database.close(); ({ vault, database } = await h.owner(platform));
  const snapshot = await vault.open(); assert.equal(snapshot.selectedPubkey, pubkey(2)); assert.equal(snapshot.identities.length, 1);
  assert.equal(h.generated, 1); assert.equal(h.secure.values.has(secretStorageKey(pubkey(1))), false);
  assert(!h.sqlite.statements.some(statement => JSON.stringify(statement.params).includes('secretKey')));
});
test('iOS-style surviving Keychain with missing DB blocks ordinary initialization; explicit recovery retains selection', async t => {
  const h = new Integrated(); t.after(() => h.sqlite.cleanup()); const first = await h.owner();
  await first.vault.open(); await first.vault.importNsec('nsec1fixture-2');
  await first.database.close(); h.sqlite.removeDatabase();
  const before = new Map(h.secure.values), next = await h.owner();
  await assert.rejects(next.vault.open(), { code: 'RECOVERY_REQUIRED' });
  assert.equal(h.generated, 1); assert.deepEqual(h.secure.values, before);
  assert.equal((await next.vault.recoverMissingDatabase()).selectedPubkey, pubkey(2));
  assert.deepEqual(h.secure.values, before); assert.equal(h.generated, 1);
});
for (const key of [INVENTORY_KEY, secretStorageKey(pubkey(1)), secretStorageKey(pubkey(2))]) test(`established missing protected item never generates replacement (${key.slice(0, 18)})`, async t => {
  const h = new Integrated(); t.after(() => h.sqlite.cleanup()); const first = await h.owner();
  await first.vault.open(); await first.vault.importNsec('nsec1fixture-2'); await first.database.close(); h.secure.values.delete(key);
  const next = await h.owner(); await assert.rejects(next.vault.open(), { code: 'RECOVERY_REQUIRED' });
  assert.equal(h.generated, 1); assert(!h.secure.values.has(key));
});
test('duplicate import preserves an existing valid x-only-equivalent scalar envelope', async t => {
  const h = new Integrated(); t.after(() => h.sqlite.cleanup()); const first = await h.owner(); await first.vault.open();
  const encoded = encodeSecret({ schema: 1, pubkey: pubkey(1), secretKey: new Uint8Array(32).fill(129) });
  h.secure.values.set(secretStorageKey(pubkey(1)), encoded);
  await first.vault.importNsec('nsec1fixture-1'); assert.equal(h.secure.values.get(secretStorageKey(pubkey(1))), encoded);
});
test('iOS-style successful delete with item still present leaves tombstone and requires new authentication', async t => {
  const h = new Integrated(); t.after(() => h.sqlite.cleanup()); const first = await h.owner();
  await first.vault.open(); await first.vault.importNsec('nsec1fixture-2');
  h.secure.fault = { match: `delete:${secretStorageKey(pubkey(1))}`, mode: 'omit' };
  await assert.rejects(first.vault.deleteIdentity(pubkey(1)), { code: 'READBACK_FAILED' });
  await first.database.close(); const next = await h.owner();
  assert.equal((await next.vault.open()).pendingDeletion, pubkey(1)); assert.equal(h.authCalls, 1);
  assert(h.secure.values.has(secretStorageKey(pubkey(1))));
  await next.vault.deleteIdentity(pubkey(1)); assert.equal(h.authCalls, 2);
});
test('background revocation during tombstone write prevents native deletion; transient inactive policy is owned above adapter', async t => {
  const h = new Integrated(); t.after(() => h.sqlite.cleanup()); const first = await h.owner();
  await first.vault.open(); await first.vault.importNsec('nsec1fixture-2'); h.secure.calls = [];
  h.sqlite.onStep = name => { if (name === 'exec:COMMIT') h.authActive = false; };
  await assert.rejects(first.vault.deleteIdentity(pubkey(1)), { code: 'AUTHORIZATION_DENIED' });
  assert(!h.secure.calls.some(call => call.startsWith('delete:secret.')));
  assert(h.secure.values.has(secretStorageKey(pubkey(1))));
});
test('prepared selection recovery may rewrite same revision receipt while retaining the prior selection', async t => {
  const h = new Integrated(); t.after(() => h.sqlite.cleanup()); const first = await h.owner();
  await first.vault.open(); await first.vault.importNsec('nsec1fixture-2');
  h.sqlite.fault = { match: 'exec:COMMIT', mode: 'before', nth: 2 };
  await assert.rejects(first.vault.select(pubkey(1)), { code: 'READBACK_FAILED' });
  assert.equal(decodeInventory(h.secure.values.get(INVENTORY_KEY)!).selectedPubkey, pubkey(1));
  await first.database.close(); const next = await h.owner();
  assert.equal((await next.vault.open()).selectedPubkey, pubkey(2)); assert.equal(h.generated, 1);
});
test('prepared import recovery retains prior selection after protected receipt write but failed DB commit', async t => {
  const h = new Integrated(); t.after(() => h.sqlite.cleanup()); const first = await h.owner(); await first.vault.open();
  h.sqlite.fault = { match: 'exec:COMMIT', mode: 'before', nth: 2 };
  await assert.rejects(first.vault.importNsec('nsec1fixture-2'), { code: 'READBACK_FAILED' });
  await first.database.close(); const next = await h.owner(), snapshot = await next.vault.open();
  assert.equal(snapshot.selectedPubkey, pubkey(1)); assert.equal(snapshot.identities.length, 2); assert.equal(h.generated, 1);
});
const seams = [
  { store: 'secure', match: 'set:inventory', nth: 1 },
  { store: 'secure', match: 'set:stage', nth: 1 },
  { store: 'secure', match: `set:${secretStorageKey(pubkey(1))}`, nth: 1 },
  { store: 'secure', match: 'set:inventory', nth: 2 },
  { store: 'secure', match: 'delete:stage', nth: 1 },
  // Schema creation is completed by h.owner; these COMMITs are the initial journal and ready journal.
  { store: 'sqlite', match: 'exec:COMMIT', nth: 1 },
  { store: 'sqlite', match: 'exec:COMMIT', nth: 2 },
] as const;
for (const seam of seams) for (const mode of ['before', 'after', 'omit'] as const) {
  if (mode === 'omit' && seam.store === 'sqlite') continue;
  test(`initialization ${seam.store} ${seam.match.slice(0, 20)}#${seam.nth} ${mode}: exact receipt/stage or explicit recovery`, async t => {
    const h = new Integrated(); t.after(() => h.sqlite.cleanup()); const first = await h.owner();
    h[seam.store].fault = { match: seam.match, nth: seam.nth, mode };
    const attempt = await Promise.allSettled([first.vault.open()]);
    const generated = h.generated;
    await first.database.close(); const next = await h.owner();
    try {
      const recovered = await next.vault.open(); assert.equal(recovered.selectedPubkey, pubkey(1));
      assert(h.generated === generated || generated === 0 && h.generated === 1);
    } catch (error) {
      assert(error instanceof VaultError && error.code === 'RECOVERY_REQUIRED');
      assert.equal(h.generated, generated);
      assert.equal(attempt[0]!.status, 'rejected');
    }
    const raw = await next.database.read();
    if (raw !== null) assert(!JSON.stringify(decodeDatabase(JSON.stringify(raw))).includes('secretKey'));
  });
}
