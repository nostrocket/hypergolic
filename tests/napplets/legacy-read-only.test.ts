import assert from 'node:assert/strict';
import test from 'node:test';
import {naddrEncode} from 'nostr-tools/nip19';
import {captureLegacyReadOnly, LEGACY_READ_ONLY_PROFILE, supportsLegacyReadOnly, isLegacyReadOnlySelection} from '../../src/napplets/legacy-read-only.ts';
import {emptyWorkspace, openNapplet, restoreWorkspace, snapshotWorkspace} from '../../src/shell/workspace.ts';
import {RoutingReviewService, type RoutingReviewRequest} from '../../src/routing/routing-review.ts';
import {bundledDescriptor, resolveBundledSession} from '../../src/shell/fixtures.ts';
import {createPublishedSessionCoordinator, type PublishedSessionDependencies} from '../../src/napplets/published-session.ts';
import {EMBEDDED_TEST_COORDINATE, EMBEDDED_TEST_EVENT, getEmbeddedTestHtmlBytes} from '../../src/napplets/embedded-test-fixture.ts';
import {loadEmbeddedTestArtifact} from '../../src/napplets/embedded-test-fixture.ts';
import {setup} from '../storage/harness.ts';
import {createDiscoveryOpenBroker} from '../../src/napplets/discovery-open-broker.ts';
import {DISCOVERY_OPEN} from '../../src/napplets/discovery-open-contract.ts';
import {descriptorForPublishedArtifact} from '../../src/napplets/published-host-input.ts';
import type {TransitionSnapshot} from '../../src/security/identity-transition.ts';
import type {WorkspaceController} from '../../src/storage/workspace-controller.ts';

const user = '31'.repeat(32), otherUser = '32'.repeat(32);
const id = '58274370-ec8f-4058-a4cc-b63e7e75ca4b';
// Public immutable metadata only; these values are not verified-artifact or admission fixtures.
const recipe = {publisher: 'c2f1ab4e6a577dd8980b57e15986ed92830b95a94f374192235563532b5cac20', appId: 'recipe-cards',
  eventId: 'b70911af4382baded327ce6af4b595197ff7a4781e3704b9f066a74f68b48a07',
  version: '92d5639e1da2a0b9ac6bbb9d41d67b0026c15ed614e2d553f8ad2e4e4e896ecc',
  htmlHash: '9067048a9ce80d7e79ea76b960acc88aa53645754ec4e7549de1c1525a690194'};
const longform = {...recipe, appId: 'longform', eventId: '5fff2ec459ffb1a2d2966fc9815bc8ba45db96a669dfe4924d6c63e65b08a24e',
  version: '3ba5049444dd249abbe671f818d555b4e3c90b7cab88a70187bc3a012f9afd67',
  htmlHash: 'd5558df7e1f3823c0ad5c64273d57802fe304c1e2266bab8e5151fbf05ad51f4'};
const relays = ['wss://relay.example.org'];
const consent = (pin = recipe) => ({profile: LEGACY_READ_ONLY_PROFILE, consent: true, eventId: pin.eventId, htmlHash: pin.htmlHash, relays});
const descriptor = () => ({id, title: 'Recipe cards', source: 'published' as const, publisher: recipe.publisher,
  appId: recipe.appId, eventId: recipe.eventId, version: recipe.version, legacyReadOnly: true as const, legacyReadOnlyUser: user});

test('legacy eligibility binds both immutable publications and every artifact field', () => {
  for (const pin of [recipe, longform]) {
    assert.equal(supportsLegacyReadOnly(pin), true);
    for (const field of ['publisher', 'appId', 'eventId', 'version', 'htmlHash']) {
      assert.equal(supportsLegacyReadOnly({...pin, [field]: field === 'appId' ? 'other' : 'f'.repeat(64)}), false);
    }
    assert.deepEqual(captureLegacyReadOnly(consent(pin), pin, []), consent(pin));
  }
});

test('legacy context requires explicit consent, zero domains, exact HTML and bounded configured relays', () => {
  for (const value of [null, {...consent(), consent: false}, {...consent(), profile: 'other'}, {...consent(), eventId: 'f'.repeat(64)},
    {...consent(), htmlHash: 'f'.repeat(64)}, {...consent(), extra: true}, {...consent(), relays: []},
    {...consent(), relays: [...relays, ...relays]}, {...consent(), relays: ['https://relay.example.org/']},
    {...consent(), relays: ['wss://relay.example.org/path']}, {...consent(), relays: ['wss://relay.example.org/']},
    {...consent(), relays: Array.from({length: 17}, (_, index) => `wss://relay${index}.example.org/`)}]) {
    assert.throws(() => captureLegacyReadOnly(value, recipe, []));
  }
  assert.throws(() => captureLegacyReadOnly(consent(), recipe, ['relay']));
  const {htmlHash: _hash, ...missingHash} = recipe;
  assert.throws(() => captureLegacyReadOnly(consent(), missingHash, []));
  const accepted = captureLegacyReadOnly(consent(), recipe, []);
  assert.equal(Object.isFrozen(accepted), true); assert.equal(Object.isFrozen(accepted.relays), true);
});

test('saved selection never transfers opt-in to another public account', () => {
  assert.equal(isLegacyReadOnlySelection(descriptor(), user), true);
  for (const account of [otherUser, '', 'invalid']) assert.equal(isLegacyReadOnlySelection(descriptor(), account), false);
  assert.equal(isLegacyReadOnlySelection({...descriptor(), legacyReadOnlyUser: undefined}, user), false);
  assert.equal(isLegacyReadOnlySelection({...descriptor(), legacyReadOnly: undefined}, user), false);
  assert.equal(isLegacyReadOnlySelection({}, user), false);
});
test('saved legacy selection roundtrips only with its exact immutable pin and public account', () => {
  const saved = snapshotWorkspace(openNapplet(emptyWorkspace(), descriptor()));
  assert.deepEqual(restoreWorkspace(saved).sessions[0], descriptor());
  for (const changed of [{legacyReadOnly: false}, {legacyReadOnlyUser: undefined}, {legacyReadOnlyUser: 'invalid'},
    {legacyReadOnly: undefined, legacyReadOnlyUser: user}, {eventId: 'f'.repeat(64)}, {version: 'f'.repeat(64)},
    {publisher: 'f'.repeat(64)}, {appId: 'other'}]) {
    assert.throws(() => restoreWorkspace({...saved, sessions: [{...descriptor(), ...changed}]}));
  }
  const ordinary = {...descriptor(), legacyReadOnly: undefined, legacyReadOnlyUser: undefined};
  assert.equal(restoreWorkspace({...saved, sessions: [ordinary]}).sessions[0]!.legacyReadOnly, undefined);
});

const source = bundledDescriptor('napplet-discovery', 1, '11111111-1111-4111-8111-111111111111');
const origin = {...resolveBundledSession(source), user, epoch: 1, generation: 'source-generation', sessionId: source.id};
function request(available: boolean): RoutingReviewRequest {
  return {kind: 'published-open', origin, source, changesAccess: false,
    ...(available ? {legacyReadOnlyAvailable: true as const} : {}),
    target: {...recipe, requiredDomains: [], optionalDomains: [], unsupportedDomains: [], unsupportedOptionalDomains: []}};
}
test('trusted review defaults to ordinary mode and accepts only an explicit available legacy choice', async () => {
  for (const [available, decision, expected] of [
    [true, {allow: true}, {allow: true}],
    [true, {allow: true, legacyReadOnly: true}, {allow: true, legacyReadOnly: true}],
    [true, {allow: false, legacyReadOnly: true}, {allow: false}],
    [false, {allow: true, legacyReadOnly: true}, {allow: false}],
  ] as const) {
    const service = new RoutingReviewService(); const result = service.ask(request(available), () => {}, () => true);
    service.decide(service.getSnapshot()!.id, decision); assert.deepEqual(await result, expected);
  }
});
test('legacy consent cannot survive a revoked request or move to a successor request', async () => {
  const service = new RoutingReviewService(); let active = true;
  const old = service.ask(request(true), () => {if (!active) throw Error('revoked');}, () => true);
  const stale = service.getSnapshot()!.id; active = false; service.refresh(); assert.deepEqual(await old, {allow: false});
  const next = service.ask(request(false), () => {}, () => true);
  service.decide(stale, {allow: true, legacyReadOnly: true});
  service.decide(service.getSnapshot()!.id, {allow: true}); assert.deepEqual(await next, {allow: true});
});

test('real verified ordinary publication cannot opt in through manual entry or an unavailable exact-open choice', async t => {
  const {database, sqlite} = await setup(t); let staged = 0;
  const ports: PublishedSessionDependencies = {database, sqlite, newInstanceId: () => id,
    identity: {sessionAuthority: () => ({user, epoch: 1, assertActive() {}}), getSnapshot: () => ({session: {epoch: 1}})} as PublishedSessionDependencies['identity'],
    lookupRelays: () => relays, source: {query: async () => [EMBEDDED_TEST_EVENT], readHtml: async () => getEmbeddedTestHtmlBytes()},
    native: {registerPublishedSession: () => {staged++; return true;}, beginPublishedArtifact: () => 'transfer',
      appendPublishedArtifact: () => true, finishPublishedArtifact: () => 'a'.repeat(64), cancelPublishedArtifact() {},
      revokePublishedSession() {}, revokeAllPublishedArtifacts() {}},
  };
  const coordinator = createPublishedSessionCoordinator(ports), signal = new AbortController().signal;
  const manual = await coordinator.openLink(naddrEncode(EMBEDDED_TEST_COORDINATE), signal, async () => true);
  assert.equal(manual.descriptor.legacyReadOnly, undefined);
  assert.equal(JSON.parse(JSON.parse(manual.hostInput).configuration).legacyReadOnly, undefined); manual.revoke();
  const carried = {...manual.descriptor, legacyReadOnly: true as const, legacyReadOnlyUser: otherUser};
  const rebound = await coordinator.reopenPinned(carried, signal, async () => true);
  assert.equal(rebound.descriptor.legacyReadOnly, undefined);
  assert.equal(rebound.descriptor.legacyReadOnlyUser, undefined);
  assert.equal(JSON.parse(JSON.parse(rebound.hostInput).configuration).legacyReadOnly, undefined); rebound.revoke();
  const before = staged;
  await assert.rejects(coordinator.prepareExact(await loadEmbeddedTestArtifact(), {assertActive() {},
    reviewLaunch: async (_changesAccess, available) => {assert.equal(available, false); return LEGACY_READ_ONLY_PROFILE;}}, signal));
  assert.equal(staged, before);
});

// Uses ordinary verified metadata to exercise persistence without inventing a legacy grant.
test('discovered installed unmounted pins persist their newly prepared descriptor in place', async () => {
  const artifact = await loadEmbeddedTestArtifact();
  const saved = descriptorForPublishedArtifact(artifact, id), next = {...saved, title: 'Reviewed prepared title'};
  let workspace = openNapplet(openNapplet(emptyWorkspace(), saved), source), mounted = false, held = true;
  const controller: WorkspaceController = {getSnapshot: () => ({workspace, saving: false, error: null}),
    subscribe: () => () => {}, change: value => {workspace = value;}, flush: async () => {}, freeze() {}, resume() {}, revoke() {}};
  const transition = {phase: 'ready', session: {workspace: controller, epoch: 1, vault: {selectedPubkey: user}}} as TransitionSnapshot;
  const reviews = new RoutingReviewService();
  const message = {type: DISCOVERY_OPEN, id: 'guest-open', address: naddrEncode(EMBEDDED_TEST_COORDINATE), expectedEventId: artifact.manifest.eventId};
  const wire = JSON.stringify({registration: origin, request: JSON.stringify({type: 'routing.call', id: 'open-request', message, revision: 2, focusRevision: 7})});
  let response: string | null = null;
  const broker = createDiscoveryOpenBroker({identity: {getSnapshot: () => transition, subscribe: () => () => {}}, reviews,
    native: {state: () => ({user, epoch: 1, revision: 2, available: true, ownerAvailable: true, foreground: true}),
      mayDeliver: () => true, mayReview: () => true, reviewRevision: () => 7, send: () => false,
      newChannelId: () => 'channel', subscribe: () => () => {}},
    capability: {take: () => wire, isActive: () => held, finish: (_token, value) => {held = false; response = value;}},
    runtime: () => ({resolveDiscovered: async () => artifact,
      prepareDiscovered: async (_artifact, _signal, active, review, existing) => {
        assert.deepEqual(existing, saved); assert.equal(await review(false), true); active(); mounted = true; return next;
      }, publishedReadyGeneration: candidate => candidate.id === id && mounted ? 'mounted-target' : null, discardPublished() {}}),
  });
  const running = broker.dispatch('open-token', {registration: origin, assertActive() {}}, source);
  for (let attempt = 0; attempt < 30 && reviews.getSnapshot() === null; attempt++) await new Promise(resolve => setTimeout(resolve, 1));
  assert(reviews.getSnapshot()); reviews.decide(reviews.getSnapshot()!.id, {allow: true}); await running;
  assert(response); assert.equal(JSON.parse(response).response, 'opened');
  assert.deepEqual(workspace.sessions.map(value => value.id), [id, source.id]);
  assert.equal(workspace.sessions[0], next); assert.equal(workspace.focusedId, id);
});
