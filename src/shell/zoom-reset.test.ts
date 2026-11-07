import assert from 'node:assert/strict';
import test from 'node:test';
import {createZoomResetTarget, NativeZoomRequests, ZoomResetAction, ZoomResetTargets, type NativeZoomView, type ZoomResetContext} from './zoom-reset.ts';
import type {NappletDescriptor} from './workspace.ts';

const first: NappletDescriptor = Object.freeze({id: 'first', title: 'Reader', publisher: 'publisher', appId: 'reader', version: 'one', source: 'published'});
const second: NappletDescriptor = Object.freeze({...first, id: 'second'});
const tick = async () => {await Promise.resolve(); await Promise.resolve();};
function fixture() {
  const calls: string[][] = [], order: string[] = [];
  let result: Promise<boolean> = Promise.resolve(true);
  const view: NativeZoomView = {resetZoom: (id, generation) => {calls.push([id, generation]); order.push('native'); return result;}};
  let state = {view: view as NativeZoomView | null, generation: 'ready-first' as string | null, available: true};
  const target = createZoomResetTarget(first.id, 'ready-first', view, () => state);
  const action = new ZoomResetAction(), targets = new ZoomResetTargets();
  const unregister = targets.register(target);
  let context: ZoomResetContext = {workspace: {sessions: [first, second], focusedId: first.id, overview: false},
    identity: 'owner', lifetime: {}, active: true, blocked: false};
  const frames: (() => void)[] = [];
  let errors = 0;
  const start = () => action.request(first, targets.get(first.id), () => context, () => order.push('dismiss'), run => {
    frames.push(run); return () => {const i = frames.indexOf(run); if (i >= 0) frames.splice(i, 1);};
  }, () => {errors++;});
  return {calls, order, action, target, targets, unregister, start, flush: () => frames.splice(0).forEach(run => run()),
    context: () => context, change: (patch: Partial<ZoomResetContext>) => {context = {...context, ...patch};},
    state: (patch: Partial<typeof state>) => {state = {...state, ...patch};}, errorCount: () => errors,
    result: (next: Promise<boolean>) => {result = next;}};
}

test('one explicit selection dismisses the menu before calling the exact captured native view/generation', async () => {
  const h = fixture(); h.start(); assert.deepEqual(h.order, ['dismiss']); assert.equal(h.calls.length, 0);
  h.flush(); await tick(); assert.deepEqual(h.order, ['dismiss', 'native']);
  assert.deepEqual(h.calls, [['first', 'ready-first']]); assert.equal(h.errorCount(), 0);
});

for (const interruption of ['selection', 'overview', 'close', 'identity', 'owner', 'background', 'review'] as const) {
  test(`${interruption} between menu selection and native invocation has no effect`, async () => {
    const h = fixture(); h.start();
    if (interruption === 'selection') h.change({workspace: {...h.context().workspace, focusedId: second.id}});
    if (interruption === 'overview') h.change({workspace: {...h.context().workspace, overview: true}});
    if (interruption === 'close') h.change({workspace: {...h.context().workspace, sessions: [second]}});
    if (interruption === 'identity') h.change({identity: 'other'});
    if (interruption === 'owner') h.change({lifetime: {}});
    if (interruption === 'background') h.change({active: false});
    if (interruption === 'review') h.change({blocked: true});
    h.flush(); await tick(); assert.deepEqual(h.calls, []); assert.equal(h.errorCount(), 0);
  });
}

for (const interruption of ['background-resume', 'focus-round-trip', 'unmount'] as const) {
  test(`${interruption} cancellation cannot replay on a later frame`, async () => {
    const h = fixture(); h.start(); h.action.cancel(); h.flush(); await tick();
    assert.deepEqual(h.calls, []); assert.equal(h.errorCount(), 0);
  });
}

for (const interruption of ['replaced-view', 'replaced-generation', 'detached', 'inactive'] as const) {
  test(`a captured ${interruption} target never resets its replacement`, async () => {
    const h = fixture(); h.start();
    if (interruption === 'replaced-view') h.state({view: {resetZoom: async () => {throw Error('must not resolve to replacement');}}});
    if (interruption === 'replaced-generation') h.state({generation: 'ready-second'});
    if (interruption === 'detached') h.state({view: null});
    if (interruption === 'inactive') h.state({available: false});
    h.flush(); await tick(); assert.deepEqual(h.calls, []); assert.equal(h.errorCount(), 1);
    h.flush(); await tick(); assert.deepEqual(h.calls, []); assert.equal(h.errorCount(), 1);
  });
}

test('old registration cleanup cannot remove a new native target with the same session ID', async () => {
  const h = fixture(); const current = createZoomResetTarget(first.id, 'replacement', {resetZoom: async () => true}, () => ({view: null, generation: null, available: false}));
  const removeCurrent = h.targets.register(current); h.unregister(); assert.equal(h.targets.get(first.id), current);
  removeCurrent(); assert.equal(h.targets.get(first.id), null);
});

test('a newer explicit action replaces the pending frame rather than replaying both', async () => {
  const h = fixture(); h.start(); h.start(); h.flush(); await tick(); assert.equal(h.calls.length, 1);
});

test('unavailable target reports failure without dismissing the menu or starting native work', async () => {
  const h = fixture(); h.unregister(); h.start(); h.flush(); await tick();
  assert.deepEqual(h.order, []); assert.equal(h.errorCount(), 1); assert.equal(h.calls.length, 0);
});

test('a stale menu callback cannot show an unavailable-target alert over a different selection', async () => {
  const h = fixture(); h.unregister(); h.change({workspace: {...h.context().workspace, focusedId: second.id}});
  h.start(); h.flush(); await tick(); assert.equal(h.errorCount(), 0); assert.equal(h.calls.length, 0);
});

test('replacing the descriptor under the same session ID after selection does not reset the old view', async () => {
  const h = fixture(); h.start();
  h.change({workspace: {...h.context().workspace, sessions: [{...first, version: 'replacement'}, second]}});
  h.flush(); await tick(); assert.deepEqual(h.calls, []); assert.equal(h.errorCount(), 0);
});

for (const nativeOutcome of ['false', 'reject'] as const) {
  test(`native ${nativeOutcome} is not retried and a late failure cannot interrupt the next selection`, async () => {
    const h = fixture(); let finish!: (value: boolean) => void, reject!: (error: Error) => void;
    h.result(new Promise((resolve, fail) => {finish = resolve; reject = fail;})); h.start(); h.flush();
    h.change({workspace: {...h.context().workspace, focusedId: second.id}}); h.action.cancel();
    if (nativeOutcome === 'false') finish(false); else reject(Error('native unavailable'));
    await tick(); assert.equal(h.calls.length, 1); assert.equal(h.errorCount(), 0);
  });
}

test('current native failure is reported once, while a successful no-op reset remains successful', async () => {
  const h = fixture(); h.result(Promise.resolve(false)); h.start(); h.flush(); await tick(); assert.equal(h.errorCount(), 1);
  h.result(Promise.resolve(true)); h.start(); h.flush(); await tick(); assert.equal(h.errorCount(), 1); assert.equal(h.calls.length, 2);
});

function requests() {
  let now = 1_000;
  const sent: string[] = [], owner = new NativeZoomRequests(raw => sent.push(raw), () => now);
  const reply = (patch: object = {}) => owner.receive({type: 'zoom-reset', sessionId: 'first', generation: 'ready-first', sequence: 1, ok: true, ...patch});
  return {owner, sent, reply, now: (value: number) => {now = value;}};
}

test('prop command and native acknowledgement carry only the captured session, generation and monotonic sequence', async () => {
  const h = requests(), result = h.owner.request('first', 'ready-first');
  assert.deepEqual(JSON.parse(h.sent[0]), {sessionId: 'first', generation: 'ready-first', sequence: 1, issuedAt: 1_000});
  h.reply(); assert.equal(await result, true); h.reply(); assert.deepEqual(h.sent.slice(1), ['']);
});

test('wrong source, generation, sequence and malformed acknowledgements never satisfy a pending reset', async () => {
  const h = requests(); let settled = false;
  const result = h.owner.request('first', 'ready-first').then(value => {settled = true; return value;});
  for (const patch of [{type: 'other'}, {sessionId: 'second'}, {generation: 'replacement'}, {sequence: 2}, {ok: 'true'}, {extra: true}]) h.reply(patch);
  await tick(); assert.equal(settled, false); assert.equal(h.sent.length, 1);
  h.reply({ok: false}); assert.equal(await result, false); assert.equal(h.sent.length, 2);
});

test('cancellation clears one waiter and a late acknowledgement cannot confirm the next request', async () => {
  const h = requests(), first = h.owner.request('first', 'ready-first'); h.owner.cancel(); assert.equal(await first, false);
  let settled = false; const second = h.owner.request('first', 'ready-first').then(value => {settled = true; return value;});
  h.reply(); await tick(); assert.equal(settled, false);
  h.reply({sequence: 2}); assert.equal(await second, true);
});

test('absolute acknowledgement deadline holds even if its timer callback has not run', async () => {
  const h = requests(), result = h.owner.request('first', 'ready-first'); h.now(2_100); h.reply();
  assert.equal(await result, false); assert.equal(h.sent.length, 2);
});

test('one timeout settles without any automatic command replay', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const h = requests(), result = h.owner.request('first', 'ready-first'); h.now(2_100); t.mock.timers.tick(1_100);
  assert.equal(await result, false); t.mock.timers.tick(10_000); assert.equal(h.sent.length, 2);
});

test('a retired timer cannot shorten a replacement request deadline', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const h = requests(), first = h.owner.request('first', 'ready-first');
  h.now(1_500); t.mock.timers.tick(500); let settled = false;
  const second = h.owner.request('first', 'ready-first').then(value => {settled = true; return value;});
  assert.equal(await first, false); h.now(2_100); t.mock.timers.tick(600); await tick(); assert.equal(settled, false);
  h.now(2_600); t.mock.timers.tick(500); assert.equal(await second, false);
});

test('throwing command and cleanup ports still settle once without a retry', async () => {
  let calls = 0; const owner = new NativeZoomRequests(() => {calls++; throw Error('port unavailable');});
  assert.equal(await owner.request('first', 'ready-first'), false); assert.equal(calls, 2);
  owner.cancel(); assert.equal(calls, 2);
});

test('failure to clear a delivered prop cannot replace a confirmed native result', async () => {
  const owner = new NativeZoomRequests(raw => {if (!raw) throw Error('view removed');});
  const result = owner.request('first', 'ready-first');
  owner.receive({type: 'zoom-reset', sessionId: 'first', generation: 'ready-first', sequence: 1, ok: true});
  assert.equal(await result, true);
});

test('unmount cancellation settles the waiter without writing a prop to the removed component', async () => {
  const h = requests(), result = h.owner.request('first', 'ready-first');
  h.owner.cancel(false); assert.equal(await result, false); h.reply();
  assert.equal(h.sent.length, 1);
});

test('target subscriptions update menu availability while stale unregistration leaves its replacement present', () => {
  const h = fixture(), snapshots: number[] = [];
  const removeListener = h.targets.subscribe(() => snapshots.push(h.targets.getSnapshot()));
  const replacement = {...h.target, reset: async () => true};
  const removeTarget = h.targets.register(replacement); h.unregister();
  assert.deepEqual(snapshots, [2]); assert.equal(h.targets.get(first.id), replacement);
  removeTarget(); assert.deepEqual(snapshots, [2, 3]); assert.equal(h.targets.get(first.id), null);
  removeListener(); h.targets.register(h.target); assert.deepEqual(snapshots, [2, 3]);
});
