#!/usr/bin/env node
import { createServer as createHTTPServer } from 'node:http';
import { createServer as createTLSServer } from 'node:https';
import { readFile, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { createPeer, MAX_FRAME_BYTES } from './peer.mjs';

const args = process.argv.slice(2), options = {};
for (let index = 0; index < args.length; index += 2) {
  const name = args[index];
  if (!['--output', '--port', '--hostname', '--fixture-keys'].includes(name) || !args[index + 1] || options[name]) throw new Error('Invalid fixture arguments');
  options[name] = args[index + 1];
}
const output = options['--output'];
const port = Number(options['--port'] ?? 0), hostname = options['--hostname'] ?? 'relay.example.org';
if (!output || !Number.isInteger(port) || port < 0 || port > 65535 || !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(hostname)) {
  throw new Error('Usage: server.mjs --output FRESH_DIRECTORY [--port PORT] [--hostname DNS_NAME]');
}
const fixtureKeys = options['--fixture-keys'];
if (fixtureKeys !== undefined && fixtureKeys !== 'public-vectors') throw new Error('Unknown fixture key mode');
await mkdir(output, { mode: 0o700 });
const privateKey = join(output, 'server.key'), certificate = join(output, 'server.pem');
const der = join(output, 'server.der');
for (const command of [
  ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', privateKey, '-out', certificate,
    '-subj', `/CN=${hostname}`, '-addext', `subjectAltName=DNS:${hostname}`, '-addext', 'extendedKeyUsage=serverAuth'],
  ['x509', '-in', certificate, '-outform', 'DER', '-out', der],
]) {
  const result = spawnSync('openssl', command, { stdio: 'ignore' });
  if (result.status !== 0) { await unlink(privateKey).catch(() => undefined); throw new Error('Fixture TLS generation failed'); }
}
const nonce = randomBytes(32).toString('hex'), secret = randomBytes(32).toString('hex');
const testScalar = value => { const key = new Uint8Array(32); key[31] = value; return key; };
const peer = createPeer({ secret, ...(fixtureKeys ? { peerKey: testScalar(7), userKey: testScalar(9) } : {}) });
const sockets = new Map();
const wire = { connections: 0, requestFrames: 0, eventFrames: 0, replyFrames: 0, rejectedFrames: 0, poisonedWrites: 0 };
let writes = Promise.resolve(), stopping = false;
function persist() {
  writes = writes.then(async () => {
    const temporary = join(output, 'receipt.json.tmp');
    await writeFile(temporary, JSON.stringify({ scope: 'Disposable controlled NIP-46 peer; no native or publication claim',
      keyMode: fixtureKeys ?? 'ephemeral', wire, ...peer.receipt() }, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, join(output, 'receipt.json'));
  });
  return writes;
}

// One TLS write supplies a valid response followed by deliberately invalid framing.
// Native decoder proofs separately establish the exact one-read boundary.
function poisonedReply(text, fault) {
  const body = Buffer.from(text);
  if (body.length > MAX_FRAME_BYTES) throw new Error('Fixture reply exceeds bound');
  const header = Buffer.alloc(body.length < 126 ? 2 : body.length < 65536 ? 4 : 10);
  header[0] = 0x81;
  if (body.length < 126) header[1] = body.length;
  else if (body.length < 65536) { header[1] = 126; header.writeUInt16BE(body.length, 2); }
  else { header[1] = 127; header.writeBigUInt64BE(BigInt(body.length), 2); }
  const suffix = fault === 'valid-plus-invalid-suffix'
    ? Buffer.from([0x81, 0x80, 0, 0, 0, 0]) // Server frames must not be masked.
    : Buffer.from([0x88, 0, 0x81, 0]); // Empty close followed by another frame.
  return Buffer.concat([header, body, suffix]);
}

function deliver(socket, subscriptions, outcome) {
  if (socket.readyState !== 1) return;
  if (outcome.close) { socket.terminate(); return; }
  for (const event of outcome.events) for (const subscription of subscriptions) {
    // Invalid peer/recipient frames are intentional: native clients must validate them.
    const reply = JSON.stringify(['EVENT', subscription, event]);
    if (outcome.wireFault) {
      socket._socket.write(poisonedReply(reply, outcome.wireFault)); wire.poisonedWrites++;
    } else socket.send(reply);
    wire.replyFrames++;
  }
}

async function control(request, response) {
  if (request.headers['x-fixture-control'] !== nonce) { response.writeHead(403).end(); return; }
  if (request.method === 'GET' && request.url === '/status') {
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(peer.receipt())); return;
  }
  if (request.method !== 'POST' || request.url !== '/control') { response.writeHead(404).end(); return; }
  try {
    let bytes = 0; const chunks = [];
    for await (const chunk of request) { bytes += chunk.length; if (bytes > 16384) throw new Error('Too large'); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some(key => !['fault', 'method', 'relays', 'stringRelays', 'authURL', 'completeAuth'].includes(key))) throw new Error('Invalid control');
    if (Object.hasOwn(body, 'fault')) peer.setFault(body.fault, body.method);
    if (Object.hasOwn(body, 'relays')) peer.setRelays(body.relays, body.stringRelays);
    if (Object.hasOwn(body, 'authURL')) peer.setAuthURL(body.authURL);
    if (Object.hasOwn(body, 'completeAuth')) {
      const outcome = peer.completeAuth(body.completeAuth);
      for (const [socket, subscriptions] of sockets) deliver(socket, subscriptions, outcome);
    }
    await persist(); response.writeHead(200).end('{}');
  } catch { response.writeHead(400).end('Invalid fixture control'); }
}

const tls = createTLSServer({ key: await readFile(privateKey), cert: await readFile(certificate), minVersion: 'TLSv1.2' },
  (_request, response) => response.writeHead(404).end());
const controlServer = createHTTPServer((request, response) => { void control(request, response); });
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
tls.on('upgrade', (request, socket, head) => {
  if (!['/signer', '/changed'].includes(request.url) || sockets.size >= 8 || stopping) { socket.destroy(); return; }
  wss.handleUpgrade(request, socket, head, client => wss.emit('connection', client));
});
wss.on('connection', socket => {
  const subscriptions = new Set();
  sockets.set(socket, subscriptions); wire.connections++;
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => socket.terminate());
  socket.on('message', (raw, binary) => {
    try {
      if (binary) throw new Error('Expected text');
      const frame = JSON.parse(raw.toString());
      if (!Array.isArray(frame)) throw new Error('Invalid frame');
      if (frame[0] === 'REQ' && frame.length >= 3 && frame.length <= 5 && typeof frame[1] === 'string' && frame[1].length <= 128) {
        wire.requestFrames++;
        if (subscriptions.size >= 4) throw new Error('Too many subscriptions');
        subscriptions.add(frame[1]); socket.send(JSON.stringify(['EOSE', frame[1]]));
      } else if (frame[0] === 'CLOSE' && frame.length === 2) subscriptions.delete(frame[1]);
      else if (frame[0] === 'EVENT' && frame.length === 2) {
        wire.eventFrames++;
        const outcome = peer.processEvent(frame[1]);
        if (outcome.close) socket.terminate();
        else {
          socket.send(JSON.stringify(['OK', frame[1]?.id ?? '', outcome.accepted, outcome.accepted ? '' : 'invalid fixture request']));
          deliver(socket, subscriptions, outcome);
        }
      } else throw new Error('Unsupported frame');
    } catch { wire.rejectedFrames++; socket.close(1008, 'Invalid fixture request'); }
    void persist().catch(() => socket.terminate());
  });
});
const listen = (server, requestedPort) => new Promise((resolve, reject) => {
  server.once('error', reject); server.listen(requestedPort, '127.0.0.1', () => resolve(server.address().port));
});
async function close() {
  if (stopping) return;
  stopping = true;
  for (const socket of sockets.keys()) socket.terminate();
  tls.close(); controlServer.close(); wss.close();
  try { await persist(); } finally { peer.close(); await unlink(privateKey).catch(() => undefined); }
}
try {
  const tlsPort = await listen(tls, port), controlPort = await listen(controlServer, 0);
  const relayURL = `wss://${hostname}:${tlsPort}/signer`;
  await writeFile(join(output, 'ready.json'), JSON.stringify({ host: '127.0.0.1', hostname, port: tlsPort,
    keyMode: fixtureKeys ?? 'ephemeral', relayURL, changedRelayURL: `wss://${hostname}:${tlsPort}/changed`, certificate, der,
    peerPubkey: peer.peerPubkey, userPubkey: peer.userPubkey,
    bunkerURL: `bunker://${peer.peerPubkey}?relay=${encodeURIComponent(relayURL)}&secret=${secret}`,
    controlURL: `http://127.0.0.1:${controlPort}/control`, statusURL: `http://127.0.0.1:${controlPort}/status`, nonce,
  }, null, 2) + '\n', { mode: 0o600 });
  await persist();
} catch (error) { await close(); throw error; }
process.once('SIGINT', () => { void close().then(() => process.exit(0)); });
process.once('SIGTERM', () => { void close().then(() => process.exit(0)); });
