import assert from 'node:assert/strict';
import test from 'node:test';
import { naddrEncode } from 'nostr-tools/nip19';
import { createDiscoveryController, type DiscoveryControllerPorts } from '../../src/napplets/discovery-controller.ts';
import { discoveryCoordinate, isDiscoveryEntry } from '../../src/napplets/discovery-entry.ts';
import { bundledDescriptor } from '../../src/shell/fixtures.ts';
import { emptyWorkspace, openNapplet, type NappletDescriptor } from '../../src/shell/workspace.ts';

const publisher = 'a'.repeat(64);
const address = naddrEncode({kind: 35129, pubkey: publisher, identifier: 'discovery'});
const bundled = () => bundledDescriptor('napplet-discovery', 1, '11111111-1111-4111-8111-111111111111');
const published = (digit: string): NappletDescriptor => ({id: `${digit.repeat(8)}-1111-4111-8111-111111111111`,
  title: 'Discover', publisher, appId: 'discovery', source: 'published', eventId: digit.repeat(64), version: digit.repeat(64)});
const update = {publisher, appId: 'discovery', previousEventId: '1'.repeat(64), nextEventId: '2'.repeat(64),
  previousVersion: '1'.repeat(64), nextVersion: '2'.repeat(64), domains: ['relay'], optionalDomains: ['upload']};
const access = {user: 'c'.repeat(64), publisher, appId: 'discovery', eventId: '2'.repeat(64),
  domains: ['relay'], unsupportedDomains: [], optionalDomains: ['upload'], unsupportedOptionalDomains: []};

function setup(configured: string | null = null) {
  let workspace = emptyWorkspace();
  let visible = true;
  let updates = 0;
  let failures = 0;
  const discarded: string[] = [];
  const ports: DiscoveryControllerPorts = {address: configured, workspace: () => workspace, visible: () => visible,
    bundled, commit: next => { workspace = next; }, openPublished: async () => published('2'),
    updatePublished: async (_session, _signal, review) => { updates++; assert.equal(await review(update), true); return published('2'); },
    discard: id => { discarded.push(id); }, review: async () => true, unavailable: () => { failures++; }};
  return {ports, state: () => workspace, set: (session: NappletDescriptor) => {workspace = openNapplet(emptyWorkspace(), session);},
    hide: () => { visible = false; }, discarded, updates: () => updates, failures: () => failures};
}

test('packaged entry is single-instance and does not query an unconfigured publication', async () => {
  const env = setup(); const controller = createDiscoveryController(env.ports);
  controller.open(); controller.open(); await controller.refresh();
  assert.equal(env.state().sessions.length, 1); assert.equal(env.state().sessions[0]?.title, 'Discover');
  assert.equal(env.updates(), 0); assert.equal(isDiscoveryEntry(env.state().sessions[0]!), true);
  assert.equal(isDiscoveryEntry({...bundled(), version: '0'.repeat(64)}), false);
  assert.equal(isDiscoveryEntry({...bundled(), title: 'spoof'}), false);
});

test('release configuration pins the exact publisher and d, with no discovery relay hints', () => {
  assert.equal(discoveryCoordinate(address)?.identifier, 'discovery');
  assert.throws(() => discoveryCoordinate('nostr:' + address));
  assert.throws(() => discoveryCoordinate(naddrEncode({kind: 35129, pubkey: publisher, identifier: 'discovery', relays: ['wss://relay.damus.io']})));
  assert.equal(isDiscoveryEntry(published('1'), address), true);
  assert.equal(isDiscoveryEntry({...published('1'), publisher: 'b'.repeat(64)}, address), false);
  assert.equal(isDiscoveryEntry({...published('1'), appId: 'Discovery'}, address), false);
  assert.equal(isDiscoveryEntry(published('1'), null), false);
});

test('configured publication replaces the bundled slot after ordinary admission', async () => {
  const env = setup(address); const controller = createDiscoveryController(env.ports);
  controller.open(); await controller.refresh();
  assert.deepEqual(env.state().sessions, [published('2')]); assert.equal(env.state().focusedId, published('2').id);
  assert.deepEqual(env.discarded, []);
});

test('only the selected configured catalog receives automatic version review', async () => {
  const env = setup(address); env.set(published('1'));
  await createDiscoveryController(env.ports).refresh();
  assert.equal(env.updates(), 1); assert.deepEqual(env.discarded, [published('1').id]);
  const other = setup(address); other.set({...published('1'), publisher: 'b'.repeat(64)});
  await createDiscoveryController(other.ports).refresh(); assert.equal(other.updates(), 0);
});

test('changed access is still sent to the trusted review and denial keeps the old pin', async () => {
  const env = setup(address); env.set(published('1')); let reviews = 0;
  env.ports.review = async request => { reviews++; assert.deepEqual(request.optionalDomains, ['upload']); return false; };
  env.ports.updatePublished = async (_session, _signal, reviewVersion, reviewAccess) => {
    await reviewVersion(update);
    if (!await reviewAccess(access)) throw new Error('Denied');
    return published('2');
  };
  await createDiscoveryController(env.ports).refresh();
  assert.equal(reviews, 1); assert.equal(env.state().sessions[0]?.eventId, '1'.repeat(64)); assert.deepEqual(env.discarded, []);
});

test('double activation shares one pending update and hidden completion is discarded', async () => {
  const env = setup(address); env.set(published('1')); let finish!: (value: NappletDescriptor) => void; let calls = 0;
  env.ports.updatePublished = async () => { calls++; return new Promise(resolve => {finish = resolve;}); };
  const controller = createDiscoveryController(env.ports); const pending = controller.refresh();
  await controller.refresh(); assert.equal(calls, 1); env.hide(); finish(published('2')); await pending;
  assert.equal(env.state().sessions[0]?.eventId, '1'.repeat(64)); assert.deepEqual(env.discarded, [published('2').id]);
});

test('dispose suppresses late publication commit and revokes staged candidate', async () => {
  const env = setup(address); let finish!: (value: NappletDescriptor) => void;
  env.ports.openPublished = async () => new Promise(resolve => {finish = resolve;});
  const controller = createDiscoveryController(env.ports); controller.open(); const pending = controller.refresh();
  controller.dispose(); finish(published('2')); await pending;
  assert.equal(env.state().sessions[0]?.source, 'bundled'); assert.deepEqual(env.discarded, [published('2').id]); assert.equal(env.failures(), 0);
});

test('a publication outside the configured coordinate cannot replace the catalog', async () => {
  const env = setup(address); env.ports.openPublished = async () => ({...published('2'), publisher: 'b'.repeat(64)});
  const controller = createDiscoveryController(env.ports); controller.open(); await controller.refresh();
  assert.equal(env.state().sessions[0]?.source, 'bundled'); assert.deepEqual(env.discarded, [published('2').id]);
});

test('substituted publisher or version never receives automatic catalog update approval', async () => {
  const env = setup(address); env.set(published('1'));
  let reviews = 0;
  env.ports.review = async () => { reviews++; return true; };
  const controller = createDiscoveryController(env.ports);
  for (const changed of [{...update, publisher: 'b'.repeat(64)}, {...update, previousVersion: '3'.repeat(64)}]) {
    env.ports.updatePublished = async (_session, _signal, reviewVersion) => { await reviewVersion(changed); return published('2'); };
    await controller.refresh();
  }
  env.ports.updatePublished = async (_session, _signal, reviewVersion, reviewAccess) => {
    await reviewVersion(update);
    await reviewAccess({...access, eventId: '3'.repeat(64)});
    return published('2');
  };
  await controller.refresh();
  assert.equal(reviews, 0);
  assert.equal(env.state().focusedId, published('1').id);
});

test('a different staged event is discarded after exact version review', async () => {
  const env = setup(address); env.set(published('1'));
  env.ports.updatePublished = async (_session, _signal, reviewVersion) => {
    await reviewVersion(update);
    return published('3');
  };
  await createDiscoveryController(env.ports).refresh();
  assert.equal(env.state().focusedId, published('1').id);
  assert.deepEqual(env.discarded, [published('3').id]);
});

test('a returned stage is revoked after the matching optional access review was denied', async () => {
  const env = setup(address); env.set(published('1'));
  env.ports.review = async () => false;
  env.ports.updatePublished = async (_session, _signal, reviewVersion, reviewAccess) => {
    await reviewVersion(update);
    assert.equal(await reviewAccess(access), false);
    return published('2');
  };
  await createDiscoveryController(env.ports).refresh();
  assert.equal(env.state().focusedId, published('1').id);
  assert.deepEqual(env.discarded, [published('2').id]);
});

test('a refocus can check immediately after cancelling a pending lookup', async () => {
  const env = setup(address); env.set(published('1'));
  let calls = 0;
  let finish!: (value: NappletDescriptor) => void;
  env.ports.updatePublished = async (_session, _signal, reviewVersion) => {
    if (++calls === 1) return new Promise(resolve => {finish = resolve;});
    await reviewVersion(update);
    return published('2');
  };
  const controller = createDiscoveryController(env.ports);
  const pending = controller.refresh();
  controller.cancel();
  await controller.refresh();
  finish(published('3'));
  await pending;
  assert.equal(calls, 2);
  assert.equal(env.state().focusedId, published('2').id);
  assert.deepEqual(env.discarded, [published('1').id, published('3').id]);
});

test('replacement preserves a workspace change made while the prior catalog closes', async () => {
  const env = setup(address); env.set(published('1'));
  const other = {...published('3'), publisher: 'b'.repeat(64)};
  env.ports.beforeClose = () => {
    const state = env.state();
    env.ports.commit({...state, sessions: [...state.sessions, other]});
  };
  await createDiscoveryController(env.ports).refresh();
  assert.deepEqual(env.state().sessions, [published('2'), other]);
});

test('a frozen workspace keeps its previous catalog and revokes the uncommitted stage', async () => {
  const env = setup(address); env.set(published('1'));
  env.ports.commit = () => {};
  await createDiscoveryController(env.ports).refresh();
  assert.equal(env.state().focusedId, published('1').id);
  assert.deepEqual(env.discarded, [published('2').id]);
});

test('an offline lookup keeps the packaged catalog open', async () => {
  const env = setup(address);
  env.ports.openPublished = async () => { throw new Error('Lookup unavailable'); };
  const controller = createDiscoveryController(env.ports);
  controller.open();
  await controller.refresh();
  assert.equal(env.state().focusedId, bundled().id);
  assert.equal(env.failures(), 1);
});
