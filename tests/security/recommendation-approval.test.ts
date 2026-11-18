import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { ApprovalService, type ApprovalEffects } from '../../src/security/approval-service.ts';
import { createNativeApprovalPort, type ApprovalModule } from '../../src/runtime/approval-port.ts';
import type { CatalogRecommendationGuard } from '../../src/napplets/catalog-recommendation.ts';
import type { EventSnapshot } from '../../src/security/event-snapshot.ts';
import { publishEvent } from '../../src/network/relay-service.ts';

const secret = new Uint8Array(32).fill(2);
const user = getPublicKey(secret);
const configured = ['wss://one.example.org/', 'wss://two.example.org/', 'wss://three.example.org/'];
const coordinate = `35129:${'1'.repeat(64)}:battleship`;
const template = {kind: 30267, content: '', tags: [['d', 'napplets'], ['a', coordinate]], created_at: 1_790_000_000};
const registration = {sessionId: 'discover', generation: 'g1', epoch: 1, user, publisher: '2'.repeat(64), appId: 'discovery',
  version: '3'.repeat(64), instanceId: 'discover-1', fixture: 'discovery', domains: ['relay']};
const signed = (snapshot: EventSnapshot) => JSON.parse(JSON.stringify(finalizeEvent({...snapshot.event, tags: snapshot.event.tags.map(tag => [...tag])}, secret)));
function setup(effects: Partial<ApprovalEffects> = {}, owner = {assertActive() {}}) {
  const prepared: EventSnapshot[] = [], replies: (string | null)[] = [];
  let live = true, approved = false, taken = false, cancellations = 0;
  const module: ApprovalModule = {
    takeApproval: () => { if (taken) return null; taken = true; return JSON.stringify({registration, request: JSON.stringify({type: 'relay.publish', id: 'recommend', event: template})}); },
    prepareApprovalSigning: (_token, raw) => { prepared.push(JSON.parse(raw)); return live; },
    isApprovalLive: () => live, mayReviewApproval: () => live && !approved,
    approveApproval: () => { if (!live || approved) return false; approved = true; return true; },
    isApprovalApproved: () => live && approved, cancelApproval: () => { cancellations++; live = false; },
    dismissApproval: () => { live = false; }, resumeApprovals() {},
    finishApproval: (_token, reply) => { replies.push(reply); live = false; },
  };
  const service = new ApprovalService(createNativeApprovalPort(module), owner, {
    sign: async snapshot => signed(snapshot), publishEvent: async () => assert.fail('Unexpected publication'), ...effects,
  });
  const enqueue = (guard: CatalogRecommendationGuard) => {
    assert(service.enqueue('trusted-token', configured, registration, captured => {
      assert.deepEqual(captured.destinations, configured);
      return guard;
    }));
    service.focus('discover');
    return service.getSnapshot().current!;
  };
  return {service, enqueue, prepared, replies, cancelled: () => cancellations};
}
function guard(destinations?: readonly string[], excludedRelays?: readonly string[]) {
  const released: boolean[] = [];
  return Object.assign(async (_signal: AbortSignal, active: () => void) => { active(); },
    {destinations, excludedRelays, release: (retry: boolean) => { released.push(retry); }, released});
}
class Socket {
  static urls: string[] = [];
  static frames: unknown[] = [];
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: {data: string}) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  readonly url: string;
  constructor(url: string) { this.url = url; Socket.urls.push(url); queueMicrotask(() => { this.readyState = 1; this.onopen?.({}); }); }
  send(raw: string) {
    const frame = JSON.parse(raw); Socket.frames.push(frame);
    queueMicrotask(() => this.onmessage?.({data: JSON.stringify(['OK', frame[1].id, true, 'saved'])}));
  }
  close() { this.readyState = 3; this.onclose?.({wasClean: true}); }
}

test('one-time recommendation binds the full configuration then reviews, signs and actually publishes only its immutable subset', async () => {
  Socket.urls = []; Socket.frames = [];
  const destinations = [configured[0]!, configured[2]!], excluded = [configured[1]!];
  const check = guard(destinations, excluded);
  const run = setup({
    sign: async snapshot => {
      assert.deepEqual(snapshot.destinations, [configured[0], configured[2]]);
      assert.deepEqual(run.prepared[0], JSON.parse(JSON.stringify(snapshot)));
      assert(Object.isFrozen(snapshot.destinations));
      destinations.splice(0, destinations.length, configured[1]!);
      excluded.splice(0, excluded.length, configured[0]!, configured[2]!);
      return signed(snapshot);
    },
    publishEvent: (event, relays, authority) => publishEvent(event, relays, authority, {WebSocket: Socket as never, timeoutMs: 1000}),
  });
  const review = run.enqueue(check);
  assert.equal(review.recommendation, coordinate);
  assert.deepEqual(review.recommendationExcludedRelays, [configured[1]]);
  assert(Object.isFrozen(review.recommendationExcludedRelays));
  const results = await run.service.approve(review.id);
  assert.deepEqual(Socket.urls, [configured[0], configured[2]]);
  assert.equal(Socket.frames.length, 2);
  assert.deepEqual(Socket.frames[0], Socket.frames[1]);
  assert.deepEqual(results.map(row => row.relay), Socket.urls);
  assert.equal(JSON.parse(run.replies[0]!).ok, true);
  assert.deepEqual(check.released, [false]);
  await assert.rejects(run.service.approve(review.id));
});

test('full recommendation mode keeps every configured destination and has no subset warning metadata', async () => {
  const check = guard();
  const run = setup({publishEvent: async (event, relays) => {
    assert.deepEqual(relays, configured);
    return relays.map(relay => ({relay, eventId: event.id, status: 'accepted' as const, reason: ''}));
  }});
  const review = run.enqueue(check);
  assert.equal(review.recommendationExcludedRelays, undefined);
  await run.service.approve(review.id);
  assert.deepEqual(run.prepared[0]!.destinations, configured);
});

test('invalid, widened, reordered or incomplete subset partitions never reach native review', () => {
  const cases = [
    guard([], configured), guard(configured, []), guard([configured[0]!], [configured[1]!]),
    guard([configured[0]!], [configured[0]!, configured[1]!, configured[2]!]),
    guard(['wss://foreign.example.org/'], [configured[1]!, configured[2]!]),
    guard([configured[2]!, configured[0]!], [configured[1]!]),
    guard([configured[1]!], [configured[2]!, configured[0]!]),
    guard([configured[0]!], undefined), guard(undefined, [configured[1]!, configured[2]!]),
  ];
  for (const check of cases) {
    const run = setup();
    assert.equal(run.service.enqueue('token', configured, registration, () => check), false);
    run.service.focus('discover');
    assert.equal(run.service.getSnapshot().current, null);
    assert.deepEqual(run.prepared, []);
    assert.equal(run.cancelled(), 1);
    assert.deepEqual(check.released, [true]);
  }
});

test('rejecting the subset review has no signing or publication effect and releases known-unsent preparation', () => {
  const check = guard([configured[0]!], [configured[1]!, configured[2]!]);
  const run = setup({sign: async () => assert.fail('Rejected review must not sign')});
  run.service.reject(run.enqueue(check).id);
  assert.deepEqual(run.prepared, []);
  assert.deepEqual(check.released, [true]);
  assert.equal(run.cancelled(), 1);
});

for (const staleCheck of [1, 2]) test(`stale subset revalidation at checkpoint ${staleCheck} suppresses publication`, async () => {
  let checks = 0, signatures = 0;
  const released: boolean[] = [];
  const check = Object.assign(async (_signal: AbortSignal, active: () => void) => {
    active(); if (++checks === staleCheck) throw new Error('Changed relay coverage or list');
  }, {destinations: [configured[0]!], excludedRelays: [configured[1]!, configured[2]!], release: (retry: boolean) => released.push(retry)});
  const run = setup({sign: async snapshot => { signatures++; return signed(snapshot); }});
  await assert.rejects(run.service.approve(run.enqueue(check).id));
  assert.equal(signatures, staleCheck === 1 ? 0 : 1);
  assert.equal(run.prepared.length, signatures);
  assert.deepEqual(released, [true]);
});

test('account change during signing revokes the exact subset and suppresses a late signature', async () => {
  let active = true;
  const check = guard([configured[0]!], [configured[1]!, configured[2]!]);
  const run = setup({sign: async snapshot => { active = false; return signed(snapshot); }},
    {assertActive() { if (!active) throw new Error('Account changed'); }});
  await assert.rejects(run.service.approve(run.enqueue(check).id));
  assert.deepEqual(run.prepared[0]!.destinations, [configured[0]]);
  assert.deepEqual(check.released, [true]);
  assert.equal(run.cancelled(), 1);
});
