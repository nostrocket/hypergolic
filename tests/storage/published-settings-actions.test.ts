import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {publishedSettingsActions} from '../../src/shell/published-settings-actions.ts';
import {emptyWorkspace, openNapplet, type NappletDescriptor} from '../../src/shell/workspace.ts';
import {openWorkspaceController} from '../../src/storage/workspace-controller.ts';
import {deferred, registration, setup} from './harness.ts';

const previous: NappletDescriptor = {id: 'first', title: 'First', publisher: 'a'.repeat(64), appId: 'game',
  source: 'published', eventId: 'b'.repeat(64), version: 'c'.repeat(64)};
const next: NappletDescriptor = {...previous, id: 'next', eventId: 'd'.repeat(64), version: 'e'.repeat(64)};
const approve = async () => true;

async function fixture(t: TestContext, updating = false) {
  const {database} = await setup(t);
  const controller = await openWorkspaceController(database.bindWorkspace(registration()),
    () => updating ? openNapplet(emptyWorkspace(), previous) : emptyWorkspace(), () => {});
  const staged = deferred();
  const discarded: string[] = [];
  const navigation: string[] = [];
  const prepare = async () => { await staged.promise; return next; };
  const actions = publishedSettingsActions({
    runtime: {openPublishedLink: prepare, preparePublishedUpdate: prepare,
      discardPublished: id => { discarded.push(id); }},
    blocked: false, getWorkspace: () => controller.getSnapshot().workspace,
    change: controller.change, position: {set: () => navigation.push('position')},
    progress: {set: () => navigation.push('progress')},
    setSettings: () => navigation.push('settings'),
  });
  return {actions, controller, discarded, navigation, staged};
}

test('Settings releases a stage when the workspace freezes during preparation', async t => {
  const {actions, controller, discarded, navigation, staged} = await fixture(t);
  const opening = actions.openPublished('link', new AbortController().signal, approve);
  controller.freeze();
  staged.resolve();
  await assert.rejects(opening, /could not be added/);
  assert.deepEqual(controller.getSnapshot().workspace.sessions, []);
  assert.deepEqual(discarded, [next.id]);
  assert.deepEqual(navigation, []);
});

test('Settings releases a stage if cancelled before workspace handoff', async t => {
  const {actions, controller, discarded, navigation, staged} = await fixture(t);
  const cancel = new AbortController();
  const opening = actions.openPublished('link', cancel.signal, approve);
  cancel.abort();
  staged.resolve();
  await assert.rejects(opening, /cancelled/);
  assert.deepEqual(controller.getSnapshot().workspace.sessions, []);
  assert.deepEqual(discarded, [next.id]);
  assert.deepEqual(navigation, []);
});

test('a refused update releases only the new stage and keeps the previous pin', async t => {
  const {actions, controller, discarded, navigation, staged} = await fixture(t, true);
  const updating = actions.checkPublishedUpdate(previous, new AbortController().signal, approve, approve);
  controller.freeze();
  staged.resolve();
  await assert.rejects(updating, /could not be added/);
  assert.deepEqual(controller.getSnapshot().workspace.sessions, [previous]);
  assert.deepEqual(discarded, [next.id]);
  assert.deepEqual(navigation, []);
});

test('an accepted update transfers the stage and releases the previous runtime', async t => {
  const {actions, controller, discarded, navigation, staged} = await fixture(t, true);
  staged.resolve();
  assert.equal(await actions.checkPublishedUpdate(previous, new AbortController().signal, approve, approve), true);
  assert.deepEqual(controller.getSnapshot().workspace.sessions, [next]);
  assert.deepEqual(discarded, [previous.id]);
  assert.deepEqual(navigation, ['position', 'progress', 'settings']);
  await controller.flush();
});
