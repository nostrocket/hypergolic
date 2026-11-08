import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePublicIdentity, formatNpub } from '../../src/security/public-identity.ts';
import { IdentityTransition } from '../../src/security/identity-transition.ts';
import { initialTestWorkspace, assertBundledWorkspace } from '../../src/shell/fixtures.ts';
import { setup, registration } from '../storage/harness.ts';
import { harness, pubkey, second } from './native-vault-harness.ts';

test('public entry accepts canonical npub and hex, never decodes secret identifiers', () => {
  assert.equal(parsePublicIdentity(formatNpub(second)), second);
  assert.equal(parsePublicIdentity(formatNpub(second).toUpperCase()), second);
  assert.throws(() => parsePublicIdentity('N' + formatNpub(second).slice(1)));
  assert.equal(parsePublicIdentity(`  ${second.toUpperCase()}  `), second);
  for (const value of ['nsec1' + 'q'.repeat(58), 'nprofile1invalid', 'npub1invalid', 'a'.repeat(63), '']) {
    assert.throws(() => parsePublicIdentity(value));
  }
});

test('native public account commit preserves all saved account metadata and validates readback', async () => {
  const { vault, module, calls } = harness(); const before = await vault.open();
  const selected = await vault.addPublicIdentity(second);
  assert.equal(selected.selectedPubkey, second);
  assert.deepEqual(selected.identities[0], before.identities[0]);
  assert.equal(selected.identities[1].origin, 'public');
  assert.equal(calls.filter(value => value === 'public').length, 1);
  await assert.rejects(vault.addPublicIdentity(second), { code: 'AUTHORIZATION_DENIED' });
  assert.equal(calls.filter(value => value === 'public').length, 1);
  const reopened = await vault.open(); assert.deepEqual(reopened, selected);
  await vault.select(pubkey);
  module.addNativePublicIdentityAsync = async () => JSON.stringify({ ...vault.getSnapshot(), selectedPubkey: second });
  const other = 'a'.repeat(64);
  await assert.rejects(vault.addPublicIdentity(other), { code: 'CORRUPT_METADATA' });
  assert.throws(() => vault.getSnapshot(), { code: 'NOT_READY' });
});

test('public account transition revokes old authority, isolates storage and restores the saved identity', async t => {
  const { vault } = harness(); await vault.open();
  const { database } = await setup(t);
  const transition = await IdentityTransition.open({ vault, database, seed: initialTestWorkspace, assertAvailable: assertBundledWorkspace });
  const old = transition.sessionAuthority();
  const original = database.bindStorage(registration({ user: old.user, assertActive: old.assertActive }));
  await original.port.set('retained', 'original identity data');
  const pending = transition.preparePublicIdentity(second);
  assert.equal(vault.getSnapshot().selectedPubkey, pubkey);
  transition.cancel(pending);
  assert.equal(vault.getSnapshot().selectedPubkey, pubkey); old.assertActive();
  await transition.confirm(transition.preparePublicIdentity(second));
  assert.equal(transition.sessionAuthority().user, second);
  assert.throws(old.assertActive, { code: 'STALE' });
  await assert.rejects(original.port.get('retained'), { code: 'REVOKED' });
  const publicAuthority = transition.sessionAuthority();
  assert.equal(await database.bindStorage(registration({ user: publicAuthority.user, assertActive: publicAuthority.assertActive })).port.get('retained'), null);
  const back = transition.prepareSelect(pubkey); assert(back); await transition.confirm(back);
  assert.throws(publicAuthority.assertActive, { code: 'STALE' });
  const restored = transition.sessionAuthority();
  assert.equal(await database.bindStorage(registration({ user: restored.user, assertActive: restored.assertActive })).port.get('retained'), 'original identity data');
  assert.equal(vault.getSnapshot().identities.length, 2);
});
