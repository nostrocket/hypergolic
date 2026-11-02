import test from 'node:test';
import assert from 'node:assert/strict';
import { openWorkspaceController } from '../../src/storage/workspace-controller.ts';
import { openShellDatabase } from '../../src/storage/database.ts';
import { emptyWorkspace, focusNapplet, openNapplet, showOverview, snapshotWorkspace } from '../../src/shell/workspace.ts';
import { assertCode, deferred, registration, setup } from './harness.ts';
import type { NappletDescriptor } from '../../src/shell/workspace.ts';
const descriptor = (id: string): NappletDescriptor => ({id, title:id, publisher:'02'.repeat(32), appId:'test-app', version:'03'.repeat(32), source:'published', eventId:'04'.repeat(32)});
const seed = () => openNapplet(openNapplet(emptyWorkspace(), descriptor('one')), descriptor('two'));
const accept = () => undefined;

test('controller persists its seed once and restores explicit empty without reseeding', async t => {
  const { sqlite, database } = await setup(t);
  const owner = registration();
  const first = await openWorkspaceController(database.bindWorkspace(owner), seed, accept);
  assert.equal(first.getSnapshot().workspace.focusedId, 'two');
  assert.equal(first.getSnapshot().saving, false);
  first.change(emptyWorkspace()); await first.flush(); await database.close();
  const nextDatabase = await openShellDatabase(sqlite, 'android');
  const second = await openWorkspaceController(nextDatabase.bindWorkspace(owner), () => { throw Error('must not reseed'); }, accept);
  assert.deepEqual(second.getSnapshot().workspace, emptyWorkspace());
});

test('controller keeps stable immutable snapshots and live overview while serializing only durable descriptors', async t => {
  const { database } = await setup(t);
  const binding = database.bindWorkspace(registration());
  const controller = await openWorkspaceController(binding, seed, accept);
  assert.equal(controller.getSnapshot(), controller.getSnapshot());
  let notices = 0; const unsubscribe = controller.subscribe(() => { notices++; });
  const next = showOverview(controller.getSnapshot().workspace);
  controller.change(next); await controller.flush();
  assert.equal(controller.getSnapshot().workspace.overview, true);
  assert(Object.isFrozen(controller.getSnapshot().workspace.sessions));
  assert.equal((await binding.port.load())!.snapshot.lastActiveId, 'two');
  assert(notices > 0); unsubscribe(); const count = notices;
  controller.change(focusNapplet(next, 'one')); await controller.flush(); assert.equal(notices, count);
});

test('rapid changes retain only the newest pending save without stale revision overwrite', async t => {
  const { database, sqlite } = await setup(t);
  const binding = database.bindWorkspace(registration());
  const controller = await openWorkspaceController(binding, seed, accept);
  const entered = deferred(), release = deferred(); let held = false;
  sqlite.onStep = async sql => { if (sql === 'BEGIN IMMEDIATE' && !held) { held = true; entered.resolve(); await release.promise; } };
  controller.change(focusNapplet(seed(), 'one')); await entered.promise;
  for (let index = 0; index < 200; index++) controller.change(focusNapplet(seed(), index % 2 ? 'two' : 'one'));
  controller.change(emptyWorkspace());
  assert.equal(controller.getSnapshot().saving, true);
  assert.deepEqual(controller.getSnapshot().workspace, emptyWorkspace());
  release.resolve(); await controller.flush();
  assert.equal(controller.getSnapshot().saving, false); assert.equal(controller.getSnapshot().error, null);
  const saved = (await binding.port.load())!;
  assert.equal(saved.revision, 2); assert.deepEqual(saved.snapshot, snapshotWorkspace(emptyWorkspace()));
});

test('failed save stops later writes and retains the current live workspace for recovery', async t => {
  const { database, sqlite } = await setup(t);
  const controller = await openWorkspaceController(database.bindWorkspace(registration()), seed, accept);
  sqlite.faults.push({ prefix: 'UPDATE workspaces', mode: 'before' });
  const next = focusNapplet(seed(), 'one');
  controller.change(next); await controller.flush();
  assert.equal(controller.getSnapshot().error, 'STORAGE_FAILURE');
  assert.deepEqual(controller.getSnapshot().workspace, next);
  const calls = sqlite.calls.length;
  controller.change(emptyWorkspace()); await controller.flush();
  assert.equal(sqlite.calls.length, calls);
  assert.equal((await database.bindWorkspace(registration()).port.load())!.snapshot.lastActiveId, 'two');
});

test('lost commit acknowledgement remains indeterminate and restart reads committed state without reseeding', async t => {
  const { database, sqlite } = await setup(t);
  const controller = await openWorkspaceController(database.bindWorkspace(registration()), seed, accept);
  sqlite.faults.push({ prefix: 'COMMIT', mode: 'after' });
  controller.change(emptyWorkspace()); await controller.flush();
  assert.equal(controller.getSnapshot().error, 'STORAGE_INDETERMINATE'); await database.close();
  const reopened = await openShellDatabase(sqlite, 'ios');
  const actual = await openWorkspaceController(reopened.bindWorkspace(registration()), () => { throw Error('no replacement'); }, accept);
  assert.deepEqual(actual.getSnapshot().workspace, emptyWorkspace());
});

test('revocation while a write awaits prevents completion and all queued writes', async t => {
  const { database, sqlite } = await setup(t);
  const controller = await openWorkspaceController(database.bindWorkspace(registration()), seed, accept);
  const entered = deferred(), release = deferred(); let held = false;
  sqlite.onStep = async sql => { if (sql === 'BEGIN IMMEDIATE' && !held) { held = true; entered.resolve(); await release.promise; } };
  controller.change(focusNapplet(seed(), 'one')); await entered.promise;
  controller.change(emptyWorkspace()); controller.revoke(); release.resolve(); await controller.flush();
  assert.equal(controller.getSnapshot().error, 'REVOKED');
  assert.equal((await database.bindWorkspace(registration()).port.load())!.snapshot.lastActiveId, 'two');
});

test('unavailable restored napplets fail before replacement or a write', async t => {
  const { database, sqlite } = await setup(t);
  const binding = database.bindWorkspace(registration()); await binding.port.save(snapshotWorkspace(seed()), null);
  const before = sqlite.calls.filter(call => call.sql.startsWith('UPDATE workspaces')).length;
  await assert.rejects(openWorkspaceController(binding, () => { throw Error('must not seed'); }, () => { throw Error('unverified'); }), assertCode('STORAGE_FAILURE'));
  assert.equal(sqlite.calls.filter(call => call.sql.startsWith('UPDATE workspaces')).length, before);
});
