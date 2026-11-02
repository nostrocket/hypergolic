import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { finalizeEvent, getEventHash, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { captureEventSnapshot } from '../../src/security/event-snapshot.ts';
import { publishEvent } from '../../src/network/relay-service.ts';

const SECRET = new Uint8Array(32); SECRET[31] = 2;
const PUBKEY = getPublicKey(SECRET);
const SNAPSHOT = captureEventSnapshot({ kind: 1, content: 'local wire proof', tags: [['t', 'wire']], created_at: 1_700_000_004 }, PUBKEY, ['wss://relay.example.org']);
const EVENT = JSON.parse(JSON.stringify(finalizeEvent({ ...SNAPSHOT.event, tags: SNAPSHOT.event.tags.map((tag) => [...tag]) }, SECRET)));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const canonicalEvent = (event) => JSON.stringify({ id: event?.id, pubkey: event?.pubkey, created_at: event?.created_at, kind: event?.kind,
  tags: event?.tags, content: event?.content, sig: event?.sig });

function execution(controller = new AbortController(), state = { active: true }) {
  return { signal: controller.signal, assertActive: () => { if (!state.active) throw new Error('revoked'); }, controller, state };
}

function clientClass(mapping, delayOpen = 0) {
  return class LocalWebSocket {
    constructor(url, protocols) {
      const target = mapping[new URL(url).hostname] ?? mapping.default;
      this.inner = new WebSocket(target, protocols);
      this.readyState = this.inner.readyState;
      this.inner.onopen = (event) => {
        this.readyState = this.inner.readyState;
        setTimeout(() => this.onopen?.(event), delayOpen);
      };
      this.inner.onmessage = (event) => this.onmessage?.(event);
      this.inner.onerror = (event) => this.onerror?.(event);
      this.inner.onclose = (event) => { this.readyState = this.inner.readyState; this.onclose?.(event); };
    }
    send(data) { this.inner.send(data); }
    close(code, reason) { this.inner.close(code, reason); }
  };
}

async function server(mode) {
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    verifyClient: mode === 'close-before-send' ? (_info, done) => done(false, 503, 'pre-send rejection') : undefined,
  });
  await once(wss, 'listening');
  const port = wss.address().port;
  const record = { frames: [], eventFrames: 0, authFrames: 0, validEvents: 0, exactEvents: 0 };
  const sockets = new Set();
  wss.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('message', (raw) => {
      let frame;
      try { frame = JSON.parse(raw.toString()); } catch { return; }
      record.frames.push(frame[0]);
      if (!Array.isArray(frame)) return;
      if (frame[0] === 'AUTH') { record.authFrames++; return; }
      if (frame[0] !== 'EVENT') return;
      record.eventFrames++;
      const event = frame[1];
      if (event && verifyEvent(event) && getEventHash(event) === event.id && Object.keys(event).length === 7) record.validEvents++;
      if (canonicalEvent(event) === canonicalEvent(EVENT)) record.exactEvents++;
      if (mode === 'close-after-send') { socket.close(); return; }
      if (mode === 'accepted') socket.send(JSON.stringify(['OK', event.id, true, 'accepted']));
      else if (mode === 'rejected') socket.send(JSON.stringify(['OK', event.id, false, 'blocked']));
      else if (mode === 'auth-required') socket.send(JSON.stringify(['OK', event.id, false, 'auth-required: local']));
    });
  });
  return {
    url: `ws://127.0.0.1:${port}`,
    record,
    close: async () => {
      for (const socket of sockets) socket.close();
      await new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}

async function run(mode, fn, options = {}) {
  const local = await server(mode);
  try {
    const Client = clientClass({ default: local.url }, options.delayOpen ?? 0);
    return await fn(local, Client);
  } finally { await local.close(); }
}

test('accepted local relay verifies the exact signed event and returns accepted', async () => {
  await run('accepted', async (local, WebSocketCtor) => {
    const result = await publishEvent(EVENT, ['wss://relay.example.org/'], execution(), { WebSocket: WebSocketCtor, timeoutMs: 500 });
    assert.equal(result[0].status, 'accepted');
    assert.equal(local.record.eventFrames, 1); assert.equal(local.record.validEvents, 1); assert.equal(local.record.exactEvents, 1); assert.deepEqual(local.record.frames, ['EVENT']);
  });
});

test('rejected and auth-required receipts never emit AUTH', async () => {
  await run('rejected', async (local, WebSocketCtor) => {
    const result = await publishEvent(EVENT, ['wss://relay.example.org/'], execution(), { WebSocket: WebSocketCtor, timeoutMs: 500 });
    assert.equal(result[0].status, 'rejected'); assert.equal(local.record.authFrames, 0);
  });
  await run('auth-required', async (local, WebSocketCtor) => {
    const result = await publishEvent(EVENT, ['wss://relay.example.org/'], execution(), { WebSocket: WebSocketCtor, timeoutMs: 500 });
    assert.equal(result[0].status, 'rejected'); assert.equal(local.record.authFrames, 0); assert.equal(local.record.eventFrames, 1);
  });
});

test('disconnect before send cancels, disconnect after send is unknown, and no reply times out unknown', async () => {
  await run('close-before-send', async (local, WebSocketCtor) => {
    const result = await publishEvent(EVENT, ['wss://relay.example.org/'], execution(), { WebSocket: WebSocketCtor, timeoutMs: 200 });
    assert.equal(result[0].status, 'cancelled-before-send'); assert.equal(local.record.eventFrames, 0);
  });
  await run('close-after-send', async (local, WebSocketCtor) => {
    const result = await publishEvent(EVENT, ['wss://relay.example.org/'], execution(), { WebSocket: WebSocketCtor, timeoutMs: 200 });
    assert.equal(result[0].status, 'unknown'); assert.equal(local.record.eventFrames, 1);
  });
  await run('none', async (local, WebSocketCtor) => {
    const result = await publishEvent(EVENT, ['wss://relay.example.org/'], execution(), { WebSocket: WebSocketCtor, timeoutMs: 40 });
    assert.equal(result[0].status, 'unknown'); assert.equal(local.record.eventFrames, 1);
  });
});

test('independent native revocation and abort before delayed open send zero EVENT frames', async () => {
  await run('accepted', async (local, WebSocketCtor) => {
    const lease = execution();
    const pending = publishEvent(EVENT, ['wss://relay.example.org/'], lease, { WebSocket: clientClass({ default: local.url }, 100), timeoutMs: 300 });
    await wait(10); lease.state.active = false;
    const result = await pending;
    assert.equal(result[0].status, 'cancelled-before-send'); assert.equal(local.record.eventFrames, 0);
  });
  await run('accepted', async (local) => {
    const lease = execution();
    const pending = publishEvent(EVENT, ['wss://relay.example.org/'], lease, { WebSocket: clientClass({ default: local.url }, 100), timeoutMs: 300 });
    await wait(10); lease.controller.abort();
    const result = await pending;
    assert.equal(result[0].status, 'cancelled-before-send'); assert.equal(local.record.eventFrames, 0);
  });
});

test('partial destinations retain per-relay acceptance and no disconnect replay', async () => {
  const accepted = await server('accepted');
  const rejected = await server('rejected');
  try {
    const WebSocketCtor = clientClass({ 'relay.example.org': accepted.url, 'relay2.example.org': rejected.url });
    const result = await publishEvent(EVENT, ['wss://relay.example.org/', 'wss://relay2.example.org/'], execution(), { WebSocket: WebSocketCtor, timeoutMs: 500 });
    assert.deepEqual(result.map((item) => item.status), ['accepted', 'rejected']);
    assert.equal(accepted.record.eventFrames, 1); assert.equal(rejected.record.eventFrames, 1);
    assert.equal(accepted.record.exactEvents, 1); assert.equal(rejected.record.exactEvents, 1);
  } finally { await accepted.close(); await rejected.close(); }
});

test('closing after the first EVENT never causes a second EVENT', async () => {
  await run('close-after-send', async (local, WebSocketCtor) => {
    const result = await publishEvent(EVENT, ['wss://relay.example.org/'], execution(), { WebSocket: WebSocketCtor, timeoutMs: 300 });
    assert.equal(result[0].status, 'unknown'); assert.equal(local.record.eventFrames, 1); assert.equal(local.record.frames.filter((type) => type === 'EVENT').length, 1);
  });
});
