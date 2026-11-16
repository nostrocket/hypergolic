import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyWorkspace, openNapplet, closeNapplet, restoreWorkspace, snapshotWorkspace, replacePublishedNapplet } from './workspace.ts';
import { pinNapplet, unpinNapplet, pinnedNapplets, showHome, isPinned, MAX_PINS } from './pins.ts';
import { bundledUXDescriptor } from './fixtures.ts';
import { snapshot } from '../storage/codec.ts';

test('Discover is seeded once, and explicitly unpinning every shortcut survives restart', () => {
  const state = restoreWorkspace({schema: 1, sessions: [], lastActiveId: null});
  assert.equal(pinnedNapplets(state)[0].title, 'Discover');
  const empty = unpinNapplet(state, pinnedNapplets(state)[0]);
  const restored = restoreWorkspace(snapshot(snapshotWorkspace(empty)));
  assert.deepEqual(pinnedNapplets(restored), []);
});
test('pinning, Home navigation, closing and unpinning have separate lifetimes', () => {
  const app = bundledUXDescriptor(1);
  const opened = openNapplet(emptyWorkspace(), app);
  const pinned = pinNapplet(opened, app);
  const home = showHome(pinned);
  assert.strictEqual(home.sessions, opened.sessions);
  assert.equal(home.focusedId, app.id);
  assert.equal(home.overview, true);
  const closed = closeNapplet(home, app.id);
  assert.equal(isPinned(closed, app), true);
  assert.equal(isPinned(restoreWorkspace(snapshot(snapshotWorkspace(closed))), app), true);
  const unpinned = unpinNapplet(pinned, app);
  assert.strictEqual(unpinned.sessions, pinned.sessions);
  assert.equal(unpinned.focusedId, app.id);
});
test('Home survives restart with open sessions and one shortcut per publication', () => {
  const app = bundledUXDescriptor(1);
  const state = showHome(pinNapplet(openNapplet(emptyWorkspace(), app), app));
  assert.strictEqual(pinNapplet(state, {...app, id: 'another-instance'}), state);
  const restored = restoreWorkspace(snapshot(snapshotWorkspace(state)));
  assert.equal(restored.home, true); assert.equal(restored.overview, true);
  assert.equal(restored.sessions.length, 1);
  assert.throws(() => snapshot({...snapshotWorkspace(state), pins: [app, {...app, id: 'other'}]}));
  assert.throws(() => snapshot({...snapshotWorkspace(state), home: 'yes'}));
});
test('accepted updates refresh an existing shortcut without changing pin order', () => {
  const old = {id: 'old', title: 'Example', publisher: 'a'.repeat(64), appId: 'example', version: 'b'.repeat(64), eventId: 'c'.repeat(64), source: 'published' as const};
  const next = {...old, id: 'new', version: 'd'.repeat(64), eventId: 'e'.repeat(64)};
  const state = pinNapplet(openNapplet(emptyWorkspace(), old), old);
  assert.deepEqual(replacePublishedNapplet(state, old.id, next).pins?.[1], next);
  let full = emptyWorkspace();
  for (let index = 1; index < MAX_PINS; index++) full = pinNapplet(full, {...old, id: `pin-${index}`, appId: `app-${index}`});
  assert.throws(() => pinNapplet(full, old));
});
