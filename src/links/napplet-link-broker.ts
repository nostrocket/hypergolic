import { parseLinkRequest, linkDenied, NAPPLET_LINK_LEASE_MS } from './link-contract.ts';
import { verifiedLaunchMetadata } from '../napplets/verified-launch-metadata.ts';
import { resolveNappletLink, type NappletCoordinate } from '../napplets/resolve-link.ts';
import type { IdentityTransition } from '../security/identity-transition.ts';
import type { NativeCapabilityPort, CapabilityOwner } from '../runtime/capability-broker.ts';
import { decodeNativeRegistration, decodeNativeRequest } from '../runtime/capability-protocol.ts';
import type { RuntimeOwner } from '../runtime/runtime-owner.ts';
import { routingRecord } from '../routing/routing-contract.ts';
import type { RoutingNativePort } from '../routing/routing-port.ts';
import type { RoutingReviewRequest, RoutingReviewService } from '../routing/routing-review.ts';
import { resolveBundledSession } from '../shell/fixtures.ts';
import { conflictsWithPublishedRevision, focusNapplet, openNapplet, showOverview, samePublishedPin, type NappletDescriptor } from '../shell/workspace.ts';
import { ShellStorageError } from '../storage/ports.ts';
import { publishedCapabilityCompatibility } from '../napplets/first-open-consent.ts';
import { assertVerifiedArtifact, releasePublishedArtifact } from '../napplets/verified-artifact.ts';

type Ports = Readonly<{
  identity: Pick<IdentityTransition, 'getSnapshot' | 'subscribe'>;
  runtime: () => Pick<RuntimeOwner, 'resolveNappletLink' | 'prepareNappletLink' | 'publishedReadyGeneration' | 'discardPublished'> | null;
  capability: NativeCapabilityPort;
  native: RoutingNativePort;
  reviews: RoutingReviewService;
  reportCapacity(reason: 'cards' | 'views', openOverview: () => void): void;
}>;
export type NappletLinkBroker = ReturnType<typeof createNappletLinkBroker>;

const cancelled = () => new ShellStorageError('REVOKED');
const sameTarget = (left: NappletDescriptor, right: NappletDescriptor) => left.source === 'published'
  ? samePublishedPin(left, right)
  : left.source === right.source && left.publisher === right.publisher && left.appId === right.appId &&
    left.eventId === right.eventId && left.version === right.version && left.title === right.title;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

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
  const sourceIdentity = source.source === 'bundled' ? resolveBundledSession(source) : {...source, fixture: 'published'};
  if (JSON.stringify(captured.registration) !== JSON.stringify(origin) || source.id !== origin.sessionId ||
      sourceIdentity.fixture !== origin.fixture || sourceIdentity.appId !== origin.appId ||
      sourceIdentity.publisher !== origin.publisher || sourceIdentity.version !== origin.version) throw cancelled();
  const { type, id, message, revision, focusRevision } = routingRecord(captured.request,
    ['type', 'id', 'message', 'revision', 'focusRevision']);
  if (type !== 'routing.call' || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id) ||
      !integer(revision) || !integer(focusRevision)) throw cancelled();
  const link = parseLinkRequest(message);
  if (!origin.domains.includes('link') || !link.url.startsWith('nostr:naddr1')) throw cancelled();
  return {origin, id, revision, focusRevision, link};
}

type Captured = ReturnType<typeof capture>;
type Workspace = ReturnType<Ports['identity']['getSnapshot']>['session']['workspace'];
type Launch = Readonly<{
  source: NappletDescriptor; workspace: Workspace; captured: Captured; coordinate: NappletCoordinate;
  runtime: NonNullable<ReturnType<Ports['runtime']>>; live: () => void;
}>;
type LaunchOutcome = 'opened' | 'rejected' | 'failed';
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
        !ports.native.mayDeliver(origin.generation, revision, 'link')) throw cancelled();
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

function reportCapacity(ports: Ports, launch: Launch, reason: 'cards' | 'views') {
  const {workspace, captured, source} = launch;
  ports.reportCapacity(reason, () => {
    const current = ports.identity.getSnapshot();
    const state = workspace.getSnapshot();
    if (current.phase !== 'ready' || current.session.workspace !== workspace ||
        current.session.epoch !== captured.origin.epoch || current.session.vault.selectedPubkey !== captured.origin.user ||
        state.error !== null || state.workspace.overview || state.workspace.focusedId !== source.id ||
        ports.native.reviewRevision(captured.origin.generation, captured.revision) !== captured.focusRevision) return;
    workspace.change(showOverview(state.workspace));
  });
}

function reviewLaunch(ports: Ports, launch: Launch, target: Extract<RoutingReviewRequest, {kind: 'published-open'}>['target'],
  attempt: Attempt, active: () => void) {
  return async (changesAccess: boolean, legacyReadOnlyAvailable = false) => {
    active();
    const decision = await ports.reviews.ask(Object.freeze({ kind: 'published-open', origin: launch.captured.origin,
      source: launch.source, changesAccess, target, ...(legacyReadOnlyAvailable ? {legacyReadOnlyAvailable: true as const} : {}) }), active, () => true);
    active();
    attempt.declined = !decision.allow;
    return decision.allow && decision.legacyReadOnly ? 'legacy-read-only-v1' as const : decision.allow;
  };
}

async function waitForMount(ports: Ports, launch: Launch, target: NappletDescriptor, active: () => void,
  signal: AbortSignal): Promise<LaunchOutcome> {
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
  signal: AbortSignal): Promise<LaunchOutcome> {
  const { link } = launch.captured;
  const { runtime, workspace } = launch;
  const matches = () => workspace.getSnapshot().workspace.sessions.filter(session =>
    session.source === 'published' && session.publisher === launch.coordinate.pubkey &&
    session.appId === launch.coordinate.identifier);
  function requireRoom(candidates: readonly NappletDescriptor[]) {
    if (candidates.length === 0 && workspace.getSnapshot().workspace.sessions.length >= 64) {
      reportCapacity(ports, launch, 'cards');
      throw cancelled();
    }
    if (!workspace.canLoadView(candidates.map(session => session.id))) {
      reportCapacity(ports, launch, 'views');
      throw cancelled();
    }
  }
  requireRoom(matches());
  const networkReadGranted = launch.captured.origin.domains.includes('relay');
  const artifact = await runtime.resolveNappletLink(link.url, signal, active, networkReadGranted);
  try {
    active();
    assertVerifiedArtifact(artifact);
    const { manifest, aggregateHash: version } = artifact;
    const appId = manifest.tags.find(tag => tag[0] === 'd')?.[1];
    const { pubkey: publisher, eventId } = manifest;
    if (appId !== launch.coordinate.identifier || publisher !== launch.coordinate.pubkey) throw new Error('Unverified launch revision');

    const exact = (session: NappletDescriptor) => session.eventId === eventId && session.version === version;
    const installed = matches();
    // Different saved revisions continue through the ordinary explicit update flow.
    const coordinate = {publisher, appId, eventId, version};
    if (conflictsWithPublishedRevision(workspace.getSnapshot().workspace, coordinate)) return 'failed';
    const loaded = installed.find(session => runtime.publishedReadyGeneration(session) !== null);
    const existing = loaded ?? installed[0];
    const candidates = existing ? [existing] : [];
    requireRoom(candidates);
    const requiredDomains = Object.freeze([...manifest.requiredDomains].sort());
    const optionalDomains = Object.freeze([...manifest.optionalDomains].sort());
    const { unsupportedDomains, unsupportedOptionalDomains } = publishedCapabilityCompatibility(requiredDomains, optionalDomains);
    const review = reviewLaunch(ports, launch, Object.freeze({ publisher, appId, eventId, version, metadata: verifiedLaunchMetadata(artifact),
      requiredDomains, optionalDomains, unsupportedDomains, unsupportedOptionalDomains }), attempt, active);
    let next: NappletDescriptor;
    if (loaded) {
      if (!await review(false)) return 'rejected';
      next = loaded;
    } else {
      next = await runtime.prepareNappletLink(artifact, signal, active, async (changesAccess, legacyAvailable) => {
        const decision = await review(changesAccess, legacyAvailable);
        if (decision) requireRoom(candidates);
        return decision;
      }, existing);
      attempt.staged = next;
    }
    active();
    const current = workspace.getSnapshot().workspace;
    if (conflictsWithPublishedRevision(current, coordinate) ||
        (existing ? !current.sessions.some(session => session.id === existing.id && sameTarget(session, existing))
          : matches().length > 0)) return 'failed';
    if (!exact(next) || next.source !== 'published' || next.publisher !== publisher || next.appId !== appId) throw new Error('Prepared launch mismatch');
    requireRoom(candidates);
    if (!workspace.admitView(next.id)) {
      reportCapacity(ports, launch, 'views');
      return 'failed';
    }
    attempt.created = !existing;
    attempt.target = next;
    const opened = openNapplet(current, next);
    workspace.change(existing && !loaded ? {...opened, sessions: opened.sessions.map(session => session.id === next.id ? next : session)} : opened);
    await workspace.flush();
    return waitForMount(ports, launch, next, active, signal);
  } finally { releasePublishedArtifact(artifact); }
}

async function runLaunch(ports: Ports, launch: Launch): Promise<LaunchOutcome> {
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
  const deadline = setTimeout(abort, NAPPLET_LINK_LEASE_MS - 5_000);
  const release: (() => void)[] = [];
  let status: LaunchOutcome = 'failed';
  try {
    release.push(ports.identity.subscribe(check), workspace.subscribe(check));
    release.push(ports.native.subscribe(check));
    active();
    ports.reviews.assertAvailable();
    status = await openExact(ports, launch, attempt, active, signal);
    if (status === 'opened') active();
    return status;
  } catch {
    status = attempt.declined ? 'rejected' : 'failed';
    return status;
  } finally {
    clearTimeout(deadline);
    release.forEach(unsubscribe => unsubscribe());
    controller.abort();
    if (status !== 'opened') restoreWorkspace(ports, launch, attempt);
  }
}

/** One reviewed exact launch per process. The captured source remains the only reply recipient. */
export function createNappletLinkBroker(ports: Ports) {
  let pending = false;
  let linkRequests: {generation: string; time: number}[] = [];
  const launch = async (request: Launch): Promise<LaunchOutcome> => {
    if (pending) return 'failed';
    const now = performance.now();
    linkRequests = linkRequests.filter(entry => now - entry.time < 60_000);
    const generation = request.captured.origin.generation;
    if (linkRequests.length >= 12 || linkRequests.filter(entry => entry.generation === generation).length >= 3) return 'failed';
    linkRequests.push({generation, time: now});
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
      let coordinate: NappletCoordinate | null = null;
      try { coordinate = resolveNappletLink(captured.link.url); }
      catch { /* Invalid coordinates never reach the verifier. */ }
      const status = coordinate ? await launch({ captured, coordinate, runtime, source, ...scope }) : 'unavailable';
      // Account or renderer revocation suppresses delivery, including after launch.
      scope.live();
      response = JSON.stringify({ type: 'routing.call.result', id: captured.id, response: status === 'opened' ? {type: 'link.open.result', id: captured.link.id, status: 'opened'}
        : linkDenied(captured.link.id, !coordinate ? 'invalid-url' : status === 'rejected' ? 'user-denied' : 'blocked-by-policy') });
    } catch { /* Revoked native leases have no live recipient. */ }
    finally { if (claimed) ports.capability.finish(token, response); }
  } });
}
