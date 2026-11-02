import { decodeNativeRegistration, decodeNativeRequest, CAPABILITY_LIMITS, type NativeRegistration } from '../runtime/capability-protocol.ts';
import type { NativeCapabilityPort, CapabilityOwner } from '../runtime/capability-broker.ts';
import { ShellStorageError, type TrustedUser } from '../storage/ports.ts';
import { parseRoutingMessage, routingRecord, routingText, ROUTING_LIMITS, type IntentRequest, type RoutingMessage } from './routing-contract.ts';
import type { CatalogHandler, CatalogSnapshot, RoutingCatalog } from './routing-catalog.ts';
import type { RoutingNativePort } from './routing-port.ts';
import { RoutingChannels } from './routing-channels.ts';
import { RoutingReviewService } from './routing-review.ts';
export type RoutingTargetPort = Readonly<{ activate(handler: CatalogHandler, request: IntentRequest, signal: AbortSignal, assertActive: () => void, origin: NativeRegistration, revision: number): Promise<string> }>;
type Endpoint = { registration: NativeRegistration; assertActive(): void; seen: Set<string>; topics: Set<string> };
const revoked = (): never => { throw new ShellStorageError('REVOKED'); };
const sameHandler = (a: Readonly<{ publisher: string; appId: string; eventId: string }>, b: Readonly<{ publisher: string; appId: string; eventId: string }>) => a.publisher === b.publisher && a.appId === b.appId && a.eventId === b.eventId;
const actions = (handler: CatalogHandler, role: string): readonly string[] => {
  const conventions = handler.roles.find(value => value.archetype === role)?.conventions ?? [];
  return conventions.length ? [...new Set(conventions.map(value => value.split('/')[1]!))] : ['open'];
};
function compatible(handler: CatalogHandler, request: IntentRequest): boolean {
  const role = handler.roles.find(value => value.archetype === request.archetype);
  return !!role && actions(handler, request.archetype).includes(request.action) && (request.convention === undefined || role.conventions.length === 0 || role.conventions.includes(request.convention));
}
function availability(catalog: CatalogSnapshot, archetype: string) {
  const preferred = catalog.defaults.find(value => value.archetype === archetype);
  const candidates: Readonly<{dTag: string; title: string; actions: readonly string[]; conventions: readonly string[]; isDefault: boolean}>[] = [];
  for (const handler of catalog.handlers) {
    const role = handler.roles.find(value => value.archetype === archetype);
    if (role) candidates.push(Object.freeze({dTag: handler.appId, title: handler.title, actions: actions(handler, archetype), conventions: role.conventions, isDefault: preferred?.publisher === handler.publisher && preferred.appId === handler.appId}));
  }
  return Object.freeze({ archetype, available: candidates.length > 0, candidates: Object.freeze(candidates), hasDefault: candidates.some(value => value.isDefault) });
}
function routingFailure(message: RoutingMessage): Readonly<Record<string, unknown>> | null {
  if (message.id === undefined) return null;
  const base = {type: message.type + '.result', id: message.id, error: 'routing unavailable'};
  if (message.type === 'intent.invoke') return {...base, result: {ok: false, handled: false, archetype: message.request!.archetype, action: message.request!.action, error: base.error}};
  if (message.type === 'intent.available') return {...base, availability: {archetype: message.archetype, available: false, candidates: [], hasDefault: false}};
  if (message.type === 'intent.handlers') return {...base, handlers: []};
  return message.type === 'inc.channel.list' ? {...base, channels: []} : base;
}
/** Process-owned cross-view routing. Every source is compared with the native-held snapshot. */
export class RoutingBroker {
  private endpoints = new Map<string, Endpoint>();
  private readonly channels: RoutingChannels;
  private revision = -1;
  private stopped = false;
  private readonly controllers = new Set<AbortController>();
  private readonly releaseLifecycle: () => void;
  private readonly capability: NativeCapabilityPort;
  private readonly native: RoutingNativePort;
  private readonly catalog: RoutingCatalog;
  readonly reviews: RoutingReviewService;
  private readonly targets: RoutingTargetPort;
  constructor(capability: NativeCapabilityPort, native: RoutingNativePort, catalog: RoutingCatalog, reviews: RoutingReviewService, targets: RoutingTargetPort) {
    this.capability = capability; this.native = native; this.catalog = catalog; this.reviews = reviews; this.targets = targets;
    this.channels = new RoutingChannels(native, (endpoint, revision) => this.active(endpoint as Endpoint, revision, 'inc'));
    this.releaseLifecycle = native.subscribe(() => { try { const revision = this.refresh(); this.channels.flush(revision); } catch { this.reviews.cancelAll(); } });
  }
  private refresh(): number {
    const state = this.native.state();
    if (state.revision !== this.revision) {
      this.revision = state.revision;
      this.channels.revoke(state.revision, state.ownerAvailable && [...this.endpoints.values()].every(endpoint => endpoint.registration.user === state.user && endpoint.registration.epoch === state.epoch));
      for (const endpoint of this.endpoints.values()) if (!state.ownerAvailable || endpoint.registration.user !== state.user || endpoint.registration.epoch !== state.epoch) endpoint.topics.clear();
      for (const controller of this.controllers) controller.abort();
      this.reviews.cancelAll();
    }
    return state.revision;
  }
  private active(endpoint: Endpoint, revision: number, domain: 'intent' | 'inc') {
    const state = this.native.state();
    if (this.stopped || !state.available || state.user !== endpoint.registration.user || state.epoch !== endpoint.registration.epoch || this.endpoints.get(endpoint.registration.generation) !== endpoint || this.refresh() !== revision || !this.native.mayDeliver(endpoint.registration.generation, revision, domain)) revoked();
    endpoint.assertActive();
  }
  /** Trusted catalog mutations only; recipient identity/domain is rechecked after every await. */
  async catalogChanged(owner: TrustedUser, changedRoles: readonly string[] = []): Promise<void> {
    owner.assertActive(); const revision = this.refresh(), state = this.native.state();
    const active = () => { owner.assertActive(); const now = this.native.state(); if (!now.available || now.user !== owner.user || now.epoch !== state.epoch || this.refresh() !== revision) revoked(); };
    active(); const snapshot = await this.catalog.list({user: owner.user, assertActive: active}); active();
    const roles = new Set([...changedRoles, ...snapshot.handlers.flatMap(handler => handler.roles.map(role => role.archetype))]);
    for (const role of roles) {
      const message = Object.freeze({type: 'intent.changed', availability: availability(snapshot, role)});
      if (new TextEncoder().encode(JSON.stringify(message)).length > ROUTING_LIMITS.payloadBytes) continue;
      for (const endpoint of this.endpoints.values()) {
        if (endpoint.registration.user !== owner.user || !endpoint.registration.domains.includes('intent')) continue;
        try {active(); this.active(endpoint, revision, 'intent'); this.native.send(endpoint.registration.generation, revision, message);} catch { /* A live catalog push has no background backlog. */ }
      }
    }
  }
  close(generation: string) {
    this.endpoints.delete(generation); this.reviews.close(generation); this.channels.endpointClosed(generation, this.refresh());
  }
  stop() { this.stopped = true; this.releaseLifecycle(); for (const controller of this.controllers) controller.abort(); this.controllers.clear(); this.reviews.cancelAll(); this.channels.stop(); this.endpoints.clear(); }
  private owner(endpoint: Endpoint, revision: number, domain: 'intent' | 'inc'): TrustedUser {
    return Object.freeze({ user: endpoint.registration.user, assertActive: () => this.active(endpoint, revision, domain) });
  }
  private async waitFor<T>(read: () => T | null, active: () => void, signal: AbortSignal): Promise<T> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      active(); if (signal.aborted) revoked();
      const value = read(); if (value !== null) return value;
      await new Promise<void>(resolve => { const timer = setTimeout(done, 50); function done() { signal.removeEventListener('abort', done); clearTimeout(timer); resolve(); } signal.addEventListener('abort', done, { once: true }); });
    }
    throw new Error('Handler not ready');
  }
  private async invoke(endpoint: Endpoint, revision: number, request: IntentRequest, active: () => void, signal: AbortSignal): Promise<Readonly<Record<string, unknown>>> {
    const base = { archetype: request.archetype, action: request.action, ...(request.convention === undefined ? {} : { convention: request.convention }) };
    const failure = (error: string) => Object.freeze({ ...base, ok: false, handled: false, error });
    try {
      const catalog = await this.catalog.list(this.owner(endpoint, revision, 'intent'), { signal }); active();
      let candidates = catalog.handlers.filter(handler => handler.roles.some(role => role.archetype === request.archetype));
      if (!candidates.length) return failure('no handler');
      const explicit = request.handler !== undefined && request.handler !== 'choose' && request.handler !== 'default';
      if (explicit) candidates = candidates.filter(handler => handler.appId === request.handler);
      if (!candidates.length) return failure('no handler');
      if (explicit && candidates.length !== 1) return failure('ambiguous handler');
      const preferred = catalog.defaults.find(value => value.archetype === request.archetype);
      if (!explicit && (request.handler === 'choose' || !preferred)) candidates = candidates.filter(handler => compatible(handler, request));
      if (!candidates.length) return failure('no handler');
      // A saved default is used first, then its action/convention support is checked. Never silently substitute another handler.
      const selected = request.handler === 'choose' ? null : (!explicit && preferred ? candidates.find(handler => handler.publisher === preferred.publisher && handler.appId === preferred.appId) ?? null : candidates.length === 1 ? candidates[0]! : null);
      const newInstance = request.behavior?.newWindow === true || request.behavior?.reuse === false;
      const decision = await this.reviews.ask(Object.freeze({ kind: 'intent', origin: endpoint.registration, request, candidates: Object.freeze(candidates), selected, newInstance }), active, () => this.native.mayReview(endpoint.registration.generation, revision));
      active(); if (!decision.allow || !decision.selected) return failure('user cancelled');
      const handler = decision.selected;
      const latest = await this.catalog.list(this.owner(endpoint, revision, 'intent'), { signal }); active();
      if (!latest.handlers.some(value => sameHandler(value, handler))) return failure('invoke failed');
      if (!actions(handler, request.archetype).includes(request.action)) return failure('unsupported action');
      const role = handler.roles.find(value => value.archetype === request.archetype);
      if (!role) return failure('no handler');
      const conventions = role.conventions;
      const convention = request.convention ?? conventions.find(value => value.endsWith('/' + request.action)) ?? `napplet:${request.archetype}/${request.action}`;
      if (conventions.length && !conventions.includes(convention)) return failure('unsupported convention');
      if (decision.remember) { const owner = this.owner(endpoint, revision, 'intent'); await this.catalog.prefer(owner, request.archetype, handler, { signal }); active(); await this.catalogChanged(owner, [request.archetype]); active(); }
      const sessionId = await this.targets.activate(handler, request, signal, active, endpoint.registration, revision); active();
      const target = await this.waitFor(() => [...this.endpoints.values()].find(value => value.registration.sessionId === sessionId && value.registration.publisher === handler.publisher && value.registration.appId === handler.appId && value.registration.version === handler.version) ?? null, active, signal);
      await this.waitFor(() => target.topics.has(convention) ? true : null, () => { active(); this.active(target, revision, 'inc'); }, signal);
      active(); this.active(target, revision, 'inc');
      const delivered = this.native.send(target.registration.generation, revision, { type: 'inc.event', topic: convention, sender: endpoint.registration.appId, ...(Object.prototype.hasOwnProperty.call(request, 'payload') ? { payload: request.payload } : {}) });
      return delivered ? Object.freeze({ ...base, convention, ok: true, handled: true, handler: handler.appId, windowId: sessionId }) : failure('invoke failed');
    } catch { return failure('invoke failed'); }
  }
  private async operate(endpoint: Endpoint, revision: number, message: RoutingMessage, active: () => void, signal: AbortSignal): Promise<Readonly<Record<string, unknown>> | null> {
    if (message.type === 'intent.invoke') return { type: 'intent.invoke.result', id: message.id, result: await this.invoke(endpoint, revision, message.request!, active, signal) };
    if (message.type === 'intent.available' || message.type === 'intent.handlers') {
      const catalog = await this.catalog.list(this.owner(endpoint, revision, 'intent'), { signal }); active();
      if (message.type === 'intent.available') return { type: 'intent.available.result', id: message.id, availability: availability(catalog, message.archetype!) };
      const roles = [...new Set(catalog.handlers.flatMap(handler => handler.roles.map(role => role.archetype)))];
      return { type: 'intent.handlers.result', id: message.id, handlers: roles.map(role => availability(catalog, role)) };
    }
    this.channels.flush(revision);
    if (message.type === 'inc.emit') {
      for (const target of this.endpoints.values()) if (target !== endpoint && target.topics.has(message.topic!)) {
        try {active(); this.active(target, revision, 'inc'); this.native.send(target.registration.generation, revision, {type: 'inc.event', topic: message.topic, sender: endpoint.registration.appId, ...(Object.prototype.hasOwnProperty.call(message, 'payload') ? {payload: message.payload} : {})});} catch { /* Revoked recipients have no destination; topics have no backlog or receipt. */ }
      }
      return null;
    }
    if (message.type === 'inc.channel.open') {
      const peers = [...this.endpoints.values()].filter(peer => peer !== endpoint && peer.registration.appId === message.target && peer.registration.user === endpoint.registration.user && peer.registration.epoch === endpoint.registration.epoch && peer.registration.domains.includes('inc') && this.native.mayDeliver(peer.registration.generation, revision, 'inc'));
      const failure = {type: 'inc.channel.open.result', id: message.id, error: 'peer unavailable'};
      if (peers.length !== 1) return failure;
      const peer = peers[0]!; this.active(peer, revision, 'inc');
      const decision = await this.reviews.ask(Object.freeze({kind: 'channel', origin: endpoint.registration, peer: peer.registration}), active, () => this.native.mayReview(endpoint.registration.generation, revision));
      active(); this.active(peer, revision, 'inc');
      if (!decision.allow) return {...failure, error: 'user denied'};
      const channel = this.channels.open(endpoint, peer, revision);
      return channel ? {type: 'inc.channel.open.result', id: message.id, ...channel} : failure;
    }
    if (message.type === 'inc.channel.list') return {type: 'inc.channel.list.result', id: message.id, channels: this.channels.list(endpoint, revision)};
    if (message.type === 'inc.channel.close') {this.channels.close(endpoint, message.channelId!, revision); return null;}
    if (message.type === 'inc.channel.emit' || message.type === 'inc.channel.broadcast') {this.channels.emit(endpoint, message, revision); return null;}
    if (message.type === 'inc.subscribe') {
      if (!endpoint.topics.has(message.topic!)) {
        if (endpoint.topics.size >= ROUTING_LIMITS.topics) return { type: 'inc.subscribe.result', id: message.id, error: 'topic limit reached' };
        const decision = await this.reviews.ask(Object.freeze({ kind: 'topic', origin: endpoint.registration, topic: message.topic! }), active, () => this.native.mayReview(endpoint.registration.generation, revision));
        active(); if (!decision.allow) return { type: 'inc.subscribe.result', id: message.id, error: 'user denied' };
        endpoint.topics.add(message.topic!);
      }
      return { type: 'inc.subscribe.result', id: message.id };
    }
    if (message.type === 'inc.unsubscribe') { endpoint.topics.delete(message.topic!); return null; }
    if (message.id !== undefined) return { type: message.type + '.result', id: message.id, ...(message.type === 'inc.channel.list' ? { channels: [] } : {}), error: 'operation unavailable' };
    return null;
  }
  async dispatch(token: string, owner: CapabilityOwner): Promise<void> {
    let claimed = false, response: string | null = null;
    const controller = new AbortController();
    try {
      const raw = this.capability.take(token); if (raw === null) return; claimed = true;
      const captured = decodeNativeRequest(raw), expected = decodeNativeRegistration(owner.registration);
      if (JSON.stringify(captured.registration) !== JSON.stringify(expected)) return;
      const wrapper = routingRecord(captured.request, ['type', 'id', 'message', 'revision']);
      if (wrapper.type !== 'routing.call') return;
      const id = routingText(wrapper.id, 128), revision = wrapper.revision;
      if (!Number.isSafeInteger(revision) || (revision as number) < 0 || this.refresh() !== revision) return;
      const control = routingRecord(wrapper.message, ['type'], ['id', 'request', 'archetype', 'topic', 'payload', 'target', 'channelId']);
      const domain = control.type === 'routing.__register' ? expected.domains.includes('intent') ? 'intent' : 'inc' : typeof control.type === 'string' && control.type.startsWith('intent.') ? 'intent' : 'inc';
      const generation = expected.generation;
      let endpoint = this.endpoints.get(generation);
      if (!endpoint) {
        if (this.endpoints.size >= ROUTING_LIMITS.endpoints) return;
        endpoint = { registration: expected, assertActive: owner.assertActive, seen: new Set(), topics: new Set() };
        this.endpoints.set(generation, endpoint);
      } else if (JSON.stringify(endpoint.registration) !== JSON.stringify(expected)) return;
      const selected = endpoint, capturedRevision = revision as number;
      const active = () => { if (!this.capability.isActive(token) || controller.signal.aborted) revoked(); owner.assertActive(); this.active(selected, capturedRevision, domain); };
      active();
      if (selected.seen.has(id) || selected.seen.size >= CAPABILITY_LIMITS.sessionRequests) return;
      selected.seen.add(id); this.controllers.add(controller);
      let result: Readonly<Record<string, unknown>> | null;
      if (control.type === 'routing.__register') { routingRecord(wrapper.message, ['type']); result = null; }
      else {
        const message = parseRoutingMessage(wrapper.message);
        try { result = await this.operate(selected, capturedRevision, message, active, controller.signal); }
        catch { active(); result = routingFailure(message); }
        if (result !== null && new TextEncoder().encode(JSON.stringify(result)).length > ROUTING_LIMITS.payloadBytes) result = routingFailure(message);
      }
      active(); response = JSON.stringify({ type: 'routing.call.result', id, response: result });
    } catch { /* Failed/revoked native requests have no destination or authority. */ }
    finally { controller.abort(); this.controllers.delete(controller); if (claimed) this.capability.finish(token, response); }
  }
}
