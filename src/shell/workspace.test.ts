import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adjacentNapplet, closeNapplet, emptyWorkspace, focusNapplet, openNapplet, replacePublishedNapplet, restoreWorkspace, showOverview, snapshotWorkspace } from './workspace.ts';
import type { NappletDescriptor } from './workspace.ts';
const descriptor = (id: string): NappletDescriptor => ({ id, title: id, publisher: 'bundled', appId: 'ux-lab', version: 'hash', source: 'bundled' });
const three = () => ['a', 'b', 'c'].reduce((state, id) => openNapplet(state, descriptor(id)), emptyWorkspace());

test('focusing and reopening a session preserve opening order and descriptor identity', () => {
  const initial = three();
  const state = openNapplet(focusNapplet(initial, 'a'), descriptor('b'));
  assert.deepEqual(state.sessions.map(item => item.id), ['a', 'b', 'c']);
  assert.strictEqual(state.sessions[1], initial.sessions[1]);
  assert.equal(state.focusedId, 'b');
});
test('navigation stops at each end and invalid focus cannot change workspace', () => {
  const state = three();
  assert.equal(adjacentNapplet(state, 1), null);
  assert.equal(adjacentNapplet(state, -1), 'b');
  assert.equal(adjacentNapplet(focusNapplet(state, 'a'), -1), null);
  assert.strictEqual(focusNapplet(state, 'missing'), state);
});
test('closing active or inactive sessions leaves overview without selecting another', () => {
  const active = closeNapplet(three(), 'c');
  assert.equal(active.focusedId, null); assert.equal(active.overview, true);
  const inactive = closeNapplet(three(), 'a');
  assert.equal(inactive.focusedId, 'c'); assert.equal(inactive.overview, true);
});
test('accepted published revision replaces its card and native session without changing publisher storage identity', () => {
  const old: NappletDescriptor = { id: 'old', title: 'Napplet', publisher: 'a'.repeat(64), appId: 'example',
    version: 'b'.repeat(64), eventId: 'c'.repeat(64), source: 'published' };
  const next: NappletDescriptor = { ...old, id: 'new', version: 'd'.repeat(64), eventId: 'e'.repeat(64) };
  const original = openNapplet(openNapplet(openNapplet(emptyWorkspace(), descriptor('a')), old), descriptor('b'));
  const updated = replacePublishedNapplet(original, old.id, next);
  assert.deepEqual(updated.sessions.map(item => item.id), ['a', 'new', 'b']);
  assert.equal(updated.focusedId, 'new');
  assert.equal(updated.overview, false);
  assert.throws(() => replacePublishedNapplet(original, old.id, { ...next, publisher: 'f'.repeat(64) }));
  assert.throws(() => replacePublishedNapplet(original, old.id, { ...next, eventId: old.eventId }));
});
test('snapshot preserves opening order and last active but never ephemeral properties', () => {
  const state = showOverview(focusNapplet(three(), 'b'));
  const snapshot = snapshotWorkspace(state);
  assert.deepEqual(Object.keys(snapshot), ['schema', 'sessions', 'lastActiveId']);
  const serialized = JSON.stringify(snapshot);
  const restored = restoreWorkspace(JSON.parse(serialized));
  assert.equal(restored.focusedId, 'b'); assert.equal(restored.overview, false);
  assert.deepEqual(restored.sessions.map(item => item.id), ['a', 'b', 'c']);
});
test('explicitly empty workspace survives restart', () => {
  let state = three();
  for (const id of ['a', 'b', 'c']) state = closeNapplet(state, id);
  assert.deepEqual(restoreWorkspace(snapshotWorkspace(state)), emptyWorkspace());
});
test('corrupt saved state fails instead of silently choosing or generating a session', () => {
  for (const value of [null, [], {}, { schema: 2, sessions: [], lastActiveId: null }, { schema: 1, sessions: [], lastActiveId: 'missing' },
    { schema: 1, sessions: [descriptor('a'), descriptor('a')], lastActiveId: 'a' },
    { schema: 1, sessions: [{ ...descriptor('a'), id: '../../arbitrary' }], lastActiveId: null },
    { schema: 1, sessions: [{ ...descriptor('a'), source: 'published' }], lastActiveId: 'a' },
    { schema: 1, sessions: [{ ...descriptor('a'), source: 'published', eventId: 'bad-pin' }], lastActiveId: 'a' }]) {
    assert.throws(() => restoreWorkspace(value));
  }
});


test('bundled routing peer has a distinct native session identity despite its shared HTML', async () => {
  const {bundledDescriptor, resolveBundledSession} = await import('./fixtures.ts');
  const peer = bundledDescriptor('routing-lab-peer', 1, '12345678-1234-4123-8123-123456789abc');
  const caller = bundledDescriptor('routing-lab', 2, '12345678-1234-4123-8123-123456789abd');
  const bound = resolveBundledSession(peer);
  assert.equal(bound.fixture, 'routing-lab-peer');
  assert.equal(bound.appId, 'routing-lab-peer');
  assert.notEqual(bound.appId, resolveBundledSession(caller).appId);
  assert.equal(bound.instanceId, peer.id);
  assert.equal(peer.version, caller.version);
  assert.throws(() => resolveBundledSession({...peer, appId: caller.appId}));
});

for (const archive of ['approval-lab-v1', 'approval-lab-v2', 'approval-lab-v3'] as const) test(`saved Approval Lab ${archive} restores its exact artifact without changing new openings`, async () => {
  const {bundledDescriptor, resolveBundledSession, assertWorkspaceAvailability} = await import('./fixtures.ts');
  const {BUNDLED_FIXTURES} = await import('../runtime/bundled-catalog.ts');
  const latest = bundledDescriptor('approval-lab', 8, '12345678-1234-4123-8123-123456789abc');
  const saved = {...latest, version: BUNDLED_FIXTURES[archive].aggregateHash};
  const restored = resolveBundledSession(saved);
  assert.equal(restored.fixture, archive);
  assert.equal(restored.appId, latest.appId);
  assert.equal(restored.instanceId, saved.id);
  assert.equal(restored.version, saved.version);
  assert.deepEqual(restored.domains, ['identity', 'relay', 'theme']);
  assert.equal(resolveBundledSession(latest).fixture, 'approval-lab');
  assert.equal(resolveBundledSession(latest).version, latest.version);
  assert.notEqual(restored.version, latest.version);
  assertWorkspaceAvailability(openNapplet(openNapplet(emptyWorkspace(), saved), {...latest, id: 'approval-lab-9', title: 'Approval Lab 9'}));
  for (const mutation of [
    {version: '0'.repeat(64)}, {version: BUNDLED_FIXTURES[archive].sha256},
    {publisher: 'bundled-unsigned-peer'}, {appId: 'approval-lab-v1'}, {source: 'published' as const},
    {eventId: '0'.repeat(64)}, {title: 'Other Lab 8'}, {id: 'approval-lab-v1-8'},
  ]) assert.throws(() => resolveBundledSession({...saved, ...mutation}));
});

for (const archive of ['feed-lab-v1'] as const) test(`saved Feed Lab ${archive} restores its exact artifact without changing new openings`, async () => {
  const {bundledDescriptor, resolveBundledSession, assertWorkspaceAvailability} = await import('./fixtures.ts');
  const {BUNDLED_FIXTURES} = await import('../runtime/bundled-catalog.ts');
  const latest = bundledDescriptor('feed-lab', 8, '12345678-1234-4123-8123-123456789abc');
  const saved = {...latest, version: BUNDLED_FIXTURES[archive].aggregateHash};
  const restored = resolveBundledSession(saved);
  assert.equal(restored.fixture, archive);
  assert.equal(restored.appId, latest.appId);
  assert.equal(restored.instanceId, saved.id);
  assert.equal(restored.version, saved.version);
  assert.deepEqual(restored.domains, ['identity', 'outbox', 'relay', 'theme']);
  assert.equal(resolveBundledSession(latest).fixture, 'feed-lab');
  assert.equal(resolveBundledSession(latest).version, latest.version);
  assert.notEqual(restored.version, latest.version);
  assertWorkspaceAvailability(openNapplet(openNapplet(emptyWorkspace(), saved), {...latest, id: 'feed-lab-9', title: 'Feed Lab 9'}));
  for (const mutation of [
    {version: '0'.repeat(64)}, {version: BUNDLED_FIXTURES[archive].sha256},
    {publisher: 'bundled-unsigned-peer'}, {appId: 'feed-lab-v1'}, {source: 'published' as const},
    {eventId: '0'.repeat(64)}, {title: 'Other Lab 8'}, {id: 'feed-lab-v1-8'},
  ]) assert.throws(() => resolveBundledSession({...saved, ...mutation}));
});
