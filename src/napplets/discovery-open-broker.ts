import { naddrEncode } from 'nostr-tools/nip19';
import { resolveNappletLink, type NappletCoordinate } from './resolve-link.ts';
import type { IdentityTransition } from '../security/identity-transition.ts';
import type { NativeCapabilityPort, CapabilityOwner } from '../runtime/capability-broker.ts';
import { decodeNativeRegistration, decodeNativeRequest } from '../runtime/capability-protocol.ts';
import type { RuntimeOwner } from '../runtime/runtime-owner.ts';
import { routingRecord } from '../routing/routing-contract.ts';
import type { RoutingNativePort } from '../routing/routing-port.ts';
import type { RoutingReviewRequest, RoutingReviewService } from '../routing/routing-review.ts';
import { resolveBundledSession } from '../shell/fixtures.ts';
import { isDiscoveryEntry } from './discovery-entry.ts';
import { focusNapplet, openNapplet, type NappletDescriptor } from '../shell/workspace.ts';
import { ShellStorageError } from '../storage/ports.ts';
import { DISCOVERY_LEASE_MS, parseDiscoveryOpen, type DiscoveryOpenStatus } from './discovery-open-contract.ts';
import { publishedCapabilityCompatibility } from './first-open-consent.ts';
import { assertVerifiedArtifact } from './verified-artifact.ts';
import { PublishedLoadError } from './loader.ts';

type Ports = Readonly<{
  identity: Pick<IdentityTransition, 'getSnapshot' | 'subscribe'>;
  runtime: () => Pick<RuntimeOwner, 'resolveDiscovered' | 'prepareDiscovered' | 'publishedReadyGeneration' | 'discardPublished'> | null;
  capability: NativeCapabilityPort;
  native: RoutingNativePort;
  reviews: RoutingReviewService;
}>;
export type DiscoveryOpenBroker = ReturnType<typeof createDiscoveryOpenBroker>;

const cancelled = () => new ShellStorageError('REVOKED');
const sameTarget = (left: NappletDescriptor, right: NappletDescriptor) => left.source === right.source &&
  left.publisher === right.publisher && left.appId === right.appId && left.eventId === right.eventId &&
  left.version === right.version && left.title === right.title;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function lookupStatus(error: unknown): DiscoveryOpenStatus {
  if (error instanceof PublishedLoadError) {
    switch (error.code) {
      case 'PUBLISHED_REVISION_CHANGED': return 'refresh-required';
      case 'PUBLISHED_NOT_FOUND': return 'not-found';
      case 'PUBLISHED_UNSUPPORTED_MANIFEST': return 'unsupported';
      case 'PUBLISHED_REVISION_CONFLICT': return 'conflict';
    }
  }
  return 'failed';
}

function pause(signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
    const timer = setTimeout(done, 50);
    signal.addEventListener('abort', done, { once: true });
  });
}

function capture(raw: string, owner: CapabilityOwner, source: NappletDescriptor) {
  const captured = decodeNativeRequest(raw);
  const origin = decodeNativeRegistration(owner.registration);
  if (!isDiscoveryEntry(source)) throw cancelled();
  const sourceIdentity = source.source === 'bundled' ? resolveBundledSession(source) : {...source, fixture: 'published'};
  if (JSON.stringify(captured.registration) !== JSON.stringify(origin) || source.id !== origin.sessionId ||
      sourceIdentity.fixture !== origin.fixture || sourceIdentity.appId !== origin.appId ||
      sourceIdentity.publisher !== origin.publisher || sourceIdentity.version !== origin.version) throw cancelled();
  const { type, id, message, revision, focusRevision } = routingRecord(captured.request,
    ['type', 'id', 'message', 'revision', 'focusRevision']);
  if (type !== 'routing.call' || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id) ||
      !integer(revision) || !integer(focusRevision)) throw cancelled();
  return { origin, id, revision, focusRevision, request: parseDiscoveryOpen(message) };
}

function canonicalCoordinate(address: string): NappletCoordinate | null {
  try {
    const coordinate = resolveNappletLink(address);
    const { kind, pubkey, identifier, relayHints } = coordinate;
    return relayHints.length === 0 && naddrEncode({ kind, pubkey, identifier }) === address ? coordinate : null;
  } catch { return null; }
}

type Captured = ReturnType<typeof capture>;
type Workspace = ReturnType<Ports['identity']['getSnapshot']>['session']['workspace'];
type Launch = Readonly<{
  source: NappletDescriptor; workspace: Workspace; captured: Captured; coordinate: NappletCoordinate;
  runtime: NonNullable<ReturnType<Ports['runtime']>>; live: () => void;
}>;
type Attempt = {
  target: NappletDescriptor | null;
  staged: NappletDescriptor | null;
  created: boolean;
  declined: boolean;
};

function requestScope(ports: Ports, captured: Captured, token: string, owner: CapabilityOwner) {
  const { origin, revision } = captured;
  const workspace = ports.identity.getSnapshot().session.workspace;
  const live = () => {
    const state = ports.native.state(), current = ports.identity.getSnapshot();
    if (current.phase !== 'ready' || current.session.workspace !== workspace ||
        current.session.epoch !== origin.epoch || current.session.vault.selectedPubkey !== origin.user ||
        state.user !== origin.user || state.epoch !== origin.epoch || state.revision !== revision ||
        !state.available || !ports.capability.isActive(token) ||
        !ports.native.mayDeliver(origin.generation, revision, 'published-open')) throw cancelled();
    owner.assertActive();
  };
  return { workspace, live };
}

function restoreWorkspace(ports: Ports, launch: Launch, attempt: Attempt) {
  const { target, staged, created } = attempt;
  const { runtime, source, workspace } = launch;
  if (staged) runtime.discardPublished(staged.id);
  if (!target || ports.identity.getSnapshot().session.workspace !== workspace || workspace.getSnapshot().error !== null) return;
  const current = workspace.getSnapshot().workspace;
  const selected = current.focusedId === target.id && !current.overview;
  if (!selected && !created) return;
  const sessions = created ? current.sessions.filter(session => session.id !== target.id) : current.sessions;
  const focusedId = created && current.focusedId === target.id ? null : current.focusedId;
  const pruned = { ...current, sessions, focusedId, overview: current.overview || focusedId === null };
  workspace.change(selected ? focusNapplet(pruned, source.id) : pruned);
}

function reviewLaunch(ports: Ports, launch: Launch, target: Extract<RoutingReviewRequest, {kind: 'published-open'}>['target'],
  attempt: Attempt, active: () => void) {
  return async (changesAccess: boolean) => {
    active();
    const decision = await ports.reviews.ask(Object.freeze({ kind: 'published-open', origin: launch.captured.origin,
      source: launch.source, changesAccess, target }), active, () => true);
    active();
    attempt.declined = !decision.allow;
    return decision.allow;
  };
}

async function waitForMount(ports: Ports, launch: Launch, target: NappletDescriptor, active: () => void,
  signal: AbortSignal): Promise<DiscoveryOpenStatus> {
  const deadline = Date.now() + 28_000;
  while (Date.now() < deadline) {
    active();
    const generation = launch.runtime.publishedReadyGeneration(target);
    if (generation && ports.native.mayReview(generation, launch.captured.revision)) return 'opened';
    await pause(signal);
  }
  return 'failed';
}

async function openExact(ports: Ports, launch: Launch, attempt: Attempt, active: () => void,
  signal: AbortSignal): Promise<DiscoveryOpenStatus> {
  const { request } = launch.captured;
  const { runtime, workspace } = launch;
  const artifact = await runtime.resolveDiscovered(request.address, request.expectedEventId, signal, active);
  active();
  assertVerifiedArtifact(artifact);
  const { manifest, aggregateHash: version } = artifact;
  const appId = manifest.tags.find(tag => tag[0] === 'd')?.[1];
  const { pubkey: publisher, eventId } = manifest;
  if (appId !== launch.coordinate.identifier || publisher !== launch.coordinate.pubkey ||
      eventId !== request.expectedEventId) throw new Error('Unverified launch revision');

  const matches = () => workspace.getSnapshot().workspace.sessions.filter(session =>
    session.source === 'published' && session.publisher === publisher && session.appId === appId);
  const exact = (session: NappletDescriptor) => session.eventId === eventId && session.version === version;
  const installed = matches();
  // Different saved revisions continue through the ordinary explicit update flow.
  if (installed.some(session => !exact(session))) return 'conflict';
  const loaded = installed.find(session => runtime.publishedReadyGeneration(session) !== null);
  const existing = loaded ?? installed[0];
  const requiredDomains = Object.freeze([...manifest.requiredDomains].sort());
  const optionalDomains = Object.freeze([...manifest.optionalDomains].sort());
  const { unsupportedDomains, unsupportedOptionalDomains } = publishedCapabilityCompatibility(requiredDomains, optionalDomains);
  const review = reviewLaunch(ports, launch, Object.freeze({ publisher, appId, eventId, version,
    requiredDomains, optionalDomains, unsupportedDomains, unsupportedOptionalDomains }), attempt, active);
  let next: NappletDescriptor;
  if (loaded) {
    if (!await review(false)) return 'rejected';
    next = loaded;
  } else {
    if (!existing && workspace.getSnapshot().workspace.sessions.length >= 64) return 'unavailable';
    next = await runtime.prepareDiscovered(artifact, signal, active, review, existing);
    attempt.staged = next;
  }
  active();
  const current = workspace.getSnapshot().workspace;
  if (matches().some(session => !exact(session)) ||
      (existing ? !current.sessions.some(session => session.id === existing.id && sameTarget(session, existing))
        : matches().length > 0 || current.sessions.length >= 64)) return 'conflict';
  if (!exact(next) || next.source !== 'published' || next.publisher !== publisher || next.appId !== appId) throw new Error('Prepared launch mismatch');
  attempt.created = !existing;
  attempt.target = next;
  workspace.change(openNapplet(current, next));
  await workspace.flush();
  return waitForMount(ports, launch, next, active, signal);
}

async function runLaunch(ports: Ports, launch: Launch): Promise<DiscoveryOpenStatus> {
  const { source, workspace, captured, live } = launch;
  const { origin, revision, focusRevision } = captured;
  const controller = new AbortController();
  const { signal } = controller;
  const attempt: Attempt = { target: null, staged: null, created: false, declined: false };
  const active = () => {
    live();
    const current = workspace.getSnapshot();
    // The source owns review and commit. The selected target takes focus only after commit.
    const focused = attempt.target ?? source;
    if (signal.aborted || current.error !== null || current.workspace.overview ||
        current.workspace.focusedId !== focused.id ||
        !current.workspace.sessions.some(session => session.id === focused.id && sameTarget(session, focused)) ||
        (attempt.target === null && ports.native.reviewRevision(origin.generation, revision) !== focusRevision)) throw cancelled();
  };
  const abort = () => { controller.abort(); ports.reviews.refresh(); };
  const check = () => { try { active(); } catch { abort(); } };
  const deadline = setTimeout(abort, DISCOVERY_LEASE_MS - 5_000);
  const release: (() => void)[] = [];
  let status: DiscoveryOpenStatus = 'failed';
  try {
    release.push(ports.identity.subscribe(check), workspace.subscribe(check));
    release.push(ports.native.subscribe(check));
    active();
    status = await openExact(ports, launch, attempt, active, signal);
    if (status === 'opened') active();
    return status;
  } catch (error) {
    status = signal.aborted || error instanceof ShellStorageError && error.code === 'REVOKED'
      ? 'cancelled' : attempt.declined ? 'rejected' : lookupStatus(error);
    return status;
  } finally {
    clearTimeout(deadline);
    release.forEach(unsubscribe => unsubscribe());
    controller.abort();
    if (status !== 'opened') restoreWorkspace(ports, launch, attempt);
  }
}

/** One reviewed exact launch per process. The captured source remains the only reply recipient. */
export function createDiscoveryOpenBroker(ports: Ports) {
  let pending = false;
  const launch = async (request: Launch): Promise<DiscoveryOpenStatus> => {
    if (pending) return 'busy';
    pending = true;
    try { return await runLaunch(ports, request); }
    finally { pending = false; }
  };
  return Object.freeze({ async dispatch(token: string, owner: CapabilityOwner, source: NappletDescriptor): Promise<void> {
    let claimed = false;
    let response: string | null = null;
    try {
      const raw = ports.capability.take(token);
      if (raw === null) return;
      claimed = true;
      const captured = capture(raw, owner, source);
      const runtime = ports.runtime();
      if (!runtime) return;
      const scope = requestScope(ports, captured, token, owner);
      scope.live();
      const coordinate = canonicalCoordinate(captured.request.address);
      const status = coordinate ? await launch({ captured, coordinate, runtime, source, ...scope }) : 'unavailable';
      // Account or renderer revocation suppresses delivery, including after launch.
      scope.live();
      response = JSON.stringify({ type: 'routing.call.result', id: captured.id, response: status });
    } catch { /* Revoked native leases have no live recipient. */ }
    finally { if (claimed) ports.capability.finish(token, response); }
  } });
}
