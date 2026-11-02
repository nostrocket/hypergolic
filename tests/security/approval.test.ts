import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent } from 'nostr-tools/pure';
import { updateApprovalAppState } from '../../src/shell/approval-lifecycle.ts';
import { ApprovalService, type ApprovalEffects, type ApprovalOrigin, type NativeApprovalLease, type NativeApprovalLeasePort, type NativeTakenApproval } from '../../src/security/approval-service.ts';

const secret = new Uint8Array(32); secret[31] = 2;
const relay = 'wss://relay.example.org';
const event = (kind = 1) => ({ kind, content: 'approved', tags: [['t', 'approval']], created_at: 1_700_000_002 });
const origin = (sessionId: string, epoch = 1): ApprovalOrigin => Object.freeze({ sessionId, generation: `generation-${sessionId}`, epoch, user: 'c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5', publisher: '11'.repeat(32), appId: 'approval-lab', version: '22'.repeat(32), instanceId: `instance-${sessionId}` });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
type State = { live: boolean; approved: boolean };
class Native implements NativeApprovalLeasePort {
  sourceTokens = new WeakMap<NativeApprovalLease, string>();
  signingSource(lease: NativeApprovalLease) { const token = this.sourceTokens.get(lease); assert(token); return { kind: 'approval' as const, token }; }
  states = new Map<NativeApprovalLease, State>(); tokens = new Map<string, NativeTakenApproval>(); cancelled = 0; finished = 0; responses: (string | null)[] = [];
  issue(token: string, owner = origin(token), requestId = `wire-${token}`, request = event()) { const lease = {}; this.sourceTokens.set(lease, token); const taken = Object.freeze({ lease, origin: owner, requestId, event: request }); this.states.set(lease, { live: true, approved: false }); this.tokens.set(token, taken); return taken; }
  state(lease: NativeApprovalLease) { const value = this.states.get(lease); if (!value) throw new Error('unknown lease'); return value; }
  take(token: string) { const value = this.tokens.get(token) ?? null; this.tokens.delete(token); return value; }
  isLive(lease: NativeApprovalLease) { return this.state(lease).live; }
  mayReview(lease: NativeApprovalLease) { const state = this.state(lease); return state.live && !state.approved; }
  approveOnce(lease: NativeApprovalLease) { const state = this.state(lease); if (!state.live || state.approved) return false; state.approved = true; return true; }
  isApproved(lease: NativeApprovalLease) { const state = this.state(lease); return state.live && state.approved; }
  cancel(lease: NativeApprovalLease) { this.cancelled++; this.state(lease).live = false; }
  dismiss(lease: NativeApprovalLease) { this.cancel(lease); }
  resume() {}
  finish(lease: NativeApprovalLease, response: string | null = null) { this.finished++; this.responses.push(response); this.state(lease).live = false; }
}
function sign(snapshot: any) { return JSON.parse(JSON.stringify(finalizeEvent({ ...snapshot.event, tags: snapshot.event.tags.map((tag: string[]) => [...tag]) }, secret))); }
function make(native: Native, effects: Partial<ApprovalEffects> = {}, owner = { assertActive: (_: ApprovalOrigin) => undefined }) {
  return new ApprovalService(native, owner, { sign: async snapshot => sign(snapshot), publishEvent: async (verified, destinations) => Object.freeze(destinations.map(item => Object.freeze({ relay: item, eventId: verified.id, status: 'accepted' as const, reason: '' }))), ...effects });
}
function current(service: ApprovalService, token: string) { assert.equal(service.enqueue(token, [relay]), true); service.focus(token); return service.getSnapshot().current!.id; }

test('captures a native request once, verifies it, and publishes exact immutable outcomes', async () => {
  const native = new Native(); const taken = native.issue('one'); const service = make(native); const id = current(service, 'one'); assert.notEqual(id, taken.requestId);
  const outcomes = await service.approve(id); assert.deepEqual(outcomes, [{ relay: `${relay}/`, eventId: outcomes[0]!.eventId, status: 'accepted', reason: '' }]); assert.equal(native.finished, 1);
});
test('profile metadata needs explicit approval; reject has no modeled signing or publication effect', async () => {
  const native = new Native();
  const metadata = { kind: 0, content: JSON.stringify({ about: 'Development profile' }), tags: [['t', 'profile-test']], created_at: 1_700_000_002 };
  native.issue('reject-profile', origin('reject-profile'), 'wire-profile-reject', metadata);
  let signing = 0, publication = 0;
  const service = make(native, {
    sign: async snapshot => { signing++; assert.equal(snapshot.event.kind, 0); assert.equal(snapshot.event.content, metadata.content); return sign(snapshot); },
    publishEvent: async (signed, destinations, execution) => {
      execution.assertActive(); publication++;
      assert.equal(signed.kind, 0); assert.equal(signed.content, metadata.content);
      return destinations.map(destination => ({ relay: destination, eventId: signed.id, status: 'accepted' as const, reason: '' }));
    },
  });
  const rejected = current(service, 'reject-profile');
  assert.equal(signing, 0); assert.equal(publication, 0);
  service.reject(rejected);
  assert.equal(signing, 0); assert.equal(publication, 0);
  native.issue('approve-profile', origin('approve-profile'), 'wire-profile-approve', metadata);
  const approved = current(service, 'approve-profile');
  assert.equal(signing, 0); assert.equal(publication, 0);
  await service.approve(approved);
  assert.equal(signing, 1); assert.equal(publication, 1);
  const response = JSON.parse(native.responses.at(-1)!);
  assert.equal(response.ok, true); assert.equal(response.id, 'wire-profile-approve');
  assert.equal(response.event.kind, 0); assert.equal(response.event.content, metadata.content);
  await assert.rejects(service.approve(approved));
  assert.equal(signing, 1); assert.equal(publication, 1);
});

test('enforces four per session and sixteen global presentation bounds', () => {
  const native = new Native(); const service = make(native);
  for (let i = 0; i < 5; i++) native.issue(`s${i}`, origin('same'));
  for (let i = 0; i < 5; i++) assert.equal(service.enqueue(`s${i}`, [relay]), i < 4);
  for (let i = 0; i < 13; i++) native.issue(`g${i}`, origin(`g${i}`));
  for (let i = 0; i < 13; i++) assert.equal(service.enqueue(`g${i}`, [relay]), i < 12);
  assert.equal(service.getSnapshot().pending, 16); assert.equal(native.cancelled, 2); assert.equal(native.finished, 2);
});
test('UI ids are process-unique across equal wire ids and stale ids cannot approve', async () => {
  const native = new Native(); native.issue('a', origin('a'), 'same'); native.issue('b', origin('b'), 'same'); const first = make(native); const old = current(first, 'a'); first.dismiss(old); first.resume();
  const second = make(native); const next = current(second, 'b'); assert.notEqual(old, next); await assert.rejects(second.approve(old));
});
test('unfocused pending work survives while dismissal pauses all review until resume', () => {
  const native = new Native(); native.issue('a'); native.issue('b'); const service = make(native); service.enqueue('a', [relay]); service.enqueue('b', [relay]); service.focus('a'); const a = service.getSnapshot().current!.id;
  service.focus('b'); service.dismiss(service.getSnapshot().current!.id); service.focus('a'); assert.equal(service.getSnapshot().current, null); service.resume(); assert.equal(service.getSnapshot().current!.id, a);
});
test('background retains unapproved work but requires foreground then resume', () => {
  const native = new Native(); native.issue('one'); const service = make(native); const id = current(service, 'one'); service.background(); assert.equal(service.getSnapshot().pending, 1); service.resume(); assert.equal(service.getSnapshot().current, null); service.foreground(); assert.equal(service.getSnapshot().current, null); service.resume(); assert.equal(service.getSnapshot().current!.id, id);
});
test('focus change and background abort delayed signing and revoke old leases', async () => {
  const native = new Native(); native.issue('one'); native.issue('two'); const delayed = deferred<unknown>(); const service = make(native, { sign: async () => delayed.promise }); const id = current(service, 'one'); const pending = service.approve(id); service.focus('two'); delayed.resolve({}); await assert.rejects(pending); assert.equal(native.cancelled, 1);
  const second = current(service, 'two'); const running = service.approve(second); service.background(); await assert.rejects(running); assert.equal(native.cancelled, 2);
});
test('authority guards an independently delayed publish and abort signal on background', async () => {
  const native = new Native(); native.issue('one'); const published = deferred<readonly any[]>(); let calls = 0;
  const service = make(native, { publishEvent: async (_event, _destinations, execution) => { calls++; execution.assertActive(); assert.equal(execution.signal.aborted, false); return published.promise; } });
  const pending = service.approve(current(service, 'one')); await Promise.resolve(); await Promise.resolve(); service.background(); published.resolve([{ relay: `${relay}/`, eventId: 'ignored', status: 'accepted', reason: '' }]);
  await assert.rejects(pending); assert.equal(calls, 1); assert.equal(native.cancelled, 1);
});
test('close, revision change, and native expiry remove leases without cancelling expired work', () => {
  const native = new Native(); const close = native.issue('close', origin('close', 1)); native.issue('old', origin('old', 2)); const expired = native.issue('expired'); const service = make(native);
  service.enqueue('close', [relay]); service.enqueue('old', [relay]); service.enqueue('expired', [relay]); native.state(expired.lease).live = false; service.refresh(); service.close('close'); service.revisionChanged(1);
  assert.equal(service.getSnapshot().pending, 0); assert.equal(native.finished, 3); assert.equal(native.state(close.lease).live, false); assert.equal(native.cancelled, 2);
});
test('owner refusal, kind 22242, and invalid signatures never publish', async () => {
  const native = new Native(); native.issue('owner'); native.issue('auth', origin('auth'), 'auth', event(22242)); native.issue('bad'); let published = 0;
  assert.equal(make(native, {}, { assertActive: () => { throw new Error('gone'); } }).enqueue('owner', [relay]), false); assert.equal(make(native).enqueue('auth', [relay]), false);
  const service = make(native, { sign: async () => ({ id: 'bad' }), publishEvent: async () => { published++; return []; } }); await assert.rejects(service.approve(current(service, 'bad'))); assert.equal(published, 0);
});
test('post-publish revocation and malformed outcomes suppress result delivery', async () => {
  const native = new Native(); const first = native.issue('one'); const revoked = make(native, { publishEvent: async verified => { native.state(first.lease).live = false; return [{ relay, eventId: verified.id, status: 'accepted', reason: '' }]; } }); await assert.rejects(revoked.approve(current(revoked, 'one')));
  native.issue('two'); const bad = make(native, { publishEvent: async () => [{ relay, eventId: 'wrong', status: 'accepted', reason: '' }] }); await assert.rejects(bad.approve(current(bad, 'two')));
});
test('outcomes reject bogus statuses, oversized reasons, and accessor-backed rows', async () => {
  let getterCalls = 0;
  const scenarios = [
    (id: string) => ({ relay: `${relay}/`, eventId: id, status: 'success', reason: '' }),
    (id: string) => ({ relay: `${relay}/`, eventId: id, status: 'accepted', reason: 'x'.repeat(4097) }),
    (id: string) => Object.defineProperties({}, { relay: { get: () => { getterCalls++; return `${relay}/`; } }, eventId: { value: id }, status: { value: 'accepted' }, reason: { value: '' } }),
  ];
  for (const scenario of scenarios) {
    const native = new Native(); native.issue('one'); const service = make(native, { publishEvent: async verified => [scenario(verified.id)] as any });
    await assert.rejects(service.approve(current(service, 'one'))); assert.equal(service.getSnapshot().pending, 0); assert.equal(native.cancelled, 1); assert.equal(native.finished, 1);
  }
  assert.equal(getterCalls, 0);
});
test('outcomes reject array-index accessors without invoking them', async () => {
  let getterCalls = 0; const native = new Native(); native.issue('one');
  const service = make(native, { publishEvent: async verified => {
    const rows: unknown[] = []; Object.defineProperty(rows, '0', { enumerable: true, get: () => { getterCalls++; return { relay: `${relay}/`, eventId: verified.id, status: 'accepted', reason: '' }; } }); rows.length = 1; return rows as any;
  } });
  await assert.rejects(service.approve(current(service, 'one'))); assert.equal(getterCalls, 0); assert.equal(native.cancelled, 1); assert.equal(native.finished, 1);
});
test('subscriber, cleanup, and uncertain native approval failures fail closed', async () => {
  const native = new Native(); const first = native.issue('one'); native.cancel = () => { native.cancelled++; throw new Error('cancel'); }; native.finish = () => { native.finished++; throw new Error('finish'); }; const service = make(native); service.subscribe(() => { throw new Error('view'); }); await service.approve(current(service, 'one')); assert.equal(service.getSnapshot().pending, 0);
  const second = native.issue('two'); native.approveOnce = lease => { native.state(lease).approved = true; throw new Error('uncertain'); }; const next = make(native); await assert.rejects(next.approve(current(next, 'two'))); assert.equal(next.getSnapshot().pending, 0); assert.equal(first.lease === second.lease, false);
});
test('native liveness errors prune presentation and token admission errors are denied', () => {
  const native = new Native(); native.issue('one'); const service = make(native); service.enqueue('one', [relay]); native.isLive = () => { throw new Error('native unavailable'); };
  service.refresh(); assert.equal(service.getSnapshot().pending, 0); native.take = () => { throw new Error('native unavailable'); }; assert.equal(service.enqueue('two', [relay]), false);
});

test('success finishes a still-approved lease with exact original correlation and never cancels first', async () => {
  const native = new Native(); const taken = native.issue('one', origin('one'), 'guest-wire-id');
  const original = native.finish.bind(native);
  native.finish = (lease, response = null) => { assert.equal(native.isApproved(lease), true); original(lease, response); };
  const service = make(native); await service.approve(current(service, 'one'));
  const reply = JSON.parse(native.responses[0]!);
  assert.equal(reply.type, 'relay.publish.result'); assert.equal(reply.id, taken.requestId);
  assert.equal(reply.ok, true); assert.equal(reply.event.id, reply.eventId); assert.equal(native.cancelled, 0);
});
test('native capture must match the receiving trusted view before any review', () => {
  const native = new Native(); native.issue('one'); const service = make(native);
  assert.equal(service.enqueue('one', [relay], origin('different')), false);
  assert.equal(native.cancelled, 1); assert.deepEqual(native.responses, [null]);
});
test('rejection continues to the next request, dismissal pauses, and terminal failure has no success body', async () => {
  const native = new Native(); native.issue('first', origin('same')); native.issue('second', origin('same'));
  const service = make(native); service.enqueue('first', [relay]); service.enqueue('second', [relay]); service.focus('same');
  service.reject(service.getSnapshot().current!.id);
  assert.equal(service.getSnapshot().reviewPaused, false); assert(service.getSnapshot().current);
  assert.deepEqual(service.getSnapshot().pendingSessionIds, ['same']);
  service.dismiss(service.getSnapshot().current!.id); assert.equal(service.getSnapshot().reviewPaused, true);
  assert.deepEqual(native.responses, [null, null]);
  native.issue('bad'); const failure = make(native, { sign: async () => { throw new Error('failure'); } });
  await assert.rejects(failure.approve(current(failure, 'bad'))); assert.equal(native.responses.at(-1), null);
});


test('iOS inactive retains exact pending requests and requires explicit resume after active', () => {
  const native = new Native(); native.issue('one'); native.issue('two', origin('one'));
  const service = make(native); const id = current(service, 'one');
  updateApprovalAppState(service, 'inactive');
  service.enqueue('two', [relay]);
  assert.equal(service.getSnapshot().reviewPaused, true);
  assert.equal(service.getSnapshot().pending, 2);
  assert.equal(service.getSnapshot().current, null);
  service.resume(); assert.equal(service.getSnapshot().current, null);
  updateApprovalAppState(service, 'active');
  assert.equal(service.getSnapshot().reviewPaused, true);
  assert.equal(service.getSnapshot().current, null);
  assert.equal(native.cancelled, 0); assert.equal(native.finished, 0);
  service.resume(); assert.equal(service.getSnapshot().current!.id, id);
  service.reject(id); assert.equal(service.getSnapshot().current!.origin.sessionId, 'one');
  assert.equal(service.getSnapshot().pending, 1);
});

test('iOS inactive revokes a delayed approved sign before late completion can publish', async () => {
  const native = new Native(); native.issue('one'); const delayed = deferred<unknown>();
  let publications = 0; let signal: AbortSignal | undefined;
  const service = make(native, {
    sign: async (_snapshot, execution) => { signal = execution.signal; return delayed.promise; },
    publishEvent: async () => { publications++; return []; },
  });
  const pending = service.approve(current(service, 'one'));
  updateApprovalAppState(service, 'inactive');
  assert.equal(signal!.aborted, true);
  updateApprovalAppState(service, 'active'); service.resume();
  delayed.resolve({}); await assert.rejects(pending);
  assert.equal(publications, 0); assert.equal(native.cancelled, 1);
  assert.equal(service.getSnapshot().pending, 0);
  assert.deepEqual(native.responses, [null]);
});


test('close risk retains uncertain publication after presentation completes, scoped to session and identity lifetime', async () => {
  const native = new Native(); native.issue('one');
  const service = make(native, {publishEvent: async (verified, destinations) => destinations.map(relay => ({relay, eventId: verified.id, status: 'unknown' as const, reason: 'no ACK'}))});
  const id = current(service, 'one'); assert.equal(service.hasCloseRisk('one'), true);
  await service.approve(id); assert.equal(service.getSnapshot().pending, 0);
  assert.equal(service.hasCloseRisk('one'), true); assert.equal(service.hasCloseRisk('other'), false);
  service.background(); service.foreground(); assert.equal(service.hasCloseRisk('one'), true);
  service.revisionChanged(2); assert.equal(service.hasCloseRisk('one'), false);
});
test('confirmed publication clears pending close risk but transport exceptions stay uncertain until close', async () => {
  const native = new Native(); native.issue('one'); const service = make(native);
  await service.approve(current(service, 'one')); assert.equal(service.hasCloseRisk('one'), false);
  native.issue('two'); const failed = make(native, {publishEvent: async () => {throw Error('bridge unavailable');}});
  await assert.rejects(failed.approve(current(failed, 'two'))); assert.equal(failed.hasCloseRisk('two'), true);
  failed.close('two'); assert.equal(failed.hasCloseRisk('two'), false);
});


test('background after publication dispatch retains uncertainty after the pending entry is revoked', async () => {
  const native = new Native(); native.issue('one'); const held = deferred<readonly any[]>();
  let dispatched = false;
  const service = make(native, {publishEvent: async () => {dispatched = true; return held.promise;}});
  const pending = service.approve(current(service, 'one'));
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(dispatched, true);
  service.background(); assert.equal(service.getSnapshot().pending, 0);
  held.resolve([]); await assert.rejects(pending); service.foreground();
  assert.equal(service.hasCloseRisk('one'), true);
  service.close('one'); assert.equal(service.hasCloseRisk('one'), false);
});


test('exact native handoff waits for foreground delivery and keeps unrelated review paused', async () => {
  const native = new Native(), taken = native.issue('one'), gate = deferred<unknown>();
  let status: 'pending' | 'resumed' | null = null, publication = 0, captured: any;
  const service = make(native, {
    handoffState(source) { assert.deepEqual(source, { kind: 'approval', token: 'one' }); return status; },
    sign: async snapshot => { captured = snapshot; return gate.promise; },
    publishEvent: async (event, relays, authority) => {
      authority.assertActive(); publication++;
      return relays.map(relay => ({ relay, eventId: event.id, status: 'accepted' as const, reason: '' }));
    },
  });
  const pending = service.approve(current(service, 'one'));
  status = 'pending'; native.state(taken.lease).live = false; service.background(); service.refresh();
  assert.equal(service.getSnapshot().pending, 1); assert.equal(native.cancelled, 0); assert.equal(publication, 0);
  status = 'resumed'; native.state(taken.lease).live = true; gate.resolve(sign(captured));
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(publication, 0);
  service.foreground(); await pending;
  assert.equal(publication, 1); assert.equal(service.getSnapshot().reviewPaused, true);
  native.issue('two'); service.enqueue('two', [relay]); service.focus('two');
  assert.equal(service.getSnapshot().current, null);
});

for (const action of ['close', 'revision', 'query-error', 'native-revoke', 'second-background'] as const) {
  test(`handoff ${action} cannot restore publication from a late signer result`, async () => {
    const native = new Native(), taken = native.issue('one'), gate = deferred<unknown>();
    let status: 'pending' | 'resumed' | null = null, queryError = false, publication = 0, captured: any;
    const service = make(native, {
      handoffState() { if (queryError) throw new Error('Unavailable'); return status; },
      sign: async snapshot => { captured = snapshot; return gate.promise; },
      publishEvent: async () => { publication++; return []; },
    });
    const pending = service.approve(current(service, 'one')), rejected = assert.rejects(pending);
    status = 'pending'; native.state(taken.lease).live = false; service.background(); service.refresh();
    assert.equal(native.cancelled, 0);
    if (action === 'close') service.close('one');
    if (action === 'revision') service.revisionChanged(2);
    if (action === 'query-error') { queryError = true; service.refresh(); }
    if (action === 'native-revoke') { status = 'resumed'; service.foreground(); }
    if (action === 'second-background') { status = 'resumed'; service.foreground(); service.background(); }
    gate.resolve(sign(captured)); await rejected;
    assert.equal(publication, 0); assert.equal(service.getSnapshot().pending, 0);
  });
}
