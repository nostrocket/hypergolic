import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeApprovalPort, type ApprovalModule } from '../../src/runtime/approval-port.ts';
import { ApprovalService } from '../../src/security/approval-service.ts';
const registration = { sessionId: 'approval-one', generation: 'generation-one', epoch: 1, user: '11'.repeat(32), publisher: '22'.repeat(32), appId: 'approval-lab', version: '33'.repeat(32), instanceId: 'instance-one', fixture: 'approval-lab', domains: ['identity', 'relay', 'theme'] };
const event = { kind: 1, content: 'Review exactly this', tags: [], created_at: 1700000000 };
const request = { type: 'relay.publish', id: 'wire-id', event };
function setup(raw: string | null = JSON.stringify({ registration, request: JSON.stringify(request) })) {
  const calls: unknown[][] = []; let taken = false;
  const native: ApprovalModule = {
    takeApproval(token) { calls.push(['take', token]); if (taken) return null; taken = true; return raw; },
    prepareApprovalSigning: (token, snapshot) => { calls.push(['prepare-signing', token, JSON.parse(snapshot)]); return true; },
    isApprovalLive: token => { calls.push(['live', token]); return true; },
    mayReviewApproval: () => true, approveApproval: () => true, isApprovalApproved: () => true,
    cancelApproval: token => { calls.push(['cancel', token]); }, dismissApproval: token => { calls.push(['dismiss', token]); },
    finishApproval: (token, response) => { calls.push(['finish', token, response]); }, resumeApprovals: () => { calls.push(['resume']); },
  };
  return { port: createNativeApprovalPort(native), calls, native };
}
test('opaque leases bind native tokens, claim once, and expire from the adapter on finish', () => {
  const { port, calls } = setup(); const taken = port.take('secret-native-token'); assert(taken);
  assert.deepEqual(Object.keys(taken.lease), []); assert.equal(port.take('secret-native-token'), null);
  assert.equal(port.isLive(taken.lease), true); assert.throws(() => port.approveOnce({}));
  port.finish(taken.lease, 'response'); assert.throws(() => port.isLive(taken.lease));
  assert.deepEqual(calls.at(-1), ['finish', 'secret-native-token', 'response']);
});
test('malformed captures, wrong domains and altered envelopes terminate only the claimed native token', () => {
  const variants = ['{', JSON.stringify({ registration, request: request }),
    JSON.stringify({ registration: { ...registration, domains: ['identity'] }, request: JSON.stringify(request) }),
    ...[{ ...request, type: 'storage.set' }, { ...request, extra: true }, { ...request, id: '' }].map(value => JSON.stringify({ registration, request: JSON.stringify(value) }))];
  for (const raw of variants) {
    const { port, calls } = setup(raw); assert.equal(port.take('owned'), null);
    assert.deepEqual(calls.slice(-2), [['cancel', 'owned'], ['finish', 'owned', null]]);
  }
});
test('native snapshot binds the queue to the receiving generation and freezes reviewed content', () => {
  const { port, calls } = setup(); let ownerCalls = 0;
  const queue = new ApprovalService(port, { assertActive: () => { ownerCalls++; } }, { sign: async () => assert.fail(), publishEvent: async () => assert.fail() });
  assert.equal(queue.enqueue('owned', ['wss://relay.example.org'], { ...registration, generation: 'foreign' }), false);
  assert.equal(ownerCalls, 0); assert.deepEqual(calls.at(-1), ['finish', 'owned', null]);
  const next = setup(); const valid = new ApprovalService(next.port, { assertActive() {} }, { sign: async () => assert.fail(), publishEvent: async () => assert.fail() });
  assert(valid.enqueue('valid', ['wss://relay.example.org'], registration)); valid.focus(registration.sessionId);
  assert(Object.isFrozen(valid.getSnapshot().current!.event.event)); assert.equal(valid.getSnapshot().current!.event.event.content, event.content);
});


test('native signing preparation preserves the source token and exact public snapshot', () => {
  const { port, calls } = setup(); const taken = port.take('owned'); assert(taken);
  const next = setup(); const service = new ApprovalService(next.port, { assertActive() {} }, { sign: async () => assert.fail(), publishEvent: async () => assert.fail() });
  assert(service.enqueue('reviewed', ['wss://relay.example.org'], registration)); service.focus(registration.sessionId);
  const snapshot = service.getSnapshot().current!.event;
  assert.equal(port.prepareSigning!(taken.lease, snapshot), true);
  assert.deepEqual(calls.at(-1), ['prepare-signing', 'owned', JSON.parse(JSON.stringify(snapshot))]);
  assert.deepEqual(port.signingSource!(taken.lease), { kind: 'approval', token: 'owned' });
  assert.throws(() => port.prepareSigning!({}, snapshot));
  port.finish(taken.lease); assert.throws(() => port.signingSource!(taken.lease));
});

test('failed native snapshot binding stops before review approval or signing', async () => {
  const { port, native, calls } = setup();
  native.prepareApprovalSigning = () => false;
  native.approveApproval = () => { assert.fail('unbound snapshot must not be approved'); };
  const service = new ApprovalService(port, { assertActive() {} }, { sign: async () => assert.fail(), publishEvent: async () => assert.fail() });
  assert(service.enqueue('owned', ['wss://relay.example.org'], registration)); service.focus(registration.sessionId);
  await assert.rejects(service.approve(service.getSnapshot().current!.id), /APPROVAL_DENIED/);
  assert(calls.some(row => row[0] === 'cancel'));
});
