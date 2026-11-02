import {createOutboxSubscriptionBroker} from '../outbox/subscription-broker.ts';
import type {createOutboxSubscriptions} from '../outbox/subscriptions.ts';
import type { OutboxReadService } from '../outbox/read-service';
import type {ConfigBroker} from '../presentation/config-broker.ts';
import type { NotifyBroker } from '../presentation/notify-broker.ts';
import type { RoutingBroker } from '../routing/routing-broker.ts';
import type { RoutingCatalog, CatalogHandler } from '../routing/routing-catalog.ts';
import type { IdentityDataPort } from '../identity/identity-service.ts';
import type { UploadService } from '../uploads/upload-service.ts';
import type { ResourceHost } from '../resources/resource-broker.ts';
import {createRelaySubscriptionBroker,type NativeRelaySubscriptionPort} from './relay-subscription-broker.ts';
import {createRelaySubscriptions} from '../network/relay-subscriptions.ts';
import type { RelayQueryService } from '../network/native-relay-query';
import type { IdentityTransition } from '../security/identity-transition.ts';
import type { ShellDatabase } from '../storage/database.ts';
import { ShellStorageError } from '../storage/ports.ts';
import type { NappletDescriptor } from '../shell/workspace.ts';
import { bundledDescriptor, resolveBundledSession, type BundledVariant } from '../shell/fixtures.ts';
import { createCapabilityBroker, type NativeCapabilityPort } from './capability-broker.ts';
import type { ApprovalOrigin, ApprovalService } from '../security/approval-service.ts';
import { identifier } from '../storage/codec.ts';
import { createPublishedSessionCoordinator, type PreparedPublishedSession, type PublishedSessionDependencies, type PublishedUpdateReview } from '../napplets/published-session.ts';
import type { NappletConsentReview } from '../napplets/first-open-consent.ts';
import type { NativeRegistration } from './capability-protocol.ts';

export interface NativeCapabilityEvent { type: 'capability'; sessionId: string; generation: string; token: string; lane?: 'approval' | 'outbox-subscription' | 'subscription' | 'upload' | 'routing' | 'presentation' | 'configuration' }
export interface RuntimeBinding { readonly configuration: string; receive(event: NativeCapabilityEvent): void; revoke(): void }
export interface PublishedRuntimeBinding { readonly publishedArtifact: string; readonly requestedDomains: readonly string[]; receive(event: NativeCapabilityEvent): void; assertApproval(origin: ApprovalOrigin,domain?:'outbox'): void; assertUpload(origin: ApprovalOrigin): void; revoke(): void }
export interface RuntimeNativePort extends NativeCapabilityPort { newInstanceId(): string; subscriptions?: NativeRelaySubscriptionPort }
export interface RuntimeOwner {
  publishedCapabilities(session: NappletDescriptor): readonly string[] | null;
  open(session: NappletDescriptor): RuntimeBinding;
  descriptor(variant: Exclude<BundledVariant, 'ux-lab'>, number: number): NappletDescriptor;
  openPublishedLink(link: string, signal: AbortSignal, review: (request: NappletConsentReview) => Promise<boolean>): Promise<NappletDescriptor>;
  preparePublishedUpdate(session: NappletDescriptor, signal: AbortSignal,
    reviewUpdate: (request: PublishedUpdateReview) => Promise<boolean>,
    reviewConsent: (request: NappletConsentReview) => Promise<boolean>): Promise<NappletDescriptor | null>;
  openPublished(session: NappletDescriptor, signal: AbortSignal, review: (request: NappletConsentReview) => Promise<boolean>): Promise<PublishedRuntimeBinding>;
  prepareInstalled(handler: CatalogHandler, signal: AbortSignal, review: (request: NappletConsentReview) => Promise<boolean>): Promise<NappletDescriptor>;
  discardPublished(sessionId: string): void;
  revokeAllPublished(): void;
  assertPublishedApproval(origin: ApprovalOrigin,domain?:'outbox'): void;
  assertPublishedUpload(origin: ApprovalOrigin): void;
}

function configurationUser(ready: PreparedPublishedSession): string {
  const host: unknown = JSON.parse(ready.hostInput);
  if (!host || typeof host !== 'object' || !('configuration' in host) || typeof host.configuration !== 'string') throw new ShellStorageError('REVOKED');
  const configuration: unknown = JSON.parse(host.configuration);
  if (!configuration || typeof configuration !== 'object' || !('user' in configuration) || typeof configuration.user !== 'string' || !/^[0-9a-f]{64}$/.test(configuration.user)) throw new ShellStorageError('REVOKED');
  return configuration.user;
}

function capabilityReceiver(database: ShellDatabase, native: RuntimeNativePort,
  approvals: Readonly<{ service: ApprovalService; destinations: () => readonly string[] }> | undefined,
  sessionId: string, configuration: Omit<NativeRegistration, 'generation'>, assertActive: () => void, queries?: RelayQueryService, subscriptions?: ReturnType<typeof createRelaySubscriptions>, resources?: ResourceHost, uploads?: UploadService, identityData?: IdentityDataPort, routing?: RoutingBroker, notify?: NotifyBroker, config?: ConfigBroker, outbox?: OutboxReadService, outboxStreams?:ReturnType<typeof createOutboxSubscriptions>) {
  let generation: string | null = null;
  let broker: ReturnType<typeof createCapabilityBroker> | null = null;
  let streams:ReturnType<typeof createRelaySubscriptionBroker>|null=null;
  let outboxSubscriptions:ReturnType<typeof createOutboxSubscriptionBroker>|null=null;
  return Object.freeze({
    revoke: () => { broker?.revoke(); streams?.revoke(); outboxSubscriptions?.revoke(); if (generation) {routing?.close(generation); notify?.close(generation); config?.close(generation);} },
    assertGeneration: (candidate: string) => { if (generation === null || generation !== candidate) throw new ShellStorageError('REVOKED'); },
    receive(event: NativeCapabilityEvent): void {
      try {
        assertActive();
        if (event.type !== 'capability' || event.sessionId !== sessionId) return;
        identifier(event.token); identifier(event.generation);
        if (generation === null) {
          generation = event.generation;
          const owner={registration:{...configuration,generation},assertActive};
          if(configuration.domains.includes('relay')&&native.subscriptions&&subscriptions)streams=createRelaySubscriptionBroker(native.subscriptions,subscriptions,owner);
          if(configuration.domains.includes('outbox')&&configuration.domains.includes('relay')&&native.subscriptions&&outboxStreams)outboxSubscriptions=createOutboxSubscriptionBroker(native.subscriptions,outboxStreams,owner);
          broker = createCapabilityBroker(database, native, owner, queries, request=>streams?.close(request), resources, identityData, outbox,request=>outboxSubscriptions?.close(request));
        }
        if (event.generation !== generation) return;
        if (event.lane === 'configuration') {
          void config?.dispatch(event.token, {registration: {...configuration, generation}, assertActive});
        } else if (event.lane === 'presentation') {
          void notify?.dispatch(event.token, {registration: {...configuration, generation}, assertActive});
        } else if (event.lane === 'routing') {
          void routing?.dispatch(event.token, {registration: {...configuration, generation}, assertActive});
        } else if (event.lane === 'upload') {
          if (configuration.domains.includes('upload')) uploads?.enqueue(event.token, {...configuration, generation});
        } else if (event.lane === 'approval') {
          if (!configuration.domains.includes('relay')) return;
          approvals?.service.enqueue(event.token, approvals.destinations(), { ...configuration, generation });
        } else if(event.lane==='outbox-subscription')outboxSubscriptions?.dispatch(event.token);
        else if(event.lane==='subscription')streams?.dispatch(event.token);
        else if (event.lane === undefined) void broker!.dispatch(event.token);
      } catch { /* Native expiry or teardown ends unclaimed requests. */ }
    },
  });
}
/** The process-owned database and identity authority remain outside React/WebView props. */
export function createRuntimeOwner(database: ShellDatabase,
  identity: Pick<IdentityTransition, 'getSnapshot' | 'sessionAuthority'>, native: RuntimeNativePort,
  approvals?: Readonly<{ service: ApprovalService; destinations: () => readonly string[] }>,
  published?: Omit<PublishedSessionDependencies, 'identity' | 'database' | 'newInstanceId'>, queries?: RelayQueryService, subscriptions?: ReturnType<typeof createRelaySubscriptions>, resources?: ResourceHost, uploads?: UploadService, identityData?: IdentityDataPort, routing?: Readonly<{broker: RoutingBroker; catalog: RoutingCatalog}>, notify?: NotifyBroker, config?: ConfigBroker, outbox?: OutboxReadService, outboxStreams?:ReturnType<typeof createOutboxSubscriptions>): RuntimeOwner {
  const coordinator = published ? createPublishedSessionCoordinator({
    ...published, identity, database, newInstanceId: () => native.newInstanceId(),
  }) : null;
  const prepared = new Map<string, PreparedPublishedSession>();
  const running = new Map<string, PublishedRuntimeBinding>();
  const exactSession = (session: NappletDescriptor): void => {
    const state = identity.getSnapshot().session.workspace.getSnapshot();
    const current = state.workspace.sessions.find(value => value.id === session.id);
    if (state.error !== null || !current || current.source !== 'published' ||
        current.publisher !== session.publisher || current.appId !== session.appId ||
        current.version !== session.version || current.eventId !== session.eventId || current.title !== session.title) throw new ShellStorageError('REVOKED');
  };
  const bindingFor = (selected: NappletDescriptor, ready: PreparedPublishedSession): PublishedRuntimeBinding => {
    let revoked = false;
    const host = JSON.parse(ready.hostInput) as { configuration: string };
    const configuration = JSON.parse(host.configuration) as Omit<NativeRegistration, 'generation'>;
    const assertActive = () => {
      if (revoked) throw new ShellStorageError('REVOKED');
      ready.assertActive();
      exactSession(selected);
    };
    const receiver = capabilityReceiver(database, native, approvals, selected.id, configuration, assertActive, queries, subscriptions, resources, uploads, identityData, routing?.broker, notify, config, outbox, outboxStreams);
    const binding: PublishedRuntimeBinding = Object.freeze({
      publishedArtifact: ready.hostInput,
      requestedDomains: ready.artifact.manifest.requiredDomains,
      assertApproval(origin: ApprovalOrigin,domain?:'outbox'): void {
        assertActive();
        receiver.assertGeneration(origin.generation);
        if ((domain==='outbox'&&!configuration.domains.includes('outbox'))||!configuration.domains.includes('relay') ||
            origin.sessionId !== configuration.sessionId || origin.epoch !== configuration.epoch ||
            origin.user !== configuration.user || origin.publisher !== configuration.publisher ||
            origin.appId !== configuration.appId || origin.version !== configuration.version ||
            origin.instanceId !== configuration.instanceId) throw new ShellStorageError('REVOKED');
      },
      assertUpload(origin: ApprovalOrigin): void {
        assertActive(); receiver.assertGeneration(origin.generation);
        if (!configuration.domains.includes('upload') || origin.sessionId !== configuration.sessionId || origin.epoch !== configuration.epoch ||
          origin.user !== configuration.user || origin.publisher !== configuration.publisher || origin.appId !== configuration.appId ||
          origin.version !== configuration.version || origin.instanceId !== configuration.instanceId) throw new ShellStorageError('REVOKED');
      },
      revoke(): void {
        if (revoked) return;
        revoked = true; receiver.revoke(); ready.revoke(); approvals?.service.close(selected.id); uploads?.close(selected.id);
        if (running.get(selected.id) === binding) running.delete(selected.id);
      },
      receive: receiver.receive,
    });
    return binding;
  };
  return Object.freeze({
    async openPublishedLink(link: string, signal: AbortSignal, review: (request: NappletConsentReview) => Promise<boolean>) {
      if (!coordinator) throw new ShellStorageError('REVOKED');
      const ready = await coordinator.openLink(link, signal, review);
      const id = ready.descriptor.id;
      if (prepared.has(id) || running.has(id)) { ready.revoke(); throw new ShellStorageError('CONFLICT'); }
      prepared.set(id, ready);
      return ready.descriptor;
    },
    publishedCapabilities(session: NappletDescriptor) {
      exactSession(session);
      return running.get(session.id)?.requestedDomains ?? prepared.get(session.id)?.artifact.manifest.requiredDomains ?? null;
    },
    async preparePublishedUpdate(session: NappletDescriptor, signal: AbortSignal,
      reviewUpdate: (request: PublishedUpdateReview) => Promise<boolean>,
      reviewConsent: (request: NappletConsentReview) => Promise<boolean>) {
      if (!coordinator || session.source !== 'published') throw new ShellStorageError('INVALID_INPUT');
      exactSession(session);
      const ready = await coordinator.prepareUpdate(session, signal, reviewUpdate, reviewConsent);
      if (!ready) { exactSession(session); return null; }
      try {
        exactSession(session);
        ready.assertActive();
        if (prepared.has(ready.descriptor.id) || running.has(ready.descriptor.id)) throw new ShellStorageError('CONFLICT');
        prepared.set(ready.descriptor.id, ready);
        return ready.descriptor;
      } catch (error) { ready.revoke(); throw error; }
    },
    async openPublished(session: NappletDescriptor, signal: AbortSignal, review: (request: NappletConsentReview) => Promise<boolean>) {
      if (!coordinator || session.source !== 'published') throw new ShellStorageError('INVALID_INPUT');
      if (running.has(session.id)) throw new ShellStorageError('CONFLICT');
      let ready = prepared.get(session.id);
      if (ready) prepared.delete(session.id);
      else ready = await coordinator.reopenPinned(session, signal, review);
      try {
        if (ready.descriptor.id !== session.id || ready.descriptor.publisher !== session.publisher || ready.descriptor.appId !== session.appId ||
            ready.descriptor.version !== session.version || ready.descriptor.eventId !== session.eventId ||
            ready.descriptor.title !== session.title) throw new ShellStorageError('CONFLICT');
        exactSession(session);
        ready.assertActive();
        if (routing) {
          const catalogOwner = {user: configurationUser(ready), assertActive: () => {ready.assertActive(); exactSession(session);}};
          const previous = await routing.catalog.list(catalogOwner, {signal});
          await routing.catalog.remember(catalogOwner, ready.artifact, {signal});
          await routing.broker.catalogChanged(catalogOwner, previous.handlers.flatMap(handler => handler.roles.map(role => role.archetype)));
        }
        ready.assertActive(); exactSession(session);
        const binding = bindingFor(session, ready);
        running.set(session.id, binding);
        return binding;
      } catch (error) { ready.revoke(); throw error; }
    },
    async prepareInstalled(handler: CatalogHandler, signal: AbortSignal, review: (request: NappletConsentReview) => Promise<boolean>) {
      if (!coordinator) throw new ShellStorageError('REVOKED');
      const id = native.newInstanceId();
      const descriptor: NappletDescriptor = Object.freeze({id, title: handler.title, publisher: handler.publisher, appId: handler.appId, version: handler.version, source: 'published', eventId: handler.eventId});
      const ready = await coordinator.reopenPinned(descriptor, signal, review);
      if (prepared.has(id) || running.has(id)) {ready.revoke(); throw new ShellStorageError('CONFLICT');}
      prepared.set(id, ready); return ready.descriptor;
    },
    discardPublished(sessionId: string) {
      prepared.get(sessionId)?.revoke(); prepared.delete(sessionId);
      running.get(sessionId)?.revoke(); running.delete(sessionId);
    },
    revokeAllPublished() {
      for (const ready of prepared.values()) ready.revoke();
      for (const binding of running.values()) binding.revoke();
      prepared.clear(); running.clear();
    },
    assertPublishedUpload(origin: ApprovalOrigin) {
      const binding = running.get(origin.sessionId);
      if (!binding) throw new ShellStorageError('REVOKED');
      binding.assertUpload(origin);
    },
    assertPublishedApproval(origin: ApprovalOrigin,domain?:'outbox') {
      const binding = running.get(origin.sessionId);
      if (!binding) throw new ShellStorageError('REVOKED');
      binding.assertApproval(origin,domain);
    },
    descriptor(variant: Exclude<BundledVariant, 'ux-lab'>, number: number): NappletDescriptor {
      const instance = native.newInstanceId();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(instance)) throw new ShellStorageError('INVALID_INPUT');
      const descriptor = bundledDescriptor(variant, number, instance);
      resolveBundledSession(descriptor);
      return descriptor;
    },
    open(session: NappletDescriptor): RuntimeBinding {
    const descriptor = Object.freeze({ ...session });
    const catalog = resolveBundledSession(descriptor);
    const authority = identity.sessionAuthority();
    const configuration = Object.freeze({ sessionId: identifier(session.id), epoch: authority.epoch, user: authority.user, ...catalog });
    let revoked = false;
    const assertActive = (): void => {
      authority.assertActive();
      const state = identity.getSnapshot().session.workspace.getSnapshot();
      const current = state.workspace.sessions.find(value => value.id === descriptor.id);
      if (revoked || state.error !== null || !current || current.publisher !== descriptor.publisher || current.appId !== descriptor.appId ||
          current.version !== descriptor.version || current.source !== descriptor.source || current.title !== descriptor.title) throw new ShellStorageError('REVOKED');
    };
    assertActive();
    const receiver = capabilityReceiver(database, native, approvals, descriptor.id, configuration, assertActive, queries, subscriptions, resources, uploads, identityData, routing?.broker, notify, config, outbox, outboxStreams);
    return Object.freeze({ configuration: JSON.stringify(configuration),
      revoke(): void { revoked = true; receiver.revoke(); approvals?.service.close(descriptor.id); uploads?.close(descriptor.id); },
      receive: receiver.receive,
    });
  } });
}
