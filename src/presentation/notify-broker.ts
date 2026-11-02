import { decodeNativeRegistration, decodeNativeRequest, CAPABILITY_LIMITS, type NativeRegistration } from '../runtime/capability-protocol.ts';
import type { NativeCapabilityPort, CapabilityOwner } from '../runtime/capability-broker.ts';
import type { RoutingNativePort } from '../routing/routing-port.ts';
import { routingRecord, routingText } from '../routing/routing-contract.ts';
import { ShellStorageError, type TrustedApp, type TrustedUser } from '../storage/ports.ts';
import { parseNotifyMessage, NOTIFY_CONTROLS, NOTIFY_LIMITS, type NotifyMessage, type NotifyAction, type NotifyPriority } from './notify-contract.ts';
import type { NotifyPermissions } from './notify-permissions.ts';
type Endpoint = {registration: NativeRegistration; assertActive(): void; seen: Set<string>; channels: Map<string, Extract<NotifyMessage, {type: 'notify.channel.register'}>>; window: number; sends: number; asks: number};
export type NotificationCard = Readonly<{id: string; origin: NativeRegistration; title: string; body: string; channel: string; priority: NotifyPriority; actions: readonly NotifyAction[]; created: number; toastUntil: number}>;
export type NotifyReview = Readonly<{id: string; origin: NativeRegistration; channel: string; label: string}>;
type Pending = NotifyReview & {active(): void; resolve(allow: boolean): void};
export type NotificationBadge = Readonly<{origin: NativeRegistration; count: number}>;
export type NotifySnapshot = Readonly<{cards: readonly NotificationCard[]; badges: Readonly<Record<string, number>>; attributedBadges: readonly NotificationBadge[]; toast: NotificationCard | null; review: NotifyReview | null}>;
const revoked = (): never => {throw new ShellStorageError('REVOKED');};
const scopeKey = (origin: Pick<NativeRegistration, 'user' | 'publisher' | 'appId'>, channel: string) => JSON.stringify([origin.user, origin.publisher, origin.appId, channel]);
/** Shell-owned foreground notifications. Native attestation, not guest payload, selects every source. */
export class NotifyBroker {
  private readonly endpoints = new Map<string, Endpoint>();
  private cards: NotificationCard[] = [];
  private badges: Record<string, number> = {};
  private pending: Pending[] = [];
  private counter = 0;
  private revision = -1;
  private policyRevision = 0;
  private stopped = false;
  private blocked = new Set<string>();
  private listeners = new Set<() => void>();
  private snapshot: NotifySnapshot = Object.freeze({cards: Object.freeze([]), badges: Object.freeze({}), attributedBadges: Object.freeze([]), toast: null, review: null});
  private release: () => void;
  private readonly capability: NativeCapabilityPort;
  private readonly native: RoutingNativePort;
  readonly permissions: NotifyPermissions;
  private readonly now: () => number;
  constructor(capability: NativeCapabilityPort, native: RoutingNativePort, permissions: NotifyPermissions, now: () => number = Date.now) {
    this.capability = capability; this.native = native; this.permissions = permissions; this.now = now;
    this.release = native.subscribe(() => this.refresh());
  }
  subscribe = (listener: () => void) => {this.listeners.add(listener); return () => {this.listeners.delete(listener);};};
  getSnapshot = () => this.snapshot;
  private publish() {
    const visible = this.pending.find(item => {try {item.active(); return this.native.mayReview(item.origin.generation, this.revision);} catch {return false;}});
    const attributedBadges: NotificationBadge[] = [], now = this.now();
    for (const [generation, count] of Object.entries(this.badges)) {const origin = this.endpoints.get(generation)?.registration; if (origin && count > 0) attributedBadges.push(Object.freeze({origin, count}));}
    this.snapshot = Object.freeze({cards: Object.freeze([...this.cards]), badges: Object.freeze({...this.badges}), attributedBadges: Object.freeze(attributedBadges), toast: this.cards.find(card => card.toastUntil > now) ?? null, review: visible ? Object.freeze({id: visible.id, origin: visible.origin, channel: visible.channel, label: visible.label}) : null});
    for (const listener of this.listeners) try {listener();} catch { /* Presentation cannot grant authority. */ }
  }
  refresh() {
    const state = this.native.state();
    if (state.revision !== this.revision) {
      this.revision = state.revision; this.cards = []; this.badges = {};
      for (const entry of this.pending) entry.resolve(false); this.pending = [];
      for (const [generation, endpoint] of this.endpoints) if (!state.ownerAvailable || state.user !== endpoint.registration.user || state.epoch !== endpoint.registration.epoch) this.endpoints.delete(generation);
    }
    for (const entry of this.pending) {try {entry.active();} catch {this.end(entry, false);}}
    const now = this.now();
    for (const card of this.cards) {
      const endpoint = this.endpoints.get(card.origin.generation);
      try {if (!endpoint) throw new ShellStorageError('REVOKED'); this.active(endpoint, this.revision); if (now - card.created >= 300_000) this.dismiss(card.id, 'timeout');} catch {this.cards = this.cards.filter(value => value !== card); delete this.badges[card.origin.generation];}
    }
    this.publish();
  }
  private active(endpoint: Endpoint, revision: number) {
    const state = this.native.state();
    if (this.stopped || !state.available || state.revision !== revision || endpoint.registration.user !== state.user || endpoint.registration.epoch !== state.epoch || this.endpoints.get(endpoint.registration.generation) !== endpoint || !this.native.mayDeliver(endpoint.registration.generation, revision, 'notify')) revoked();
    endpoint.assertActive();
  }
  private owner(endpoint: Endpoint, active: () => void): TrustedApp {return Object.freeze({user: endpoint.registration.user, publisher: endpoint.registration.publisher, appId: endpoint.registration.appId, assertActive: active});}
  private end(entry: Pending, allow: boolean) {this.pending = this.pending.filter(value => value !== entry); entry.resolve(allow);}
  decide(id: string, allow: boolean) {
    this.refresh(); const entry = this.pending.find(value => value.id === id);
    if (!entry || this.snapshot.review?.id !== id) return;
    try {entry.active(); if (!this.native.mayReview(entry.origin.generation, this.revision)) revoked(); this.end(entry, allow === true);} catch {this.end(entry, false);} this.publish();
  }
  private ask(endpoint: Endpoint, channel: string, active: () => void): Promise<boolean> {
    if (this.pending.length >= 8 || this.pending.some(value => value.origin.generation === endpoint.registration.generation) || this.counter >= Number.MAX_SAFE_INTEGER) return Promise.resolve(false);
    return new Promise(resolve => {this.pending.push({id: 'notify-review-' + ++this.counter, origin: endpoint.registration, channel, label: endpoint.channels.get(channel)?.label ?? 'General notifications', active, resolve}); this.publish();});
  }
  private push(endpoint: Endpoint, message: Readonly<Record<string, unknown>>): boolean {
    try {this.active(endpoint, this.revision); return this.native.send(endpoint.registration.generation, this.revision, message);} catch {return false;}
  }
  interact(id: string, actionId?: string): void {
    this.refresh(); const card = this.cards.find(value => value.id === id); if (!card) return;
    const endpoint = this.endpoints.get(card.origin.generation); if (!endpoint || (actionId !== undefined && !card.actions.some(action => action.id === actionId))) return;
    if (!this.push(endpoint, actionId === undefined ? {type: 'notify.clicked', notificationId: id} : {type: 'notify.action', notificationId: id, actionId})) return;
    this.cards = this.cards.filter(value => value !== card); this.publish();
  }
  dismiss(id: string, reason: 'user' | 'timeout' | 'replaced' = 'user'): void {
    const card = this.cards.find(value => value.id === id); if (!card) return;
    this.cards = this.cards.filter(value => value !== card); const endpoint = this.endpoints.get(card.origin.generation);
    if (endpoint) this.push(endpoint, {type: 'notify.dismissed', notificationId: id, reason}); this.publish();
  }
  close(generation: string) {
    this.endpoints.delete(generation); this.cards = this.cards.filter(card => card.origin.generation !== generation); delete this.badges[generation];
    for (const entry of this.pending) if (entry.origin.generation === generation) this.end(entry, false); this.publish();
  }
  stop() {this.stopped = true; this.release(); for (const entry of this.pending) entry.resolve(false); this.pending = []; this.endpoints.clear(); this.cards = []; this.badges = {}; this.publish();}
  async revoke(owner: TrustedApp, channel: string): Promise<void> {
    owner.assertActive(); const key = scopeKey(owner, channel); this.blocked.add(key); this.policyRevision++;
    for (const entry of this.pending) this.end(entry, false);
    this.cards = this.cards.filter(card => scopeKey(card.origin, card.channel) !== key);
    for (const endpoint of this.endpoints.values()) if (scopeKey(endpoint.registration, channel) === key) delete this.badges[endpoint.registration.generation]; this.publish();
    await this.permissions.revoke(owner, channel); owner.assertActive();
  }
  listPermissions(owner: TrustedUser) {return this.permissions.list(owner);}
  private atCapacity(generation: string): boolean {
    return this.cards.length >= NOTIFY_LIMITS.cards || this.cards.filter(card => card.origin.generation === generation).length >= NOTIFY_LIMITS.perSource;
  }
  private async operate(endpoint: Endpoint, request: NotifyMessage, active: () => void): Promise<Readonly<Record<string, unknown>> | null> {
    const now = this.now(); if (now - endpoint.window >= 60_000) {endpoint.window = now; endpoint.sends = 0; endpoint.asks = 0;}
    if (request.type === 'notify.channel.register') {
      if (!endpoint.channels.has(request.channelId) && endpoint.channels.size >= NOTIFY_LIMITS.channels) return null;
      endpoint.channels.set(request.channelId, request); return null;
    }
    if (request.type === 'notify.dismiss') {const card = this.cards.find(value => value.id === request.notificationId); if (card?.origin.generation === endpoint.registration.generation) this.dismiss(card.id); return null;}
    const channel = 'channel' in request ? request.channel ?? '' : '';
    const registered = channel === '' || endpoint.channels.has(channel);
    const owner = this.owner(endpoint, active), key = scopeKey(endpoint.registration, channel);
    if (request.type === 'notify.permission.request') {
      const result = (granted: boolean) => ({type: 'notify.permission.result', id: request.id, granted});
      if (!registered || ++endpoint.asks > NOTIFY_LIMITS.permissionPerMinute) return result(false);
      if (!this.blocked.has(key) && await this.permissions.has(owner, channel)) {active(); return result(true);}
      active(); if (!await this.ask(endpoint, channel, active)) return result(false); active();
      await this.permissions.grant(owner, channel); active(); this.blocked.delete(key); return result(true);
    }
    if (request.type === 'notify.badge') {
      if (this.blocked.has(key) || !await this.permissions.has(owner, '')) return null; active(); this.badges[endpoint.registration.generation] = request.count; this.publish(); return null;
    }
    if (request.type !== 'notify.send') return null;
    const error = (reason: string) => ({type: 'notify.send.result', id: request.id, error: reason});
    if (!registered) return error('invalid channel');
    if (++endpoint.sends > NOTIFY_LIMITS.sendsPerMinute || this.atCapacity(endpoint.registration.generation)) return error('rate limited');
    if (this.blocked.has(key) || !await this.permissions.has(owner, channel)) return error('permission denied'); active();
    // Permission reads yield; recheck capacity before allocating an ID or publishing.
    if (this.atCapacity(endpoint.registration.generation)) return error('rate limited');
    const id = this.native.newChannelId(); routingText(id, 128);
    if (this.cards.some(card => card.id === id)) return error('notification unavailable');
    const priority = request.priority ?? endpoint.channels.get(channel)?.defaultPriority ?? 'normal';
    const created = this.now();
    this.cards.push(Object.freeze({id, origin: endpoint.registration, title: request.title, body: request.body ?? '', channel, priority, actions: Object.freeze([...(request.actions ?? [])]), created, toastUntil: priority === 'low' ? 0 : created + 8000})); this.publish();
    return {type: 'notify.send.result', id: request.id, notificationId: id};
  }
  async dispatch(token: string, owner: CapabilityOwner): Promise<void> {
    let claimed = false, response: string | null = null;
    try {
      const raw = this.capability.take(token); if (raw === null) return; claimed = true;
      const captured = decodeNativeRequest(raw), expected = decodeNativeRegistration(owner.registration);
      if (JSON.stringify(captured.registration) !== JSON.stringify(expected) || !expected.domains.includes('notify')) return;
      const wrapper = routingRecord(captured.request, ['type', 'id', 'message', 'revision']); if (wrapper.type !== 'routing.call') return;
      const id = routingText(wrapper.id, 128); if (!Number.isSafeInteger(wrapper.revision) || (wrapper.revision as number) < 0) return;
      this.refresh(); const revision = wrapper.revision as number, policy = this.policyRevision;
      let endpoint = this.endpoints.get(expected.generation);
      if (!endpoint) {if (this.endpoints.size >= 64) return; endpoint = {registration: expected, assertActive: owner.assertActive, seen: new Set(), channels: new Map(), window: this.now(), sends: 0, asks: 0}; this.endpoints.set(expected.generation, endpoint);}
      else if (JSON.stringify(endpoint.registration) !== JSON.stringify(expected)) return;
      const selected = endpoint; const active = () => {if (!this.capability.isActive(token) || policy !== this.policyRevision) revoked(); owner.assertActive(); this.active(selected, revision);}; active();
      if (selected.seen.has(id) || selected.seen.size >= CAPABILITY_LIMITS.sessionRequests) return; selected.seen.add(id);
      let result: Readonly<Record<string, unknown>> | null;
      const control = routingRecord(wrapper.message, ['type'], Object.keys(wrapper.message as object).filter(key => key !== 'type'));
      if (control.type === 'notify.__register') {routingRecord(control, ['type']); this.push(selected, {type: 'notify.controls', controls: NOTIFY_CONTROLS}); result = null;}
      else {const request = parseNotifyMessage(control); try {result = await this.operate(selected, request, active);} catch {active(); result = request.type === 'notify.permission.request' ? {type: 'notify.permission.result', id: request.id, granted: false} : request.type === 'notify.send' ? {type: 'notify.send.result', id: request.id, error: 'notification unavailable'} : null;}}
      active(); response = JSON.stringify({type: 'routing.call.result', id, response: result});
    } catch { /* Captured native expiry/revocation has no surviving response authority. */ }
    finally {if (claimed) this.capability.finish(token, response);}
  }
}
