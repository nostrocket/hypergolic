import assert from 'node:assert/strict';
import {NotifyBroker} from '../../src/presentation/notify-broker.ts';
import {openNotifyPermissions} from '../../src/presentation/notify-permissions.ts';
import type {NativeRegistration} from '../../src/runtime/capability-protocol.ts';
import type {RoutingNativeState} from '../../src/routing/routing-port.ts';
import {DiskSQLite} from '../storage/harness.ts';
export const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
export async function setup(t: {after(action: () => void | Promise<void>): void}) {
  const sqlite = new DiskSQLite(), permissions = await openNotifyPermissions(sqlite, 'ios'); t.after(async () => {try {await permissions.close();} finally {sqlite.cleanup();}});
  const source: NativeRegistration = {user: '01'.repeat(32), epoch: 0, publisher: '02'.repeat(32), appId: 'notify-source', version: '03'.repeat(32), sessionId: 'source-view', generation: 'source-generation', instanceId: 'source-view', fixture: 'published', domains: ['notify']};
  const peer = {...source, appId: 'peer', generation: 'peer-generation', sessionId: 'peer-view', instanceId: 'peer-view'};
  let state: RoutingNativeState = {user: source.user, epoch: 0, revision: 1, available: true, ownerAvailable: true, foreground: true}, listener = () => {}, counter = 0, focus = source.generation, now = 1000, deniedPush = false;
  const revoked = new Set<string>(), live = new Set<string>(), slots = new Map<string, string>(), replies = new Map<string, unknown>(), sent: {generation: string; message: Readonly<Record<string, unknown>>}[] = [];
  const native = {state: () => state, mayDeliver: (generation: string, revision: number, domain: string) => state.available && revision === state.revision && !revoked.has(generation) && domain === 'notify', reviewRevision: () => 1, mayReview: (generation: string, revision: number) => state.available && revision === state.revision && focus === generation && !revoked.has(generation),
    send(generation: string, revision: number, message: Readonly<Record<string, unknown>>) {if (deniedPush || !this.mayDeliver(generation, revision, 'notify')) return false; sent.push({generation, message}); return true;}, subscribe(callback: () => void) {listener = callback; return () => {};}, newChannelId: () => 'notification-' + ++counter};
  const capability = {take(token: string) {const row = slots.get(token) ?? null; slots.delete(token); return row;}, isActive: (token: string) => live.has(token), finish(token: string, raw: string | null) {live.delete(token); replies.set(token, raw === null ? null : JSON.parse(raw));}};
  const broker = new NotifyBroker(capability, native, permissions, () => now); t.after(() => broker.stop());
  function dispatch(registration: NativeRegistration, message: unknown, patch: Partial<NativeRegistration> = {}, id?: string) {
    const token = 'token-' + ++counter; live.add(token); slots.set(token, JSON.stringify({registration: {...registration, ...patch}, request: JSON.stringify({type: 'routing.call', id: id ?? 'call-' + counter, message, revision: state.revision})}));
    const promise = broker.dispatch(token, {registration, assertActive() {if (revoked.has(registration.generation)) throw Error('Revoked');}});
    return {token, promise, reply: () => (replies.get(token) as {response: any} | null)?.response};
  }
  async function review() {for (let i = 0; i < 50; i++) {const row = broker.getSnapshot().review; if (row) return row; await tick();} throw Error('No review');}
  async function allow(channel?: string) {const result = dispatch(source, {type: 'notify.permission.request', id: 'allow-' + counter, ...(channel ? {channel} : {})}); const row = await review(); broker.decide(row.id, true); await result.promise; assert.equal(result.reply().granted, true);}
  return {sqlite, broker, permissions, source, peer, dispatch, review, allow, sent, native, advance(milliseconds: number) {now += milliseconds; broker.refresh();}, focus(generation: string) {focus = generation; broker.refresh();}, denyPush(value: boolean) {deniedPush = value;}, revoke(generation: string) {revoked.add(generation); broker.refresh();}, expire(token: string) {live.delete(token); broker.refresh();}, lifecycle(next: Partial<RoutingNativeState>) {state = {...state, ...next, revision: state.revision + 1}; listener();}};
}
