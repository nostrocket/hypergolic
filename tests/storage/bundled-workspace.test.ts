import test from 'node:test';
import assert from 'node:assert/strict';
import { isDiscoveryEntry } from '../../src/napplets/discovery-entry.ts';
import { assertBundledWorkspace, assertWorkspaceAvailability, bundledDescriptor, resolveBundledSession, initialTestWorkspace } from '../../src/shell/fixtures.ts';
import { emptyWorkspace, openNapplet, snapshotWorkspace, type NappletDescriptor } from '../../src/shell/workspace.ts';
import { openWorkspaceController } from '../../src/storage/workspace-controller.ts';
import { registration, setup } from './harness.ts';

test('bundled admission accepts the exact shipped fixture and explicit empty workspace', () => {
  assert.doesNotThrow(() => assertBundledWorkspace(initialTestWorkspace()));
  assert.doesNotThrow(() => assertBundledWorkspace(emptyWorkspace()));
});
test('stored descriptor cannot substitute its source, publisher, content version or identity', () => {
  const state = initialTestWorkspace();
  for (const patch of [{source:'published' as const}, {publisher:'ff'.repeat(32)}, {version:'ff'.repeat(32)}, {appId:'other'}, {id:'ux-lab-0'}, {id:'ux-lab-9007199254740992'}, {title:'Other name'}]) {
    assert.throws(() => assertBundledWorkspace({...state,sessions:[{...state.sessions[0]!,...patch}]}), /Unavailable saved napplet/);
  }
});

test('source-aware availability accepts a strict published pin without resolving it as bundled', () => {
  const published: NappletDescriptor = { id: '58274370-ec8f-4058-a4cc-b63e7e75ca4b',
    title: 'Test Napplet', publisher: 'a'.repeat(64), appId: 'test-napplet', version: 'b'.repeat(64),
    source: 'published', eventId: 'c'.repeat(64) };
  assert.doesNotThrow(() => assertWorkspaceAvailability({ ...emptyWorkspace(), sessions: [published] }));
  assert.throws(() => assertBundledWorkspace({ ...emptyWorkspace(), sessions: [published] }), /Unavailable saved napplet/);
});

test('published workspace descriptors reject changed pins, identity fields and unbounded metadata', () => {
  const published: NappletDescriptor = { id: '58274370-ec8f-4058-a4cc-b63e7e75ca4b',
    title: 'Test Napplet', publisher: 'a'.repeat(64), appId: 'test-napplet', version: 'b'.repeat(64),
    source: 'published', eventId: 'c'.repeat(64) };
  for (const patch of [
    { id: '58274370-ec8f-4058-04cc-b63e7e75ca4b' },
    { id: '58274370-ec8f-1058-a4cc-b63e7e75ca4b' },
    { publisher: 'A'.repeat(64) }, { publisher: 'a'.repeat(63) },
    { version: 'v'.repeat(64) }, { version: 'b'.repeat(63) },
    { eventId: 'C'.repeat(64) }, { eventId: undefined },
    { appId: '' }, { appId: ' test-napplet' }, { appId: `bad\u0000id` }, { appId: 'a'.repeat(256) },
    { title: '' }, { title: 'n'.repeat(129) }, { title: '💫'.repeat(33) },
  ]) assert.throws(() => assertWorkspaceAvailability({ ...emptyWorkspace(), sessions: [{ ...published, ...patch }] }), /Unavailable saved napplet/);
});

test('the exact prior Support descriptor survives upgrade without reseeding or changing other sessions', async t => {
  const {database} = await setup(t);
  const current = bundledDescriptor('nap-support', 4, '58274370-ec8f-4058-a4cc-b63e7e75ca4b');
  const previous = {...current, version: 'd580bdedb19857d66a4b5f2928016c3f756960f42e56f7d98f8fb98df90f1653'};
  const original = openNapplet(initialTestWorkspace(), previous);
  const binding = database.bindWorkspace(registration());
  await binding.port.save(snapshotWorkspace(original), null);
  const controller = await openWorkspaceController(binding, () => {throw Error('do not replace retained workspace');}, assertWorkspaceAvailability);
  assert.deepEqual(controller.getSnapshot().workspace, original);
  assert.deepEqual(resolveBundledSession(previous), resolveBundledSession(current));
  assert.deepEqual(resolveBundledSession(previous).domains, ['link', 'theme']);
  assert.deepEqual((await binding.port.load())?.snapshot, snapshotWorkspace(original));
  for (const patch of [{version:'a'.repeat(64)}, {publisher:'bundled-unsigned-peer'}, {appId:'state-lab'},
    {source:'published' as const}, {eventId:'b'.repeat(64)}, {title:'Other 4'}]) {
    assert.throws(() => resolveBundledSession({...previous,...patch}), /Unavailable saved napplet/);
  }
  const other = {...bundledDescriptor('state-lab', 4), version: previous.version};
  assert.throws(() => resolveBundledSession(other), /Unavailable saved napplet/);
});

for (const version of [
  '1360132bc9b4ea9a29ce5d4783ce04b862d776fbc214d2083186fb228267d7ed',
  '6eb956ead5bc710d70c3511715bf1dab281314d4979ff4bd99d9d1785176655c',
  'ec8f1cb8dddca04865f59105f86e6b9741e4e2d6c1f3cab586bcaf48645fae0a',
  '54f25dd032cb8916b526f0a55888fdfd0fc9e685d622a112cd760424dc32c6ce',
]) test(`the bundled Discover card at ${version.slice(0, 8)} restores under the current packaged authority`, async t => {
  const {database} = await setup(t);
  const instance = '58274370-ec8f-4058-a4cc-b63e7e75ca4b';
  const previous: NappletDescriptor = {id: 'napplet-discovery-' + instance, title: 'Discover',
    appId: 'napplet-discovery', publisher: 'bundled-unsigned-fixture', source: 'bundled', version};
  const current = bundledDescriptor('napplet-discovery', 1, instance);
  assert.notEqual(current.version, previous.version);
  const original = openNapplet(initialTestWorkspace(), previous);
  const binding = database.bindWorkspace(registration());
  await binding.port.save(snapshotWorkspace(original), null);
  const controller = await openWorkspaceController(binding, () => {throw Error('do not replace retained workspace');}, assertWorkspaceAvailability);
  assert.deepEqual(controller.getSnapshot().workspace, original);
  assert.deepEqual((await binding.port.load())?.snapshot, snapshotWorkspace(original));
  assert.equal(isDiscoveryEntry(previous), true);
  assert.deepEqual(resolveBundledSession(previous), resolveBundledSession(current));
  assert.deepEqual(resolveBundledSession(previous).domains, ['relay', 'resource', 'theme']);

  for (const patch of [{version:'a'.repeat(64)}, {publisher:'bundled-unsigned-peer'}, {appId:'state-lab'},
    {source:'published' as const}, {eventId:'b'.repeat(64)}, {title:'Other'}]) {
    assert.throws(() => resolveBundledSession({...previous,...patch}), /Unavailable saved napplet/);
  }
  assert.throws(() => resolveBundledSession({...bundledDescriptor('state-lab', 4),version:previous.version}), /Unavailable saved napplet/);
});
