import { WorkspaceViews } from '../../src/shell/workspace-views.ts';
import { setup as setupStorage, registration as storageRegistration } from '../storage/harness.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test, { before } from 'node:test';
import { naddrEncode } from 'nostr-tools/nip19';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { createNappletLinkBroker } from '../../src/links/napplet-link-broker.ts';
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
import type { NativeRegistration } from '../../src/runtime/capability-protocol.ts';

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
const request = { type: 'link.open', id: 'guest-request', url: 'nostr:' + address };
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

function setup(initial = openNapplet(emptyWorkspace(), source), reviews = new RoutingReviewService(), persisted?: WorkspaceController, caller: NativeRegistration = registration) {
  let workspace = initial;
  let revision = 2;
  let focusRevision = 7;
  let available = true;
  let mounted = false;
  let focused = false;
  const lookups: { address: string; networkReadGranted?: boolean }[] = [];
  let staged = 0;
  let hasRoom = true;
  let admit = true;
  const residents = new Set<string>();
  const capacity: ('cards' | 'views')[] = [];
  let openOverview: (() => void) | undefined;
  let stageError: PublishedTransferError | null = null;
  let paused: Promise<void> | null = null;
  let lookupError: PublishedLoadError | null = null;
  const discarded: string[] = [];
  const changes = subscriptions(), lifecycle = subscriptions(), account = subscriptions();
  const controller: WorkspaceController = persisted ?? {
    views: new WorkspaceViews(initial),
    getSnapshot: () => ({ workspace, saving: false, error: null }), subscribe: changes.subscribe,
    canLoadView: ids => hasRoom || ids.some(id => residents.has(id)),
    admitView: id => admit && (hasRoom || residents.has(id)),
    change: state => { workspace = state; changes.emit(); }, acceptUpdate: async () => { throw Error('Unexpected update'); }, flush: async () => {},
    freeze() {}, resume() {}, revoke() {},
  };
  const transition = { phase: 'ready', session: { workspace: controller, epoch: 1, vault: { selectedPubkey: user } } } as TransitionSnapshot;
  const native: RoutingNativePort = {
    state: () => ({ user, epoch: 1, revision, available, ownerAvailable: true, foreground: available }),
    mayDeliver: (generation, candidate, domain) => available && generation === registration.generation && candidate === revision && (domain === 'link' && caller.domains.includes('link')),
    mayReview: generation => generation === targetGeneration && mounted && focused && available,
    reviewRevision: generation => generation === registration.generation ? focusRevision : null,
    send: () => false, newChannelId: () => '33333333-3333-4333-8333-333333333333', subscribe: lifecycle.subscribe,
  };
  const held = new Map<string, string>(), responses = new Map<string, unknown>();
  const broker = createNappletLinkBroker({
    identity: { getSnapshot: () => transition, subscribe: account.subscribe }, reviews, native, reportCapacity: (reason, choose) => { capacity.push(reason); openOverview = choose; },
    capability: {
      take: token => held.get(token) ?? null, isActive: token => held.has(token),
      finish: (token, response) => {
        held.delete(token);
        const reply = response === null ? null : JSON.parse(response).response;
        responses.set(token, reply?.id === 'guest-request' ? reply.error ?? reply.status : reply);
      },
    },
    runtime: () => ({
      
      async resolveNappletLink(link, _signal, active, networkReadGranted) {
        lookups.push({ address: link, networkReadGranted });
        if (paused) await paused;
        if (lookupError) throw lookupError;
        active();
        return artifact;
      },
      async prepareNappletLink(candidate, _signal, active, review, existing) {
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
  const run = (token: string, options: { message?: unknown; origin?: typeof registration; source?: typeof source } = {}) => {
    held.set(token, JSON.stringify({
      registration: options.origin ?? caller,
      request: JSON.stringify({ type: 'routing.call', id: token, message: options.message ?? request, revision: 2, focusRevision: 7 }),
    }));
    return broker.dispatch(token, { registration: caller, assertActive() {} }, options.source ?? source);
  };
  const review = async () => {
    await until(() => reviews.getSnapshot() !== null);
    return reviews.getSnapshot()!;
  };
  const decide = (id: string, allow: boolean) => reviews.decide(id, { allow });
  return {
    run, review, decide, reviews, responses, discarded, controller, transition,
    state: () => controller.getSnapshot().workspace, staged: () => staged, lookups,
    capacity, chooseOverview: () => openOverview?.(), fillViews: () => { hasRoom = false; }, refuseAdmission: () => { admit = false; },
    ready: () => { mounted = true; residents.add(target.id); lifecycle.emit(); },
    focusTarget: () => { focused = true; lifecycle.emit(); },
    overview: () => controller.change(showOverview(controller.getSnapshot().workspace)),
    unfocus: (notify = true) => { focusRevision++; if (notify) lifecycle.emit(); },
    background: () => { available = false; revision++; lifecycle.emit(); },
    holdLookup: (promise: Promise<void>) => { paused = promise; },
    failLookup: (error: PublishedLoadError) => { lookupError = error; },
    failStage: () => { stageError = new PublishedTransferError(); },
  };
}

test('the actual bundled source opens a verified exact cold target after review and native focus', {timeout: 2000}, async () => {
  const env = setup();
  const pending = env.run('open');
  const review = await env.review();
  assert.deepEqual(env.lookups, [{address: request.url, networkReadGranted: true}]);
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
  assert.equal(env.responses.get('second'), 'blocked-by-policy');
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
  existing.fillViews();
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
  assert.equal(other.responses.get('conflict'), 'blocked-by-policy');
  assert.equal(other.reviews.getSnapshot(), null);
});

test('signed lookup outcomes stop before review and never substitute a target', async () => {
  for (const code of [
    'PUBLISHED_REVISION_CONFLICT', 'PUBLISHED_NOT_FOUND', 'PUBLISHED_UNSUPPORTED_MANIFEST',
    'PUBLISHED_LOOKUP_UNAVAILABLE', 'PUBLISHED_NO_DOWNLOAD_SERVER', 'PUBLISHED_DOWNLOAD_UNAVAILABLE', 'PUBLISHED_HASH_MISMATCH', 'PUBLISHED_INVALID_HTML', 'PUBLISHED_LOAD_FAILED',
  ] as const) {
    const env = setup();
    env.failLookup(new PublishedLoadError(code));
    await env.run('lookup');
    assert.equal(env.responses.get('lookup'), 'blocked-by-policy');
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
  assert.deepEqual([...env.responses.values()], [null, null, 'blocked-by-policy']);
  assert.equal(env.lookups.length, 0);
});

test('denial and focus loss during review leave the source intact', {timeout: 2000}, async () => {
  const rejected = setup();
  const first = rejected.run('reject');
  rejected.decide((await rejected.review()).id, false);
  await first;
  assert.equal(rejected.responses.get('reject'), 'user-denied');
  assert.equal(rejected.staged(), 0);
  const revoked = setup();
  const second = revoked.run('blur');
  const review = await revoked.review();
  revoked.unfocus();
  revoked.decide(review.id, true);
  await second;
  assert.equal(revoked.responses.get('blur'), 'blocked-by-policy');
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
  assert.equal(env.responses.get('open'), 'blocked-by-policy');
  assert.deepEqual(env.discarded, [target.id]);
  assert.deepEqual(env.state().sessions, [source]);
  assert.equal(env.state().overview, true);
});

test('a verified event from a different coordinate cannot reach review from a named link', async () => {
  for (const coordinate of [
    { kind: 35129, pubkey: user, identifier: appId },
    { kind: 35129, pubkey: publisher, identifier: 'different-app' },
  ]) {
    const env = setup();
    await env.run('substitute', { message: { ...request, url: 'nostr:' + naddrEncode(coordinate) } });
    assert.equal(env.responses.get('substitute'), 'blocked-by-policy');
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
  assert.equal(env.responses.get('lookup-then-busy'), 'blocked-by-policy');
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
  assert.equal(env.responses.get('failed-stage'), 'blocked-by-policy');
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
  assert.equal(env.responses.get('full'), 'blocked-by-policy');
  assert.deepEqual(env.capacity, ['cards']);
  assert.equal(env.lookups.length, 0);
  assert.equal(env.reviews.getSnapshot(), null);
  assert.equal(env.staged(), 0);
});


test('a ninth link open at live-view capacity returns before lookup, review, staging or focus', {timeout: 1000}, async () => {
  const env = setup();
  env.fillViews();
  await env.run('ninth');
  assert.deepEqual(env.capacity, ['views']);
  assert.equal(env.responses.get('ninth'), 'blocked-by-policy');
  assert.equal(env.lookups.length, 0);
  assert.equal(env.reviews.getSnapshot(), null);
  assert.equal(env.staged(), 0);
  assert.deepEqual(env.state().sessions, [source]);
});

test('capacity feedback offers overview while the same caller still has focus', async () => {
  const env = setup();
  env.fillViews();
  await env.run('full');
  assert.equal(env.state().overview, false);
  env.chooseOverview();
  assert.equal(env.state().overview, true);
  const stale = setup();
  stale.fillViews();
  await stale.run('full');
  stale.unfocus();
  stale.chooseOverview();
  assert.equal(stale.state().overview, false);
});

test('the link broker shares the eight resident slots with the real workspace controller', {timeout: 2000}, async t => {
  const {database} = await setupStorage(t);
  const controller = await openWorkspaceController(database.bindWorkspace(storageRegistration()), emptyWorkspace, () => {});
  const residents = Array.from({length: 7}, (_, index) => ({...target, id: 'resident-' + index, appId: 'resident-' + index}));
  for (const card of [...residents, source]) controller.change(openNapplet(controller.getSnapshot().workspace, card));
  await controller.flush();
  const env = setup(undefined, undefined, controller);
  assert.equal(controller.views.getSnapshot().size, 8);
  await env.run('no-room');
  assert.equal(env.responses.get('no-room'), 'blocked-by-policy');
  assert.deepEqual(env.capacity, ['views']);
  assert.equal(env.lookups.length, 0);
  const suspended: string[] = [];
  const oldest = residents[0]!;
  const unbind = controller.views.bind({
    canSuspend: session => session.id === oldest.id,
    trySuspend: session => { if (session.id !== oldest.id) return false; suspended.push(session.id); return true; },
  });
  t.after(unbind);
  const open = env.run('make-room');
  const review = await env.review();
  assert.deepEqual(suspended, []);
  env.decide(review.id, true);
  await until(() => env.state().focusedId === target.id);
  env.ready();
  env.focusTarget();
  await open;
  assert.equal(env.responses.get('make-room'), 'opened');
  assert.deepEqual(suspended, [oldest.id]);
  assert.equal(env.state().sessions.length, 9);
  assert.equal(controller.views.getSnapshot().size, 8);
  assert.ok(controller.views.getSnapshot().has(source.id));
  assert.ok(controller.views.getSnapshot().has(target.id));
  assert.ok(!controller.views.getSnapshot().has(oldest.id));
});

test('losing room during review stops the approved link before staging', {timeout: 1000}, async () => {
  const env = setup();
  const pending = env.run('review-race');
  const review = await env.review();
  env.fillViews();
  env.decide(review.id, true);
  await pending;
  assert.deepEqual(env.capacity, ['views']);
  assert.equal(env.responses.get('review-race'), 'blocked-by-policy');
  assert.equal(env.staged(), 0);
  assert.deepEqual(env.discarded, []);
  assert.equal(env.state().focusedId, source.id);
});

test('a failed final admission discards staged bytes and keeps the original focus', {timeout: 1000}, async () => {
  const env = setup();
  const pending = env.run('commit-race');
  const review = await env.review();
  env.refuseAdmission();
  env.decide(review.id, true);
  await pending;
  assert.deepEqual(env.capacity, ['views']);
  assert.equal(env.responses.get('commit-race'), 'blocked-by-policy');
  assert.equal(env.staged(), 1);
  assert.deepEqual(env.discarded, [target.id]);
  assert.deepEqual(env.state().sessions, [source]);
  assert.equal(env.state().focusedId, source.id);
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
  assert.equal(env.responses.get('stale-diagnostic'), 'blocked-by-policy');
  assert.equal(env.reviews.getSnapshot(), null);
});

for (const domains of [['link'], ['link', 'relay']]) test('published catalog named open with ' + domains.join(' + '), async () => {
  const catalog = { ...target, id: '44444444-4444-4444-8444-444444444444', appId: 'other-catalog' };
  const caller = { ...registration, fixture: 'published' as const, publisher: catalog.publisher,
    appId: catalog.appId, version: catalog.version, sessionId: catalog.id, instanceId: catalog.id, domains };
  const env = setup(openNapplet(emptyWorkspace(), catalog), undefined, undefined, caller);
  const message = {type: 'link.open', id: 'link1', url: 'nostr:' + address, options: {label: 'Untrusted title'}};
  const pending = env.run('portable', {message, source: catalog});
  const review = await env.review();
  assert.equal(review.request.kind, 'published-open');
  if (review.request.kind !== 'published-open') throw Error('Missing publication review');
  assert.equal(review.request.source.id, catalog.id);
  assert.equal(review.request.target.metadata.title, 'Open test title');
  assert.equal(review.request.target.eventId, signed.id);
  assert.deepEqual(env.lookups, [{address: message.url, networkReadGranted: domains.includes('relay')}]);
  env.decide(review.id, true);
  await until(() => env.state().focusedId === target.id);
  env.ready(); env.focusTarget();
  await pending;
  assert.deepEqual(env.responses.get('portable'), {type: 'link.open.result', id: 'link1', status: 'opened'});
  await env.run('private-pin', {source: catalog, message: {type: 'hypergolic.publishedOpen', id: 'old', address, expectedEventId: signed.id, action: 'pin'}});
  assert.equal(env.responses.get('private-pin'), null);
});

test('portable link denials conceal lookup outcomes, respect cancellation and bound repeated prompts', async () => {
  const caller = {...registration, domains: ['link']};
  const env = setup(undefined, undefined, undefined, caller);
  const message = {type: 'link.open', id: 'link1', url: 'nostr:' + address};
  const invalid = {...message, url: 'nostr:naddr1broken'};
  await env.run('invalid', {message: invalid});
  assert.deepEqual(env.responses.get('invalid'), {type: 'link.open.result', id: 'link1', status: 'denied', error: 'invalid-url'});
  assert.equal(env.lookups.length, 0);

  const decline = env.run('decline', {message});
  env.decide((await env.review()).id, false);
  await decline;
  assert.deepEqual(env.responses.get('decline'), {type: 'link.open.result', id: 'link1', status: 'denied', error: 'user-denied'});

  const denied = {type: 'link.open.result', id: 'link1', status: 'denied', error: 'blocked-by-policy'};
  for (const reason of ['PUBLISHED_NOT_FOUND', 'PUBLISHED_REVISION_CONFLICT'] as const) {
    env.failLookup(new PublishedLoadError(reason));
    await env.run(reason, {message});
    assert.deepEqual(env.responses.get(reason), denied);
  }
  await env.run('rate', {message});
  assert.deepEqual(env.responses.get('rate'), denied);
  assert.equal(env.lookups.length, 3);
  assert.deepEqual(env.state().sessions, [source]);
});
