#!/usr/bin/env node
import { createServer } from 'node:http';
import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { getEventHash, verifyEvent } from 'nostr-tools/pure';

const EXPECTED_PUBKEY = 'c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5';
const RELAYS = Object.freeze({
  '/relay.damus.io': 'wss://relay.damus.io/',
  '/nos.lol': 'wss://nos.lol/',
  '/bucket.coracle.social': 'wss://bucket.coracle.social/',
});
const MODES = new Set(['accept', 'reject', 'auth-required', 'close-after-send', 'hold-upgrade']);
const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const output = option('--output');
let mode = option('--mode') ?? 'accept';
if (!output || !MODES.has(mode)) throw new Error('Usage: native-review-server.mjs --output <fresh-directory> [--mode accept|reject|auth-required|close-after-send|hold-upgrade]');
await mkdir(output, { recursive: true });
for (const name of ['ready.json', 'receipt.json']) {
  try { await access(`${output}/${name}`); throw new Error(`Output is not fresh: ${name} already exists`); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
}

const nonce = randomBytes(32).toString('base64url');
const now = () => new Date().toISOString();
const frames = [];
const sockets = new Set();
const heldUpgrades = new Set();
let server;
let writes = Promise.resolve();

function canonical(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const fields = ['id', 'pubkey', 'created_at', 'kind', 'tags', 'content', 'sig'];
  if (Reflect.ownKeys(event).length !== fields.length || !fields.every(field => Object.hasOwn(event, field))) return null;
  return Object.fromEntries(fields.map(field => [field, event[field]]));
}

function record(path, raw) {
  const entry = { time: now(), path, raw: raw.toString() };
  try {
    entry.frame = JSON.parse(entry.raw);
    entry.type = Array.isArray(entry.frame) && typeof entry.frame[0] === 'string' ? entry.frame[0] : 'invalid-frame';
  } catch { entry.type = 'invalid-json'; }
  frames.push(entry);
  return entry;
}

function eventReceipt(entry) {
  const event = Array.isArray(entry.frame) && entry.frame.length === 2 && entry.frame[0] === 'EVENT' ? entry.frame[1] : null;
  const wire = canonical(event);
  if (!wire) return { valid: false, event: null, reason: 'non-canonical EVENT' };
  let verified = false;
  try {
    const fresh = structuredClone(wire);
    verified = verifyEvent(fresh) && getEventHash(fresh) === fresh.id;
  } catch { verified = false; }
  return { valid: verified && wire.pubkey === EXPECTED_PUBKEY, event: wire,
    reason: verified ? (wire.pubkey === EXPECTED_PUBKEY ? 'valid' : 'unexpected pubkey') : 'invalid signature or hash' };
}

function status() {
  const events = frames.filter(frame => frame.type === 'EVENT').map(eventReceipt);
  const counts = frames.reduce((result, frame) => ({ ...result, [frame.type]: (result[frame.type] ?? 0) + 1 }), {});
  return { generatedAt: now(), mode, heldUpgrades: heldUpgrades.size, expectedPubkey: EXPECTED_PUBKEY, relayPaths: RELAYS, counts, frames, events };
}

function persist() {
  writes = writes.catch(() => undefined).then(async () => {
    const temporary = `${output}/receipt.json.tmp`;
    await writeFile(temporary, `${JSON.stringify(status(), null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, `${output}/receipt.json`);
  });
  return writes;
}

function sendOutcome(socket, event) {
  if (mode === 'close-after-send') { socket.close(); return; }
  if (mode === 'hold-upgrade') return;
  const accepted = mode === 'accept';
  const reason = accepted ? 'accepted by isolated local proof server' : mode === 'auth-required' ? 'auth-required: unsupported by approval proof' : 'rejected by isolated local proof server';
  socket.send(JSON.stringify(['OK', event?.id ?? '', accepted, reason]));
}

function authorize(request) { return request.headers['x-local-review-nonce'] === nonce; }

async function control(request, response, acceptUpgrade) {
  if (!authorize(request)) { response.writeHead(403).end('forbidden'); return; }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 8192) throw new Error('request too large');
      chunks.push(chunk);
    }
  } catch { response.writeHead(413).end('request too large'); return; }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { response.writeHead(400).end('invalid json'); return; }
  if (!body || typeof body !== 'object' || Array.isArray(body) || (Object.hasOwn(body, 'mode') && (typeof body.mode !== 'string' || !MODES.has(body.mode))) || (Object.hasOwn(body, 'release') && body.release !== true) || (Object.hasOwn(body, 'reset') && body.reset !== true)) {
    response.writeHead(400).end('invalid control request'); return;
  }
  if (body.reset === true) {
    frames.splice(0);
    for (const pending of heldUpgrades) pending.socket.destroy();
    heldUpgrades.clear();
  }
  if (body.mode) mode = body.mode;
  if (body.release === true) {
    for (const pending of heldUpgrades) acceptUpgrade(pending.request, pending.socket, pending.head, pending.path);
    heldUpgrades.clear();
  }
  await persist();
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ mode, heldUpgrades: heldUpgrades.size, frames: frames.length }));
}

const http = createServer();
const wss = new WebSocketServer({ noServer: true });
const acceptUpgrade = (request, socket, head, path) => {
  if (socket.destroyed) return;
  wss.handleUpgrade(request, socket, head, client => wss.emit('connection', client, request, path));
};
http.on('request', async (request, response) => {
  if (request.method === 'GET' && request.url === '/status') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(status()));
  } else if (request.method === 'POST' && request.url === '/control') await control(request, response, acceptUpgrade);
  else response.writeHead(404).end('not found');
});
http.on('upgrade', (request, socket, head) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  if (!Object.hasOwn(RELAYS, path)) { socket.destroy(); return; }
  if (mode === 'hold-upgrade') { heldUpgrades.add({ request, socket, head, path }); return; }
  acceptUpgrade(request, socket, head, path);
});
wss.on('connection', (socket, request, path) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('message', async raw => {
    const entry = record(path, raw);
    await persist();
    if (entry.type === 'EVENT' && Array.isArray(entry.frame) && entry.frame.length === 2) sendOutcome(socket, entry.frame[1]);
  });
});
server = http.listen(0, '127.0.0.1', async () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const ready = { host: '127.0.0.1', port, mode, nonce, relayPaths: RELAYS, expectedPubkey: EXPECTED_PUBKEY,
    status: `http://127.0.0.1:${port}/status`, control: `http://127.0.0.1:${port}/control` };
  await writeFile(`${output}/ready.json`, `${JSON.stringify(ready, null, 2)}\n`, { mode: 0o600 });
  await persist();
});

async function close() {
  for (const pending of heldUpgrades) pending.socket.destroy();
  heldUpgrades.clear();
  for (const socket of sockets) socket.close();
  await persist();
  await new Promise(resolve => server.close(resolve));
}
process.once('SIGINT', () => { void close().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void close().finally(() => process.exit(0)); });
