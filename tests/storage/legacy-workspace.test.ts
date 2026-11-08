import assert from 'node:assert/strict';
import test from 'node:test';
import {decodeSnapshot, encodeSnapshot, snapshot} from '../../src/storage/codec.ts';
import {openShellDatabase} from '../../src/storage/database.ts';
import {openWorkspaceController} from '../../src/storage/workspace-controller.ts';
import {emptyWorkspace, openNapplet, snapshotWorkspace, type NappletDescriptor} from '../../src/shell/workspace.ts';
import {isLegacyReadOnlySelection} from '../../src/napplets/legacy-read-only.ts';
import {assertCode, hex, registration, setup} from './harness.ts';
import {IdentityTransition} from '../../src/security/identity-transition.ts';
import {harness, pubkey, second} from '../security/native-vault-harness.ts';

const user = hex(1), otherUser = hex(7);
const ordinary: NappletDescriptor = {id: 'recipe-pin', title: 'Recipe Cards', source: 'published',
  publisher: 'c2f1ab4e6a577dd8980b57e15986ed92830b95a94f374192235563532b5cac20', appId: 'recipe-cards',
  eventId: 'b70911af4382baded327ce6af4b595197ff7a4781e3704b9f066a74f68b48a07',
  version: '92d5639e1da2a0b9ac6bbb9d41d67b0026c15ed614e2d553f8ad2e4e4e896ecc'};
const selected: NappletDescriptor = {...ordinary, legacyReadOnly: true, legacyReadOnlyUser: user};
const saved = (pin: NappletDescriptor = selected) => snapshotWorkspace(openNapplet(emptyWorkspace(), pin));

test('real workspace controller saves and cold-loads exact account-bound legacy consent', async t => {
  const {sqlite, database} = await setup(t), owner = registration({user});
  const controller = await openWorkspaceController(database.bindWorkspace(owner), () => openNapplet(emptyWorkspace(), ordinary), () => {});
  controller.change(openNapplet(emptyWorkspace(), selected)); await controller.flush();
  assert.equal(controller.getSnapshot().error, null);
  assert.deepEqual((await database.bindWorkspace(owner).port.load())?.snapshot, saved());
  await database.close();
  const reopened = await openShellDatabase(sqlite, 'ios');
  const restored = await openWorkspaceController(reopened.bindWorkspace(owner), () => {throw Error('must not reseed');}, () => {});
  assert.deepEqual(restored.getSnapshot().workspace.sessions, [selected]);
  assert.equal(sqlite.raw().prepare('PRAGMA user_version').get()!['user_version'], 4);
  restored.change(openNapplet(emptyWorkspace(), ordinary)); await restored.flush();
  assert.equal(restored.getSnapshot().error, null);
  assert.deepEqual((await reopened.bindWorkspace(owner).port.load())?.snapshot, saved(ordinary));
  const previousFormat = {id: ordinary.id, title: ordinary.title, publisher: ordinary.publisher, appId: ordinary.appId,
    version: ordinary.version, source: ordinary.source, eventId: ordinary.eventId};
  assert.equal(encodeSnapshot(saved(ordinary)), JSON.stringify({schema: 1, sessions: [previousFormat], lastActiveId: ordinary.id}));
});

test('strict durable codec rejects unbound, malformed, bundled and changed-pin legacy consent', () => {
  const invalid: unknown[] = [
    {...selected, legacyReadOnly: false}, {...ordinary, legacyReadOnly: true}, {...ordinary, legacyReadOnlyUser: user},
    {...selected, legacyReadOnlyUser: undefined}, {...selected, legacyReadOnlyUser: ''}, {...selected, legacyReadOnlyUser: 'AB'.repeat(32)},
    {...selected, eventId: hex(8)}, {...selected, version: hex(8)}, {...selected, publisher: hex(8)}, {...selected, appId: 'other'},
    {...selected, source: 'bundled'}, {...selected, extra: 'forbidden'},
  ];
  let called = false;
  invalid.push({...ordinary, get legacyReadOnly() {called = true; return true;}, legacyReadOnlyUser: user});
  invalid.push({...ordinary, legacyReadOnly: true, get legacyReadOnlyUser() {called = true; return user;}});
  for (const pin of invalid) {
    const payload = {schema: 1, sessions: [pin], lastActiveId: ordinary.id};
    assert.throws(() => snapshot(payload), assertCode('INVALID_INPUT'));
  }
  assert.equal(called, false);
  assert.throws(() => decodeSnapshot(JSON.stringify({schema: 1, sessions: [{...selected, eventId: hex(8)}], lastActiveId: ordinary.id})), assertCode('CORRUPT_STORAGE'));
});

test('malformed persisted consent is retained as corruption without replacement', async t => {
  const {database, sqlite} = await setup(t), port = database.bindWorkspace(registration({user})).port;
  await port.save(saved(), null);
  const corrupt = JSON.stringify({...saved(), sessions: [{...selected, legacyReadOnlyUser: 'invalid'}]});
  sqlite.raw().prepare('UPDATE workspaces SET payload = ? WHERE user = ?').run(corrupt, user);
  await assert.rejects(port.load(), assertCode('CORRUPT_STORAGE'));
  assert.equal(sqlite.raw().prepare('SELECT payload FROM workspaces WHERE user = ?').get(user)!['payload'], corrupt);
});

test('accepted publication revision clears legacy consent while preserving unrelated pins', async t => {
  const {database} = await setup(t);
  const owner = registration({user, publisher: ordinary.publisher, appId: ordinary.appId, version: ordinary.version});
  const control = database.bindApp(owner).port;
  await control.selectInitialVersion(ordinary.version);
  const unrelated = {...ordinary, id: 'unrelated', publisher: hex(2), appId: 'unrelated', eventId: hex(3), version: hex(4)};
  const port = database.bindWorkspace(owner).port;
  await port.save({...saved(), sessions: [selected, unrelated]}, null);
  const update = {fromVersion: ordinary.version, targetVersion: hex(8), targetEventId: hex(9), receiptId: 'legacy-pin-update', assertFrozen() {}};
  const receipt = await control.acceptUpdate(update);
  assert.equal(receipt.workspaceRevision, 1);
  const updated = (await port.load())!.snapshot;
  assert.deepEqual(updated.sessions[0], {...ordinary, version: update.targetVersion, eventId: update.targetEventId});
  assert.equal(Object.hasOwn(updated.sessions[0]!, 'legacyReadOnly'), false);
  assert.equal(Object.hasOwn(updated.sessions[0]!, 'legacyReadOnlyUser'), false);
  assert.deepEqual(updated.sessions[1], unrelated);
  assert.deepEqual(await control.acceptUpdate(update), receipt);
});

test('copying durable descriptors to another account cannot transfer their legacy selection', async t => {
  const {database} = await setup(t), original = database.bindWorkspace(registration({user})).port;
  const destination = database.bindWorkspace(registration({user: otherUser})).port;
  await original.save(saved(), null);
  assert.equal(await destination.load(), null);
  await destination.save((await original.load())!.snapshot, null);
  const carried = (await destination.load())!.snapshot.sessions[0]!;
  assert.equal(carried.legacyReadOnlyUser, user);
  assert.equal(isLegacyReadOnlySelection(carried, otherUser), false);
  assert.equal(isLegacyReadOnlySelection((await original.load())!.snapshot.sessions[0]!, user), true);
});

test('whole-shell public-account switch carries the pin without transferring its persisted consent', async t => {
  const {database} = await setup(t), {vault} = harness(); await vault.open();
  const accepted = {...selected, legacyReadOnlyUser: pubkey};
  const transition = await IdentityTransition.open({vault, database,
    seed: () => openNapplet(emptyWorkspace(), accepted), assertAvailable() {}});
  const oldAuthority = transition.sessionAuthority();
  await transition.confirm(transition.preparePublicIdentity(second));
  const destination = transition.getSnapshot().session;
  assert.equal(destination.workspace.getSnapshot().error, null);
  assert.equal(destination.vault.selectedPubkey, second);
  const carried = (await database.bindWorkspace(registration({user: second})).port.load())!.snapshot.sessions[0]!;
  assert.equal(carried.legacyReadOnlyUser, pubkey);
  assert.equal(isLegacyReadOnlySelection(carried, second), false);
  assert.throws(oldAuthority.assertActive, {code: 'STALE'});
  const back = transition.prepareSelect(pubkey); assert(back); await transition.confirm(back);
  const restored = (await database.bindWorkspace(registration({user: pubkey})).port.load())!.snapshot.sessions[0]!;
  assert.equal(isLegacyReadOnlySelection(restored, pubkey), true);
});
