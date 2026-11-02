import { naddrEncode } from 'nostr-tools/nip19';
import type { IdentityTransition } from '../security/identity-transition.ts';
import type { ShellDatabase } from '../storage/database.ts';
import type { SQLiteModule, TrustedApp } from '../storage/ports.ts';
import type { NappletDescriptor } from '../shell/workspace.ts';
import { requestFirstOpenConsent, type NappletConsentReview } from './first-open-consent.ts';
import { loadPublishedArtifact, type PublishedArtifactSource } from './loader.ts';
import { openPublishedArtifactCache } from './published-artifact-cache.ts';
import { descriptorForPublishedArtifact, publishedHostInput } from './published-host-input.ts';
import { stageAdmittedPublishedArtifact } from './admitted-transfer.ts';
import type { NativePublishedTransferPort } from './native-transfer.ts';
import { assertVerifiedArtifact, type VerifiedNappletArtifact } from './verified-artifact.ts';

export class PublishedSessionError extends Error {
  readonly code = 'PUBLISHED_SESSION_FAILED';
  constructor() { super('The published napplet could not be opened'); this.name = 'PublishedSessionError'; }
}
const fail = (): never => { throw new PublishedSessionError(); };
const HEX64 = /^[0-9a-f]{64}$/;
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface PreparedPublishedSession {
  readonly descriptor: NappletDescriptor;
  readonly hostInput: string;
  readonly artifact: VerifiedNappletArtifact;
  /** Check the identity, accepted grant, and retained native-session lifetime. */
  assertActive(): void;
  revoke(): void;
}
export type PublishedUpdateReview = Readonly<{
  publisher: string; appId: string; previousEventId: string; nextEventId: string;
  previousVersion: string; nextVersion: string; domains: readonly string[];
}>;

export interface PublishedSessionDependencies {
  readonly identity: Pick<IdentityTransition, 'sessionAuthority' | 'getSnapshot'>;
  readonly database: ShellDatabase;
  readonly sqlite: SQLiteModule;
  readonly source: PublishedArtifactSource;
  readonly lookupRelays: () => readonly string[];
  readonly native: NativePublishedTransferPort;
  readonly newInstanceId: () => string;
}

function identifier(artifact: VerifiedNappletArtifact): string {
  return artifact.manifest.tags.find(tag => tag[0] === 'd')?.[1] ?? fail();
}

type PrepareRequest = Readonly<{ link?: string; pinned?: NappletDescriptor;
  candidate?: VerifiedNappletArtifact; updateOf?: NappletDescriptor }>;
type ConsentReview = (request: NappletConsentReview) => Promise<boolean>;
type SessionAuthority = ReturnType<PublishedSessionDependencies['identity']['sessionAuthority']>;

async function loadSessionArtifact(ports: PublishedSessionDependencies, request: PrepareRequest,
  link: string, authority: SessionAuthority, signal: AbortSignal,
  active: () => void): Promise<VerifiedNappletArtifact> {
  const selected = request.pinned;
  let artifact: VerifiedNappletArtifact | null = request.candidate ?? null;
  if (artifact) assertVerifiedArtifact(artifact);
  if (selected) {
    const owner: TrustedApp = Object.freeze({ user: authority.user, publisher: selected.publisher,
      appId: selected.appId, assertActive: active });
    const cache = await openPublishedArtifactCache(ports.sqlite, {
      owner, epoch: authority.epoch, currentEpoch: () => ports.identity.getSnapshot().session.epoch,
    });
    try { artifact = await cache.get(selected.appId, selected.eventId!, { signal }); }
    finally { await cache.close(); }
    active();
  }
  if (!artifact) artifact = await loadPublishedArtifact(link, { source: ports.source,
    lookupRelays: ports.lookupRelays(), signal, assertActive: active,
    ...(selected ? { pinnedEventId: selected.eventId! } : {}) });
  active();
  return artifact;
}

async function preparePublishedSession(ports: PublishedSessionDependencies, request: PrepareRequest,
  externalSignal: AbortSignal, review: ConsentReview): Promise<PreparedPublishedSession> {
  const authority = ports.identity.sessionAuthority();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (externalSignal.aborted) cancel();
  else externalSignal.addEventListener('abort', cancel, { once: true });
  const active = () => {
    if (controller.signal.aborted) fail();
    try { authority.assertActive(); } catch { fail(); }
    if (controller.signal.aborted) fail();
  };
  let registered: string | null = null;
  let success = false;
  try {
    active();
    const selected = request.pinned;
    const updateOf = request.updateOf;
    const opensLink = request.link !== undefined && selected === undefined && request.candidate === undefined && updateOf === undefined;
    const reopensPin = request.link === undefined && selected !== undefined && request.candidate === undefined && updateOf === undefined;
    const appliesUpdate = request.link === undefined && selected === undefined && request.candidate !== undefined && updateOf !== undefined;
    if (!opensLink && !reopensPin && !appliesUpdate) fail();
    if (selected && (selected.source !== 'published' || !HEX64.test(selected.publisher) ||
        !HEX64.test(selected.version) || !HEX64.test(selected.eventId ?? '') || !selected.appId)) fail();
    const coordinate = selected ?? updateOf;
    const link = request.link ?? naddrEncode({ kind: 35129, pubkey: coordinate!.publisher, identifier: coordinate!.appId });
    const artifact = await loadSessionArtifact(ports, request, link, authority, controller.signal, active);
    const id = selected?.id ?? ports.newInstanceId();
    if (!SESSION.test(id)) fail();
    const descriptor = descriptorForPublishedArtifact(artifact, id);
    if (selected && (selected.publisher !== descriptor.publisher || selected.appId !== descriptor.appId ||
        selected.version !== descriptor.version || selected.eventId !== descriptor.eventId ||
        selected.title !== descriptor.title)) fail();
    if (updateOf && (updateOf.source !== 'published' || !HEX64.test(updateOf.version) ||
        !HEX64.test(updateOf.eventId ?? '') || updateOf.publisher !== descriptor.publisher ||
        updateOf.appId !== descriptor.appId || updateOf.eventId === descriptor.eventId)) fail();
    const owner: TrustedApp = Object.freeze({ user: authority.user, publisher: descriptor.publisher,
      appId: identifier(artifact), assertActive: active });
    const grant = ports.database.bindApp(owner);
    let admission;
    try {
      admission = await requestFirstOpenConsent(artifact, owner, grant.port, controller.signal, active, review);
    } finally { grant.revoke(); }
    active();
    const cache = await openPublishedArtifactCache(ports.sqlite, {
      owner, epoch: authority.epoch, currentEpoch: () => ports.identity.getSnapshot().session.epoch,
    });
    try { await cache.put(artifact, { signal: controller.signal }); }
    finally { await cache.close(); }
    active();
    if (!ports.native.registerPublishedSession(id)) fail();
    registered = id;
    const handle = await stageAdmittedPublishedArtifact(admission, artifact, id, ports.native,
      controller.signal, active);
    active();
    const hostInput = publishedHostInput(artifact, admission, descriptor, authority, handle);
    success = true;
    return Object.freeze({ descriptor, hostInput, artifact,
      assertActive: () => { active(); admission.assertActive(); },
      revoke: () => { controller.abort(); ports.native.revokePublishedSession(id); },
    });
  } catch {
    return fail();
  }
  finally {
    externalSignal.removeEventListener('abort', cancel);
    if (!success) {
      controller.abort();
      if (registered) try { ports.native.revokePublishedSession(registered); } catch { /* Native owner also expires. */ }
    }
  }
}

async function preparePublishedUpdate(ports: PublishedSessionDependencies, selected: NappletDescriptor,
  signal: AbortSignal, reviewUpdate: (request: PublishedUpdateReview) => Promise<boolean>,
  reviewConsent: ConsentReview): Promise<PreparedPublishedSession | null> {
  if (selected.source !== 'published' || !HEX64.test(selected.publisher) ||
      !HEX64.test(selected.version) || !HEX64.test(selected.eventId ?? '') || !selected.appId) fail();
  const authority = ports.identity.sessionAuthority();
  const active = () => { if (signal.aborted) fail(); authority.assertActive(); if (signal.aborted) fail(); };
  active();
  const link = naddrEncode({ kind: 35129, pubkey: selected.publisher, identifier: selected.appId });
  const owner: TrustedApp = Object.freeze({ user: authority.user, publisher: selected.publisher,
    appId: selected.appId, assertActive: active });
  const cache = await openPublishedArtifactCache(ports.sqlite, {
    owner, epoch: authority.epoch, currentEpoch: () => ports.identity.getSnapshot().session.epoch,
  });
  let previous: VerifiedNappletArtifact | null;
  try { previous = await cache.get(selected.appId, selected.eventId!, { signal }); }
  finally { await cache.close(); }
  active();
  if (!previous) previous = await loadPublishedArtifact(link, { source: ports.source,
    lookupRelays: ports.lookupRelays(), signal, assertActive: active, pinnedEventId: selected.eventId! });
  active();
  const previousDescriptor = descriptorForPublishedArtifact(previous, selected.id);
  if (previousDescriptor.publisher !== selected.publisher || previousDescriptor.appId !== selected.appId ||
      previousDescriptor.eventId !== selected.eventId || previousDescriptor.version !== selected.version ||
      previousDescriptor.title !== selected.title) fail();
  const candidate = await loadPublishedArtifact(link, { source: ports.source,
    lookupRelays: ports.lookupRelays(), signal, assertActive: active });
  active();
  if (candidate.manifest.eventId === selected.eventId) return null;
  if (candidate.manifest.created_at <= previous.manifest.created_at ||
      candidate.manifest.pubkey !== selected.publisher ||
      candidate.manifest.tags.find(tag => tag[0] === 'd')?.[1] !== selected.appId) fail();
  const request = Object.freeze({ publisher: selected.publisher, appId: selected.appId,
    previousEventId: selected.eventId!, nextEventId: candidate.manifest.eventId,
    previousVersion: selected.version, nextVersion: candidate.aggregateHash,
    domains: Object.freeze([...candidate.manifest.requiredDomains].sort()) });
  if (await reviewUpdate(request) !== true) fail();
  active();
  return preparePublishedSession(ports, { candidate, updateOf: selected }, signal, reviewConsent);
}

/** This coordinator is process-owned; no reference to it is passed into guest content. */
export function createPublishedSessionCoordinator(ports: PublishedSessionDependencies) {
  return Object.freeze({
    openLink: async (link: string, signal: AbortSignal, review: ConsentReview) =>
      (await preparePublishedSession(ports, { link }, signal, review)) ?? fail(),
    reopenPinned: async (descriptor: NappletDescriptor, signal: AbortSignal, review: ConsentReview) =>
      (await preparePublishedSession(ports, { pinned: descriptor }, signal, review)) ?? fail(),
    prepareUpdate: (selected: NappletDescriptor, signal: AbortSignal,
      reviewUpdate: (request: PublishedUpdateReview) => Promise<boolean>, reviewConsent: ConsentReview) =>
      preparePublishedUpdate(ports, selected, signal, reviewUpdate, reviewConsent),
  });
}
