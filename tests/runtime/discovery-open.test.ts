import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test, { before } from 'node:test';
import { naddrEncode } from 'nostr-tools/nip19';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { createDiscoveryOpenBroker } from '../../src/napplets/discovery-open-broker.ts';
import { DISCOVERY_OPEN, parseDiscoveryOpen, type DiscoveryOpenOutcome } from '../../src/napplets/discovery-open-contract.ts';
import { PublishedLoadError } from '../../src/napplets/loader.ts';
import { PublishedTransferError } from '../../src/napplets/native-transfer.ts';
import { descriptorForPublishedArtifact } from '../../src/napplets/published-host-input.ts';
import { resolveNappletLink } from '../../src/napplets/resolve-link.ts';
import { verifyArtifact, verifyManifest, type VerifiedNappletArtifact } from '../../src/napplets/verified-artifact.ts';
import type { RoutingNativePort } from '../../src/routing/routing-port.ts';
import { RoutingReviewService } from '../../src/routing/routing-review.ts';
import { ReviewSlot } from '../../src/shell/review-slot.ts';
import type { TransitionSnapshot } from '../../src/security/identity-transition.ts';
import { bundledDescriptor, resolveBundledSession } from '../../src/shell/fixtures.ts';
import { emptyWorkspace, openNapplet, showOverview, type NappletDescriptor } from '../../src/shell/workspace.ts';
import { openWorkspaceController, type WorkspaceController } from '../../src/storage/workspace-controller.ts';
import { pinNapplet, pinnedNapplets } from '../../src/shell/pins.ts';
import { createRuntimeOwner, type RuntimeOwner } from '../../src/runtime/runtime-owner.ts';
import { NativeLeases } from './native-leases.ts';
import { setup as diskSetup } from '../storage/harness.ts';
import type { IdentityTransition } from '../../src/security/identity-transition.ts';

const secret = Uint8Array.from([...new Uint8Array(31), 7]);
const publisher = getPublicKey(secret);
const appId = 'open-test';
const address = naddrEncode({ kind: 35129, pubkey: publisher, identifier: appId });
const html = new TextEncoder().encode('<!doctype html><html lang="en"><head></head><body>Test</body></html>');
const hash = createHash('sha256').update(html).digest('hex');
const signed = finalizeEvent({ kind: 35129, created_at: 1_700_000_001, content: 'Open test',
  tags: [['d', appId], ['title', 'Open test title'], ['x', hash], ['server', 'https://blossom.example.org/'], ['R', 'relay'], ['O', 'pow'], ['O', 'keys']] }, secret);
const wire = { id: signed.id, pubkey: signed.pubkey, created_at: signed.created_at, kind: signed.kind,
  tags: signed.tags.map(tag => [...tag]), content: signed.content, sig: signed.sig };
let artifact: VerifiedNappletArtifact;
const source = bundledDescriptor('napplet-discovery', 1, '11111111-1111-4111-8111-111111111111');
let target: NappletDescriptor;
const targetGeneration = 'mounted-target';
const user = 'b'.repeat(64);
const registration = { ...resolveBundledSession(source), user, epoch: 1, generation: 'source-generation', sessionId: source.id };
const request = { type: DISCOVERY_OPEN, id: 'guest-request', address, expectedEventId: signed.id };
before(async () => {
  artifact = await verifyArtifact(await verifyManifest(resolveNappletLink(address), wire), html);
  target = descriptorForPublishedArtifact(artifact, '22222222-2222-4222-8222-222222222222');
});

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail('condition was never reached');
}

function subscriptions() {
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    emit() { listeners.forEach(listener => listener()); },
  };
}

function setup(initial = openNapplet(emptyWorkspace(), source), reviews = new RoutingReviewService(), persisted?: WorkspaceController) {
  let workspace = initial;
  let suppliedRuntime: Pick<RuntimeOwner, 'resolveDiscovered' | 'prepareDiscovered' | 'publishedReadyGeneration' | 'discardPublished'> | null = null;
  let revision = 2;
  let focusRevision = 7;
  let available = true;
  let mounted = false;
  let focused = false;
  const lookups: { address: string; expectedEventId: string }[] = [];
  let staged = 0;
  let stageError: PublishedTransferError | null = null;
  let paused: Promise<void> | null = null;
  let lookupError: PublishedLoadError | null = null;
  const discarded: string[] = [];
  const changes = subscriptions(), lifecycle = subscriptions(), account = subscriptions();
  const controller: WorkspaceController = persisted ?? {
    getSnapshot: () => ({ workspace, saving: false, error: null }), subscribe: changes.subscribe,
    change: state => { workspace = state; changes.emit(); }, flush: async () => {},
    freeze() {}, resume() {}, revoke() {},
  };
  const transition = { phase: 'ready', session: { workspace: controller, epoch: 1, vault: { selectedPubkey: user } } } as TransitionSnapshot;
  const native: RoutingNativePort = {
    state: () => ({ user, epoch: 1, revision, available, ownerAvailable: true, foreground: available }),
    mayDeliver: (generation, candidate, domain) => available && generation === registration.generation && candidate === revision && domain === 'published-open',
    mayReview: generation => generation === targetGeneration && mounted && focused && available,
    reviewRevision: generation => generation === registration.generation ? focusRevision : null,
    send: () => false, newChannelId: () => '33333333-3333-4333-8333-333333333333', subscribe: lifecycle.subscribe,
  };
  const held = new Map<string, string>(), responses = new Map<string, DiscoveryOpenOutcome | null>();
  const broker = createDiscoveryOpenBroker({
    identity: { getSnapshot: () => transition, subscribe: account.subscribe }, reviews, native,
    capability: {
      take: token => held.get(token) ?? null, isActive: token => held.has(token),
      finish: (token, response) => {
        held.delete(token);
        responses.set(token, response === null ? null : JSON.parse(response).response as DiscoveryOpenOutcome);
      },
    },
    runtime: () => suppliedRuntime ?? ({
      async resolveDiscovered(link, expected, _signal, active) {
        lookups.push({ address: link, expectedEventId: expected });
        if (paused) await paused;
        if (lookupError) throw lookupError;
        active();
        return artifact;
      },
      async prepareDiscovered(candidate, _signal, active, review, existing) {
        assert.equal(candidate, artifact);
        if (!await review(true)) throw new Error('Consent declined');
        active();
        if (stageError) throw stageError;
        staged++;
        return existing ?? target;
      },
      publishedReadyGeneration: session => session.id === target.id && mounted ? targetGeneration : null,
      discardPublished: id => { discarded.push(id); },
    }),
  });
  const run = (token: string, options: { message?: typeof request & {action?: 'pin' | 'unpin' | 'pin-state'}; origin?: typeof registration; source?: typeof source } = {}) => {
    held.set(token, JSON.stringify({
      registration: options.origin ?? registration,
      request: JSON.stringify({ type: 'routing.call', id: token, message: options.message ?? request, revision: 2, focusRevision: 7 }),
    }));
    return broker.dispatch(token, { registration, assertActive() {} }, options.source ?? source);
  };
  const review = async () => {
    await until(() => reviews.getSnapshot() !== null);
    return reviews.getSnapshot()!;
  };
  const decide = (id: string, allow: boolean) => reviews.decide(id, { allow });
  return {
    run, review, decide, reviews, responses, discarded, controller, transition,
    useRuntime: (runtime: NonNullable<typeof suppliedRuntime>) => { suppliedRuntime = runtime; },
    state: () => controller.getSnapshot().workspace, staged: () => staged, lookups,
    ready: () => { mounted = true; lifecycle.emit(); },
    focusTarget: () => { focused = true; lifecycle.emit(); },
    overview: () => controller.change(showOverview(controller.getSnapshot().workspace)),
    unfocus: (notify = true) => { focusRevision++; if (notify) lifecycle.emit(); },
    background: () => { available = false; revision++; lifecycle.emit(); },
    holdLookup: (promise: Promise<void>) => { paused = promise; },
    failLookup: (error: PublishedLoadError) => { lookupError = error; },
    failStage: () => { stageError = new PublishedTransferError(); },
  };
}

test('canonical selector rejects relay hints, wrong kinds and caller-supplied authority', async () => {
  assert.deepEqual(parseDiscoveryOpen(request), request);
  assert.throws(() => parseDiscoveryOpen({ ...request, address: 'nostr:' + address }));
  assert.throws(() => parseDiscoveryOpen({ ...request, expectedEventId: 'F'.repeat(64) }));
  assert.throws(() => parseDiscoveryOpen({ ...request, approved: true }));
  const env = setup();
  await env.run('hint', { message: { ...request, address: naddrEncode({ kind: 35129, pubkey: publisher, identifier: appId, relays: ['wss://relay.example.org'] }) } });
  await env.run('kind', { message: { ...request, address: naddrEncode({ kind: 15129, pubkey: publisher, identifier: appId }) } });
  assert.deepEqual([...env.responses.values()], ['unavailable', 'unavailable']);
  assert.equal(env.lookups.length, 0);
});

test('the actual bundled source opens a verified exact cold target after review and native focus', {timeout: 2000}, async () => {
  const env = setup();
  const pending = env.run('open');
  const review = await env.review();
  assert.deepEqual(env.lookups, [{ address, expectedEventId: artifact.manifest.eventId }]);
  assert.equal(review.request.kind, 'published-open');
  if (review.request.kind !== 'published-open') return;
  assert.deepEqual(review.request.source, source);
  assert.equal(review.request.target.publisher, publisher);
  assert.equal(review.request.target.eventId, artifact.manifest.eventId);
  assert.deepEqual(review.request.target.metadata, {
    title: 'Open test title', description: 'Open test', reference: address,
    version: artifact.aggregateHash, htmlHash: artifact.htmlHash,
  });
  assert.equal(Object.isFrozen(review.request.target.metadata), true);
  assert.deepEqual(review.request.target.requiredDomains, ['relay']);
  assert.deepEqual(review.request.target.optionalDomains, ['keys', 'pow']);
  assert.deepEqual(review.request.target.unsupportedOptionalDomains, ['pow']);
  assert.equal(review.request.changesAccess, true);
  assert.equal(env.staged(), 0);
  await env.run('second');
  assert.equal(env.responses.get('second'), 'busy');
  env.decide(review.id, true);
  await until(() => env.state().focusedId === target.id);
  env.ready();
  await delay(70);
  assert.equal(env.responses.has('open'), false);
  env.focusTarget();
  await pending;
  assert.equal(env.responses.get('open'), 'opened');
  assert.deepEqual(env.state().sessions, [source, target]);
  assert.deepEqual(env.discarded, []);
});

test('exact mounted pins are reviewed and reused, different saved revisions keep their pin', {timeout: 2000}, async () => {
  const initial = openNapplet(openNapplet(emptyWorkspace(), target), source);
  const existing = setup(initial);
  existing.ready();
  const pending = existing.run('open');
  const review = await existing.review();
  assert.equal(review.request.kind, 'published-open');
  if (review.request.kind !== 'published-open') return;
  assert.deepEqual(review.request.target.optionalDomains, ['keys', 'pow']);
  assert.equal(review.request.changesAccess, false);
  existing.decide(review.id, true);
  existing.focusTarget();
  await pending;
  assert.equal(existing.responses.get('open'), 'opened');
  assert.equal(existing.staged(), 0);
  assert.equal(existing.state().sessions.length, 2);
  const other = setup(openNapplet(openNapplet(emptyWorkspace(), {...target, eventId: '9'.repeat(64)}), source));
  await other.run('conflict');
  assert.equal(other.responses.get('conflict'), 'conflict');
  assert.equal(other.reviews.getSnapshot(), null);
});

test('signed lookup outcomes stop before review and never substitute a target', async () => {
  for (const [code, status] of [
    ['PUBLISHED_REVISION_CHANGED', 'refresh-required'], ['PUBLISHED_REVISION_CONFLICT', 'conflict'],
    ['PUBLISHED_NOT_FOUND', 'not-found'], ['PUBLISHED_UNSUPPORTED_MANIFEST', 'unsupported'],
    ['PUBLISHED_LOOKUP_UNAVAILABLE', 'lookup-unavailable'], ['PUBLISHED_DOWNLOAD_UNAVAILABLE', 'download-unavailable'],
    ['PUBLISHED_HASH_MISMATCH', 'hash-mismatch'], ['PUBLISHED_INVALID_HTML', 'invalid-html'],
    ['PUBLISHED_LOAD_FAILED', 'failed'],
  ] as const) {
    const env = setup();
    env.failLookup(new PublishedLoadError(code));
    await env.run('lookup');
    assert.equal(env.responses.get('lookup'), status);
    assert.equal(env.reviews.getSnapshot(), null);
    assert.equal(env.staged(), 0);
  }
});

test('invalid source, forged native generation and stale native focus cannot reach lookup', async () => {
  const env = setup();
  await env.run('source', { source: { ...source, title: 'Forged entry' } });
  await env.run('generation', { origin: { ...registration, generation: 'other-generation' } });
  env.unfocus();
  await env.run('focus');
  assert.deepEqual([...env.responses.values()], [null, null, 'cancelled']);
  assert.equal(env.lookups.length, 0);
});

test('denial and focus loss during review leave the source intact', {timeout: 2000}, async () => {
  const rejected = setup();
  const first = rejected.run('reject');
  rejected.decide((await rejected.review()).id, false);
  await first;
  assert.equal(rejected.responses.get('reject'), 'rejected');
  assert.equal(rejected.staged(), 0);
  const revoked = setup();
  const second = revoked.run('blur');
  const review = await revoked.review();
  revoked.unfocus();
  revoked.decide(review.id, true);
  await second;
  assert.equal(revoked.responses.get('blur'), 'cancelled');
  assert.equal(revoked.reviews.getSnapshot(), null);
  assert.deepEqual(revoked.state().sessions, [source]);
});

test('background after a held lookup suppresses the late result', async () => {
  const env = setup();
  let resume!: () => void;
  env.holdLookup(new Promise<void>(resolve => { resume = resolve; }));
  const pending = env.run('open');
  env.background();
  resume();
  await pending;
  assert.equal(env.responses.get('open'), null);
  assert.equal(env.reviews.getSnapshot(), null);
  assert.equal(env.staged(), 0);
});

test('leaving a committed target before readiness revokes the staged view', {timeout: 2000}, async () => {
  const env = setup();
  const pending = env.run('open');
  env.decide((await env.review()).id, true);
  await until(() => env.state().focusedId === target.id);
  env.overview();
  env.ready();
  env.focusTarget();
  await pending;
  assert.equal(env.responses.get('open'), 'cancelled');
  assert.deepEqual(env.discarded, [target.id]);
  assert.deepEqual(env.state().sessions, [source]);
  assert.equal(env.state().overview, true);
});

test('a verified event from a different coordinate cannot reach review even with the expected event ID', async () => {
  for (const coordinate of [
    { kind: 35129, pubkey: user, identifier: appId },
    { kind: 35129, pubkey: publisher, identifier: 'different-app' },
  ]) {
    const env = setup();
    await env.run('substitute', { message: { ...request, address: naddrEncode(coordinate) } });
    assert.equal(env.responses.get('substitute'), 'failed');
    assert.equal(env.reviews.getSnapshot(), null);
    assert.equal(env.staged(), 0);
  }
});


test('a native review that arrives during exact discovery lookup returns busy before staging', async t => {
  let upload: {id: string; origin: typeof registration} | null = null;
  const inert = () => () => {};
  const slot = new ReviewSlot({getSnapshot: () => ({current: null}), subscribe: inert},
    {getSnapshot: () => ({current: upload}), subscribe: inert}, () => registration.epoch, inert);
  t.after(() => slot.dispose());
  const env = setup(undefined, new RoutingReviewService(slot));
  let resume = () => {};
  env.holdLookup(new Promise<void>(resolve => {resume = resolve;}));
  const pending = env.run('lookup-then-busy');
  await until(() => env.lookups.length === 1);
  upload = {id: 'pending-upload', origin: registration};
  slot.refresh();
  resume();
  await pending;
  assert.equal(env.responses.get('lookup-then-busy'), 'busy');
  assert.equal(env.reviews.getSnapshot(), null);
  assert.equal(env.staged(), 0);
  assert.deepEqual(env.state().sessions.map(session => session.id), [source.id]);
  assert.ok(slot.owns('upload', upload.id));
});


test('an exact transfer failure after approval reports staging without opening a target', async () => {
  const env = setup();
  env.failStage();
  const pending = env.run('failed-stage');
  const review = await env.review();
  env.decide(review.id, true);
  await pending;
  assert.equal(env.responses.get('failed-stage'), 'stage-unavailable');
  assert.equal(env.staged(), 0);
  assert.deepEqual(env.state().sessions, [source]);
});


test('a full workspace reports its exact capacity without starting a review', async () => {
  let full = emptyWorkspace();
  for (let index = 0; index < 63; index++) {
    full = openNapplet(full, {...target, id: 'other-view-' + index, appId: 'other-' + index});
  }
  const env = setup(openNapplet(full, source));
  await env.run('full');
  assert.equal(env.responses.get('full'), 'workspace-full');
  assert.equal(env.reviews.getSnapshot(), null);
  assert.equal(env.staged(), 0);
});


test('a changed native focus revision takes precedence over a late lookup diagnostic', async () => {
  const env = setup();
  let resume = () => {};
  env.holdLookup(new Promise<void>(resolve => {resume = resolve;}));
  const pending = env.run('stale-diagnostic');
  await until(() => env.lookups.length === 1);
  env.unfocus(false);
  env.failLookup(new PublishedLoadError('PUBLISHED_LOOKUP_UNAVAILABLE'));
  resume();
  await pending;
  assert.equal(env.responses.get('stale-diagnostic'), 'cancelled');
  assert.equal(env.reviews.getSnapshot(), null);
});

test('one-tap Discover pin saves only a shortcut without review, staging or focus changes', async () => {
  const env = setup();
  await env.run('pin', {message: {...request, action: 'pin'}});
  assert.equal(env.responses.get('pin'), 'pinned');
  assert.equal(env.reviews.getSnapshot(), null);
  assert.equal(env.staged(), 0);
  assert.equal(env.state().focusedId, source.id);
  assert.deepEqual(env.state().sessions, [source]);
  assert.equal(env.state().pins?.[1]?.eventId, signed.id);
  await env.run('pin-again', {message: {...request, action: 'pin'}});
  assert.equal(env.responses.get('pin-again'), 'pinned');
  assert.equal(env.state().pins?.length, 2);
});

test('revoked exact pin lookup never writes a shortcut', async () => {
  const env = setup();
  let resume!: () => void;
  env.holdLookup(new Promise<void>(resolve => {resume = resolve;}));
  const pending = env.run('pin', {message: {...request, action: 'pin'}});
  env.background(); resume(); await pending;
  assert.equal(env.state().pins?.length, 1);
  assert.equal(env.staged(), 0);
  assert.equal(env.responses.get('pin'), null);
});

test('pin state and unpin use the saved coordinate across listing versions and preserve running sessions', async () => {
  const older = {...target, eventId: '9'.repeat(64)};
  const initial = pinNapplet(openNapplet(openNapplet(emptyWorkspace(), older), source), older);
  const env = setup(initial);
  env.failLookup(new PublishedLoadError('PUBLISHED_LOOKUP_UNAVAILABLE'));
  await env.run('state', {message: {...request, action: 'pin-state'}});
  assert.equal(env.responses.get('state'), 'pinned');
  await env.run('unpin', {message: {...request, action: 'unpin'}});
  assert.equal(env.responses.get('unpin'), 'unpinned');
  assert.deepEqual(env.state().sessions, initial.sessions);
  assert.equal(env.state().focusedId, source.id);
  assert.deepEqual(pinnedNapplets(env.state()).map(pin => pin.appId), ['napplet-discovery']);
  await env.run('again', {message: {...request, action: 'unpin'}});
  await env.run('state-after', {message: {...request, action: 'pin-state'}});
  assert.equal(env.responses.get('again'), 'unpinned');
  assert.equal(env.responses.get('state-after'), 'unpinned');
  assert.deepEqual(env.lookups, []);
  assert.equal(env.reviews.getSnapshot(), null);
});

test('pin requests accept only explicit actions and no caller-supplied authority', () => {
  for (const action of ['pin', 'unpin', 'pin-state'] as const) assert.equal(parseDiscoveryOpen({...request, action}).action, action);
  for (const extra of [{action: 'grant'}, {action: 'pin', approved: true}, {action: true}]) {
    assert.throws(() => parseDiscoveryOpen({...request, ...extra}));
  }
});

test('ordinary Home first-open of a one-tap pin still requires consent before any grant or native staging', async t => {
  const {database, sqlite} = await diskSetup(t);
  const env = setup();
  const calls: string[] = [];
  const native = Object.assign(new NativeLeases(), {
    registerPublishedSession: () => {calls.push('register'); return true;},
    beginPublishedArtifact: () => {calls.push('begin'); return 'upload';},
    appendPublishedArtifact: () => {calls.push('append'); return true;},
    finishPublishedArtifact: () => {calls.push('finish'); return 'a'.repeat(64);},
    cancelPublishedArtifact() {}, revokePublishedSession() {}, revokeAllPublishedArtifacts() {},
  });
  const identity = {getSnapshot: () => env.transition, sessionAuthority: () => ({user, epoch: 1, assertActive() {}})} as unknown as Pick<IdentityTransition, 'getSnapshot' | 'sessionAuthority'>;
  const runtime = createRuntimeOwner(database, identity, native, undefined, {
    sqlite, native, lookupRelays: () => ['wss://relay.example.org'],
    source: {query: async () => [wire], readHtml: async () => html},
  });
  env.useRuntime(runtime);
  await env.run('pin', {message: {...request, action: 'pin'}});
  assert.equal(env.responses.get('pin'), 'pinned');
  assert.equal(env.reviews.getSnapshot(), null);
  assert.deepEqual(calls, []);
  const app = database.bindApp({user, publisher, appId, assertActive() {}});
  assert.equal(await app.port.readAccessGrant(), null);
  assert.equal(await app.port.selectedVersion(), null);
  const shortcut = pinnedNapplets(env.state()).find(pin => pin.source === 'published')!;
  // Home navigation inserts the saved descriptor; NappletHost then uses ordinary openPublished.
  env.controller.change(openNapplet(env.state(), shortcut));
  let reviews = 0;
  await assert.rejects(runtime.openPublished(shortcut, new AbortController().signal, async review => {
    reviews++; assert.deepEqual(review.domains, ['relay']); return false;
  }));
  assert.equal(reviews, 1);
  assert.equal(await app.port.readAccessGrant(), null);
  assert.deepEqual(calls, []);
  const binding = await runtime.openPublished(shortcut, new AbortController().signal, async () => {reviews++; return true;});
  assert.equal(reviews, 2);
  assert.deepEqual(calls, ['register', 'begin', 'append', 'finish']);
  assert.deepEqual((await app.port.readAccessGrant())?.domains, ['keys', 'relay']);
  binding.revoke(); app.revoke();
});


test('pin and unpin receipts follow durable account-scoped workspace saves and reload', async t => {
  const {database} = await diskSetup(t);
  const owner = {user, assertActive() {}};
  const controller = await openWorkspaceController(database.bindWorkspace(owner), () => openNapplet(emptyWorkspace(), source), () => {});
  const env = setup(undefined, new RoutingReviewService(), controller);
  await env.run('pin', {message: {...request, action: 'pin'}});
  assert.equal(env.responses.get('pin'), 'pinned');
  const afterPin = await database.bindWorkspace(owner).port.load();
  assert.equal(afterPin?.snapshot.pins?.[1]?.eventId, signed.id);
  const other = await database.bindWorkspace({user: 'c'.repeat(64), assertActive() {}}).port.load();
  assert.equal(other, null);
  await env.run('unpin', {message: {...request, action: 'unpin'}});
  assert.equal(env.responses.get('unpin'), 'unpinned');
  const reopened = await openWorkspaceController(database.bindWorkspace(owner), () => assert.fail('No reseed'), () => {});
  assert.deepEqual(pinnedNapplets(reopened.getSnapshot().workspace).map(pin => pin.appId), ['napplet-discovery']);
  assert.deepEqual(reopened.getSnapshot().workspace.sessions, [source]);
});


test('unpin rejects stale focus and foreign native bindings without changing Home', async () => {
  for (const foreign of [false, true]) {
    const initial = pinNapplet(openNapplet(emptyWorkspace(), source), target);
    const env = setup(initial);
    if (!foreign) env.unfocus();
    await env.run('unpin', {message: {...request, action: 'unpin'}, ...(foreign ? {origin:{...registration, generation:'foreign'}} : {})});
    assert.equal(env.responses.get('unpin'), foreign ? null : 'cancelled');
    assert.deepEqual(env.state(), initial);
  }
});

test('a failed pin persistence operation never reports a successful pin receipt', async t => {
  const {database, sqlite} = await diskSetup(t);
  const owner = {user, assertActive() {}};
  const controller = await openWorkspaceController(database.bindWorkspace(owner), () => openNapplet(emptyWorkspace(), source), () => {});
  const env = setup(undefined, new RoutingReviewService(), controller);
  sqlite.faults.push({prefix: 'UPDATE workspaces', mode: 'before'});
  await env.run('pin', {message: {...request, action: 'pin'}});
  assert.notEqual(env.responses.get('pin'), 'pinned');
  assert.equal(controller.getSnapshot().error, 'STORAGE_FAILURE');
  assert.deepEqual((await database.bindWorkspace(owner).port.load())?.snapshot.pins?.map(pin => pin.appId), ['napplet-discovery']);
});
