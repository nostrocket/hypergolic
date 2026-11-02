import assert from 'node:assert/strict';
import { RoutingBroker } from '../../src/routing/routing-broker.ts';
import { RoutingReviewService } from '../../src/routing/routing-review.ts';
import { openRoutingCatalog } from '../../src/routing/routing-catalog.ts';
import type { RoutingNativeState } from '../../src/routing/routing-port.ts';
import type { NativeRegistration } from '../../src/runtime/capability-protocol.ts';
import { DiskSQLite } from '../storage/harness.ts';
import { artifact } from './fixtures.ts';
export const user = '01'.repeat(32);
export async function setup(t: {after(action: () => void | Promise<void>): void}) {
  const sqlite = new DiskSQLite();
  const catalog = await openRoutingCatalog(sqlite, 'ios'); t.after(async () => {try {await catalog.close();} finally {sqlite.cleanup();}});
  const a = await artifact(), b = await artifact(10);
  await catalog.remember({user, assertActive() {}}, a);
  const source: NativeRegistration = {user, epoch: 0, publisher: '03'.repeat(32), appId: 'caller', version: '04'.repeat(32), sessionId: 'caller-view', generation: 'source-generation', instanceId: 'caller-view', fixture: 'published', domains: ['intent', 'inc']};
  const target: NativeRegistration = {...source, publisher: a.manifest.pubkey, appId: 'notes', version: a.manifest.versionId, sessionId: 'handler-view', generation: 'handler-generation', instanceId: 'handler-view', domains: ['inc']};
  let state: RoutingNativeState = {user, epoch: 0, revision: 1, available: true, ownerAvailable: true, foreground: true};
  const revoked = new Set<string>(), live = new Set<string>(), slots = new Map<string, string>(), replies = new Map<string, unknown>();
  const sent: {generation: string; message: Readonly<Record<string, unknown>>}[] = [], activated: string[] = [];
  let deniedPush = false;
  let counter = 0, focus = source.generation, lifecycle = () => {}, targetReady = true;
  const native = {
    state: () => state,
    mayDeliver: (generation: string, revision: number, domain: string) => state.available && revision === state.revision && !revoked.has(generation) && (generation !== target.generation || targetReady) && (generation === source.generation || domain === 'inc'),
    reviewRevision: () => 1, mayReview: (generation: string, revision: number) => state.available && revision === state.revision && focus === generation && !revoked.has(generation),
    send(generation: string, revision: number, message: Readonly<Record<string, unknown>>) {if (deniedPush || !this.mayDeliver(generation, revision, message.type === 'intent.changed' ? 'intent' : 'inc')) return false; sent.push({generation, message}); return true;},
    subscribe(listener: () => void) {lifecycle = listener; return () => {};}, newChannelId: () => 'channel-' + ++counter,
  };
  const capability = {take(token: string) {const raw = slots.get(token) ?? null; slots.delete(token); return raw;}, isActive: (token: string) => live.has(token), finish(token: string, response: string | null) {live.delete(token); replies.set(token, response === null ? null : JSON.parse(response));}};
  const reviews = new RoutingReviewService();
  const broker = new RoutingBroker(capability, native, catalog, reviews, {async activate(handler) {activated.push(handler.publisher); return target.sessionId;}}); t.after(() => broker.stop());
  function dispatch(registration: NativeRegistration, message: unknown, patch: Partial<NativeRegistration> = {}, wrapperId?: string) {
    const token = 'token-' + ++counter; live.add(token); slots.set(token, JSON.stringify({registration: {...registration, ...patch}, request: JSON.stringify({type: 'routing.call', id: wrapperId ?? 'call-' + counter, message, revision: state.revision})}));
    const promise = broker.dispatch(token, {registration, assertActive() {if (revoked.has(registration.generation)) throw Error('Revoked');}});
    return {token, promise, reply: () => (replies.get(token) as {response: any} | null)?.response};
  }
  async function register(registration: NativeRegistration) {await dispatch(registration, {type: 'routing.__register'}).promise;}
  async function subscribeTarget(topic = 'napplet:note/open') {
    focus = target.generation;
    const result = dispatch(target, {type: 'inc.subscribe', id: 'sub-' + counter, topic});
    await tick(); const review = reviews.getSnapshot(); assert.equal(review?.request.kind, 'topic'); reviews.decide(review!.id, {allow: true}); await result.promise;
    assert.deepEqual(result.reply(), {type: 'inc.subscribe.result', id: 'sub-' + (Number(result.token.split('-')[1]) - 1)}); focus = source.generation;
  }
  return {expire(token: string) {live.delete(token); reviews.refresh();}, denyPush(value: boolean) {deniedPush = value;}, catalog, a, b, source, target, broker, reviews, native, sent, activated, dispatch, register, subscribeTarget, revoke(generation: string) {revoked.add(generation); reviews.refresh();}, setFocus(generation: string) {focus = generation; reviews.refresh();}, lifecycle(next: Partial<RoutingNativeState>) {state = {...state, ...next, revision: state.revision + 1}; lifecycle();}, targetReady(value: boolean) {targetReady = value;}};
}
export async function tick() {await new Promise<void>(resolve => setTimeout(resolve, 0));}
export async function reviewReady(reviews: RoutingReviewService) {for (let i = 0; i < 50; i++) {const review = reviews.getSnapshot(); if (review) return review; await tick();} throw Error('No review');}
