import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { captureEventSnapshot } from '../../src/security/event-snapshot.ts';
import { publishEvent, RelayServiceError, type RelayPublishOptions } from '../../src/network/relay-service.ts';

const SECRET = new Uint8Array(32); SECRET[31] = 2;
const PUBKEY = getPublicKey(SECRET);
const SNAPSHOT = captureEventSnapshot({ kind: 1, content: 'relay proof', tags: [['t', 'relay']], created_at: 1_700_000_003 }, PUBKEY, ['wss://relay.example.org']);
const EVENT = JSON.parse(JSON.stringify(finalizeEvent({ ...SNAPSHOT.event, tags: SNAPSHOT.event.tags.map((tag) => [...tag]) }, SECRET)));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

type Handler = ((event: any) => void) | null;
class FakeWebSocket {
  static sockets: FakeWebSocket[] = [];
  readonly url: string;
  readyState = 0;
  sent: string[] = [];
  throwOnSend = false;
  onopen: Handler = null; onmessage: Handler = null; onerror: Handler = null; onclose: Handler = null;
  constructor(url: string) { this.url = url; FakeWebSocket.sockets.push(this); }
  send(data: string): void { if (this.throwOnSend) throw new Error('send failed'); this.sent.push(data); }
  open(): void { this.readyState = 1; this.onopen?.({}); }
  message(frame: unknown): void { this.onmessage?.({ data: JSON.stringify(frame) }); }
  close(): void { this.readyState = 3; this.onclose?.({ wasClean: true }); }
  fail(): void { this.readyState = 3; this.onerror?.({}); }
  static reset(): void { this.sockets = []; }
  static get last(): FakeWebSocket { return this.sockets.at(-1)!; }
}

const options = (timeoutMs = 100): RelayPublishOptions => ({ WebSocket: FakeWebSocket as never, timeoutMs });
const execution = (controller: AbortController, active = { value: true }) => ({
  assertActive: () => { if (!active.value) throw new Error('revoked'); }, signal: controller.signal,
  revoke: () => { active.value = false; },
});
async function start(controller = new AbortController(), timeoutMs = 100) {
  FakeWebSocket.reset();
  const pending = publishEvent(EVENT, ['wss://relay.example.org/'], execution(controller), options(timeoutMs));
  await tick();
  const socket = FakeWebSocket.last;
  socket.open();
  await tick();
  return { pending, socket, controller };
}

test('accepts and rejects only strict matching remote OK frames', async () => {
  let run = await start();
  assert.equal(run.socket.sent.length, 1);
  assert.deepEqual(JSON.parse(run.socket.sent[0]!), ['EVENT', EVENT]);
  run.socket.message(['OK', EVENT.id, true, 'saved']);
  assert.deepEqual(await run.pending, [{ relay: 'wss://relay.example.org/', eventId: EVENT.id, status: 'accepted', reason: 'saved' }]);

  run = await start();
  run.socket.message(['OK', 'wrong-id', true, 'wrong']);
  run.socket.message(['OK', EVENT.id, false, 'blocked']);
  assert.deepEqual(await run.pending, [{ relay: 'wss://relay.example.org/', eventId: EVENT.id, status: 'rejected', reason: 'blocked' }]);

  run = await start();
  run.socket.message(['OK', EVENT.id, false, 'Timeout']);
  assert.deepEqual((await run.pending)[0]!.status, 'rejected');
});

test('delayed open cancellation closes the queued socket without sending', async () => {
  FakeWebSocket.reset();
  const controller = new AbortController();
  const pending = publishEvent(EVENT, ['wss://relay.example.org/'], execution(controller), options(200));
  await tick();
  const socket = FakeWebSocket.last;
  controller.abort();
  assert.deepEqual(await pending, [{ relay: 'wss://relay.example.org/', eventId: EVENT.id, status: 'cancelled-before-send', reason: 'aborted' }]);
  socket.open();
  await tick();
  assert.deepEqual(socket.sent, []);
});

test('native revocation without AbortSignal blocks a late open', async () => {
  FakeWebSocket.reset();
  const controller = new AbortController();
  const state = { value: true };
  const lease = execution(controller, state);
  const pending = publishEvent(EVENT, ['wss://relay.example.org/'], lease, options(200));
  await tick();
  const socket = FakeWebSocket.last;
  lease.revoke();
  socket.open();
  assert.deepEqual(await pending, [{ relay: 'wss://relay.example.org/', eventId: EVENT.id, status: 'cancelled-before-send', reason: 'relay error' }]);
  assert.deepEqual(socket.sent, []);
});

test('timeout before open marks cancellation and blocks a later queued send', async () => {
  FakeWebSocket.reset();
  const controller = new AbortController();
  const pending = publishEvent(EVENT, ['wss://relay.example.org/'], execution(controller), options(20));
  await tick();
  const socket = FakeWebSocket.last;
  assert.deepEqual(await pending, [{ relay: 'wss://relay.example.org/', eventId: EVENT.id, status: 'cancelled-before-send', reason: 'timeout' }]);
  socket.open();
  await tick();
  assert.deepEqual(socket.sent, []);
});

test('malformed matching OK and auth-required are never accepted or auto-authenticated', async () => {
  let run = await start();
  run.socket.message(['OK', EVENT.id, 'true', 'bad-type']);
  assert.deepEqual((await run.pending)[0]!.status, 'unknown');

  run = await start();
  run.socket.message(['OK', EVENT.id, false, 'auth-required: challenge']);
  assert.deepEqual((await run.pending)[0]!.status, 'rejected');
  assert.equal(run.socket.sent.length, 1);
});

test('matching OK before EVENT dispatch is ignored', async () => {
  FakeWebSocket.reset();
  const controller = new AbortController();
  const pending = publishEvent(EVENT, ['wss://relay.example.org/'], execution(controller), options(40));
  await tick();
  const socket = FakeWebSocket.last;
  socket.message(['OK', EVENT.id, true, 'unsolicited']);
  socket.open();
  await tick();
  socket.message(['OK', EVENT.id, true, 'saved']);
  assert.deepEqual((await pending)[0]!.status, 'accepted');
});

test('abort after raw send is unknown and cannot replay the event', async () => {
  const run = await start();
  run.controller.abort();
  assert.deepEqual(await run.pending, [{ relay: 'wss://relay.example.org/', eventId: EVENT.id, status: 'unknown', reason: 'aborted' }]);
  run.socket.open();
  await tick();
  assert.equal(run.socket.sent.length, 1);
});

test('timeout after dispatch is unknown', async () => {
  const run = await start(new AbortController(), 20);
  assert.deepEqual(await run.pending, [{ relay: 'wss://relay.example.org/', eventId: EVENT.id, status: 'unknown', reason: 'timeout' }]);
});

test('native revocation before OK makes a dispatched result unknown', async () => {
  FakeWebSocket.reset();
  const controller = new AbortController();
  const state = { value: true };
  const lease = execution(controller, state);
  const pending = publishEvent(EVENT, ['wss://relay.example.org/'], lease, options(100));
  await tick();
  const socket = FakeWebSocket.last; socket.open(); await tick();
  lease.revoke();
  socket.message(['OK', EVENT.id, true, 'late']);
  assert.deepEqual((await pending)[0]!.status, 'unknown');
});

test('raw send failure is unknown after the dispatch attempt', async () => {
  FakeWebSocket.reset();
  const controller = new AbortController();
  const pending = publishEvent(EVENT, ['wss://relay.example.org/'], execution(controller), options(100));
  await tick();
  const socket = FakeWebSocket.last; socket.throwOnSend = true; socket.open();
  assert.deepEqual((await pending)[0]!.status, 'unknown');
});

test('rejects malformed destinations, oversized destination lists and ordinary AUTH events before opening sockets', async () => {
  const invalid = async (destinations: readonly string[], event = EVENT) => {
    FakeWebSocket.reset();
    await assert.rejects(() => publishEvent(event, destinations, execution(new AbortController()), options()), RelayServiceError);
    assert.equal(FakeWebSocket.sockets.length, 0);
  };
  await invalid(['wss://user:pass@relay.example.org/']);
  await invalid(['wss://127.0.0.1/']);
  await invalid(Array.from({ length: 17 }, (_, index) => `wss://relay${index}.example.org/`));
  await invalid(['wss://relay.example.org/'], { ...EVENT, kind: 22242 });
});

test('rejects nested getters without executing them', async () => {
  let reads = 0;
  const tags: unknown[] = []; tags.length = 1;
  Object.defineProperty(tags, '0', { get: () => { reads++; return ['t']; }, enumerable: true });
  FakeWebSocket.reset();
  await assert.rejects(() => publishEvent({ ...EVENT, tags } as never, ['wss://relay.example.org/'], execution(new AbortController()), options()), RelayServiceError);
  assert.equal(reads, 0); assert.equal(FakeWebSocket.sockets.length, 0);
});
