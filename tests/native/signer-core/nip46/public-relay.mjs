#!/usr/bin/env node
/** Disposable production-TLS peer. Publishes only encrypted NIP-46 responses to its own test clients. */
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createPeer, MAX_FRAME_BYTES } from './peer.mjs';

const args = process.argv.slice(2), relays = [];
let output, duration = 900;
for (let index = 0; index < args.length; index += 2) {
  const name = args[index], value = args[index + 1];
  if (!value) throw new Error('Missing fixture argument');
  if (name === '--output' && !output) output = value;
  else if (name === '--relay') relays.push(value);
  else if (name === '--seconds') duration = Number(value);
  else throw new Error('Invalid fixture argument');
}
const configured = JSON.parse(await readFile(new URL('../../../../src/config/fixture-release.json', import.meta.url), 'utf8'));
if (!output || relays.length < 1 || relays.length > 2 || new Set(relays).size !== relays.length ||
    relays.some(relay => !configured.relays.includes(relay)) || !Number.isInteger(duration) || duration < 30 || duration > 900 ||
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('Use a fresh output directory and one or two configured WSS relays');
await mkdir(output, { mode: 0o700 });
const secret = randomBytes(32).toString('hex'), nonce = randomBytes(32).toString('hex');
const peer = createPeer({ secret }), sockets = new Map(), sent = new Set();
const subscription = `hg-fixture-${randomBytes(12).toString('hex')}`;
const wire = { receivedFrames: 0, receivedBytes: 0, encryptedReplies: 0, acceptedReplies: [], rejectedReplies: [], eose: [] };
let writes = Promise.resolve(), stopped = false, deadline;
const sourceHashes = Object.fromEntries(await Promise.all(['public-relay.mjs', 'peer.mjs'].map(async name =>
  [name, createHash('sha256').update(await readFile(new URL(name, import.meta.url))).digest('hex')])));
function persist(status = 'running') {
  writes = writes.then(async () => {
    const temporary = join(output, 'receipt.json.tmp');
    await writeFile(temporary, JSON.stringify({ status, scope: 'Controlled own NIP-46 peer over configured public WSS; no user event publication',
      relays, sourceHashes, wire, ...peer.receipt() }, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, join(output, 'receipt.json'));
  });
  return writes;
}
function deliver(outcome) {
  if (outcome.close) { for (const socket of sockets.values()) socket.terminate(); return; }
  for (const event of outcome.events) {
    if (event.kind !== 24133 || event.pubkey !== peer.peerPubkey) throw new Error('Only this peer encrypted responses may leave the fixture');
    if (sent.size >= 256) throw new Error('Fixture response limit');
    sent.add(event.id);
    for (const socket of sockets.values()) if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(['EVENT', event])); wire.encryptedReplies++;
    }
  }
}
async function control(request, response) {
  if (request.headers['x-fixture-control'] !== nonce) { response.writeHead(403).end(); return; }
  if (request.method === 'GET' && request.url === '/status') {
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(peer.receipt())); return;
  }
  if (request.method !== 'POST' || request.url !== '/control') { response.writeHead(404).end(); return; }
  try {
    let length = 0; const chunks = [];
    for await (const chunk of request) { length += chunk.length; if (length > 16384) throw new Error('Too large'); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some(key => !['relays', 'authURL', 'auth', 'authMethod', 'completeAuth'].includes(key))) throw new Error('Invalid fixture control');
    if (Object.hasOwn(body, 'relays')) {
      if (body.relays !== null && (!Array.isArray(body.relays) || body.relays.some(relay => !relays.includes(relay)))) throw new Error('Unconfigured relay');
      peer.setRelays(body.relays);
    }
    if (Object.hasOwn(body, 'authMethod') && (!Object.hasOwn(body, 'auth') ||
        !['connect', 'get_public_key', 'switch_relays'].includes(body.authMethod))) throw new Error('Invalid authentication method');
    if (Object.hasOwn(body, 'authURL')) peer.setAuthURL(body.authURL);
    if (Object.hasOwn(body, 'auth')) {
      if (typeof body.auth !== 'boolean') throw new Error('Invalid authentication switch');
      peer.setFault(body.auth ? 'auth-url' : 'none', body.authMethod ?? 'sign_event');
    }
    if (Object.hasOwn(body, 'completeAuth')) deliver(peer.completeAuth(body.completeAuth));
    await persist(); response.writeHead(200).end('{}');
  } catch { response.writeHead(400).end('Invalid fixture control'); }
}
const server = createServer((request, response) => { void control(request, response); });
async function close(status) {
  if (stopped) return; stopped = true; clearTimeout(deadline);
  for (const socket of sockets.values()) socket.terminate();
  server.close();
  try { await persist(status); } finally { peer.close(); }
}
try {
  for (const relay of relays) {
    const socket = new WebSocket(relay, { handshakeTimeout: 15000, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false, rejectUnauthorized: true });
    sockets.set(relay, socket);
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.on('error', () => { void close('transport-error'); });
    socket.on('close', () => { if (!stopped) void close('transport-closed'); });
    socket.on('message', (raw, binary) => {
      try {
        wire.receivedFrames++; wire.receivedBytes += raw.byteLength;
        if (binary || wire.receivedFrames > 1024 || wire.receivedBytes > 32 * 1024 * 1024) throw new Error('Fixture traffic bound');
        const frame = JSON.parse(raw.toString());
        if (!Array.isArray(frame)) throw new Error('Invalid relay frame');
        if (frame[0] === 'EVENT' && frame.length === 3 && frame[1] === subscription) deliver(peer.processEvent(frame[2]));
        else if (frame[0] === 'EOSE' && frame[1] === subscription) wire.eose.push(relay);
        else if (frame[0] === 'OK' && sent.has(frame[1])) {
          const row = { relay, eventId: frame[1] };
          (frame[2] === true ? wire.acceptedReplies : wire.rejectedReplies).push(row);
        } else if (frame[0] === 'CLOSED' && frame[1] === subscription) throw new Error('Subscription rejected');
        void persist().catch(() => { void close('receipt-error'); });
      } catch { void close('protocol-error'); }
    });
    socket.send(JSON.stringify(['REQ', subscription, { kinds: [24133], '#p': [peer.peerPubkey], since: Math.floor(Date.now() / 1000) - 5 }]));
  }
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  if (stopped) throw new Error('Fixture stopped during startup');
  const query = relays.map(relay => `relay=${encodeURIComponent(relay)}`).join('&');
  await writeFile(join(output, 'ready.json'), JSON.stringify({ peerPubkey: peer.peerPubkey, userPubkey: peer.userPubkey,
    relays, bunkerURL: `bunker://${peer.peerPubkey}?${query}&secret=${secret}`,
    controlURL: `http://127.0.0.1:${port}/control`, statusURL: `http://127.0.0.1:${port}/status`, nonce }, null, 2) + '\n', { mode: 0o600 });
  await persist(); deadline = setTimeout(() => { void close('deadline'); }, duration * 1000);
} catch (error) { await close('startup-failed'); throw error; }
process.once('SIGINT', () => { void close('stopped'); });
process.once('SIGTERM', () => { void close('stopped'); });
