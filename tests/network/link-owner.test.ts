import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bindLinkOwner} from '../../src/links/link-owner.ts';
import {IdentityTransition} from '../../src/security/identity-transition.ts';
import {Integrated, pubkey} from '../security/harness.ts';
import {setup} from '../storage/harness.ts';
import {initialTestWorkspace, assertBundledWorkspace} from '../../src/shell/fixtures.ts';

test('actual identity transition synchronizes native denial before vault mutation and publishes the new epoch', async t => {
  const protectedStore = new Integrated(); t.after(() => protectedStore.sqlite.cleanup());
  const native = await protectedStore.owner(); await native.vault.open();
  const storage = await setup(t), calls: {user: string; epoch: number; available: boolean}[] = [];
  const transition = await IdentityTransition.open({vault: native.vault, database: storage.database, seed: initialTestWorkspace,
    assertAvailable: assertBundledWorkspace});
  const release = bindLinkOwner(transition, {synchronizeLinkOwner(user, epoch, available) {
    if (!available) assert.equal(native.vault.getSnapshot().selectedPubkey, pubkey(1));
    calls.push({user, epoch, available});
  }});
  const change = await transition.prepareImport(); assert(change);
  assert.deepEqual(calls.at(-1), {user: pubkey(1), epoch: 0, available: false});
  await transition.confirm(change);
  assert.deepEqual(calls.at(-1), {user: pubkey(2), epoch: 1, available: true});
  const count = calls.length; release(); transition.prepareSelect(pubkey(1)); assert.equal(calls.length, count);
});
