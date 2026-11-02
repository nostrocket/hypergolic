import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { sha256, validateReleasePair } from './release-pair.mjs';

const TIMEOUT_MS = 20_000;
const MAX_DESCRIPTOR_BYTES = 4096;
const MAX_RELAY_FRAME_BYTES = 64 * 1024 + 1024;
const MAX_READBACK_EVENTS = 32;

async function boundedBody(response, maximumBytes) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Blossom response body missing');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || value.byteLength > maximumBytes - size) {
        throw new Error('Blossom response body exceeded expected size');
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* The read failure is authoritative. */ }
    throw error;
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

export async function uploadRevision(server, revision, secret, fetcher = fetch) {
  const url = new URL(server);
  const now = Math.floor(Date.now() / 1000);
  const token = finalizeEvent({ kind: 24242, created_at: now, content: 'Upload Hypergolic disposable QA HTML', tags: [
    ['t', 'upload'], ['expiration', String(now + 300)], ['server', url.hostname.toLowerCase()], ['x', revision.hash],
  ] }, secret);
  if (!verifyEvent(token)) throw new Error('Blossom authorization signature failed');
  const bytes = Buffer.from(revision.html);
  const result = await fetcher(new URL('/upload', url), {
    method: 'PUT', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), body: bytes,
    headers: {
      'Content-Type': 'text/html; charset=utf-8', 'Content-Length': String(bytes.length),
      'X-SHA-256': revision.hash,
      Authorization: 'Nostr ' + Buffer.from(JSON.stringify(token)).toString('base64url'),
    },
  });
  if (result.status !== 200 && result.status !== 201) throw new Error('Blossom upload rejected: HTTP ' + result.status);
  let descriptor;
  try { descriptor = JSON.parse((await boundedBody(result, MAX_DESCRIPTOR_BYTES)).toString('utf8')); }
  catch { throw new Error('Blossom descriptor invalid or oversized'); }
  if (descriptor?.sha256 !== revision.hash || descriptor.size !== bytes.length) throw new Error('Blossom descriptor mismatch');
  const readback = await verifyPublicBlob(server, revision, fetcher);
  return { status: result.status, hash: revision.hash, bytes: readback.bytes };
}

export async function verifyPublicBlob(server, revision, fetcher = fetch) {
  const readback = await fetcher(new URL(revision.hash, server), {
    method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (readback.status !== 200 || readback.redirected) throw new Error('Blossom direct readback failed');
  const expectedBytes = Buffer.byteLength(revision.html);
  const body = await boundedBody(readback, expectedBytes);
  if (body.length !== expectedBytes || sha256(body) !== revision.hash) {
    throw new Error('Blossom readback mismatch');
  }
  return { hash: revision.hash, bytes: body.length };
}

export async function uploadPair(bundle, secret, fetcher = fetcherDefault) {
  validateReleasePair(bundle);
  if (!(secret instanceof Uint8Array) || secret.byteLength !== 32 || getPublicKey(secret) !== bundle.publisher) {
    throw new Error('QA upload key does not match the signed publisher');
  }
  const receipts = [];
  for (const revision of bundle.revisions) receipts.push(await uploadRevision(bundle.server, revision, secret, fetcher));
  return receipts;
}

function fetcherDefault(...args) { return fetch(...args); }

export function publishToRelay(relay, event, WebSocketClass = WebSocket) {
  if (!verifyEvent(event)) return Promise.reject(new Error('Unsigned QA event'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = new WebSocketClass(relay);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* close after settle */ }
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Relay publication timeout')), TIMEOUT_MS);
    socket.onopen = () => socket.send(JSON.stringify(['EVENT', event]));
    socket.onmessage = message => {
      let reply;
      try { reply = JSON.parse(message.data); } catch { return; }
      if (!Array.isArray(reply) || reply[0] !== 'OK' || reply[1] !== event.id) return;
      if (reply[2] === true) finish(null, { relay, eventId: event.id, accepted: true });
      else finish(new Error('Relay rejected signed QA event: ' + String(reply[3] ?? 'unknown')));
    };
    socket.onerror = () => finish(new Error('Relay publication transport failed'));
    socket.onclose = () => finish(new Error('Relay closed before publication acknowledgement'));
  });
}

/** Check the same unpinned coordinate query that the app uses after relay acknowledgement. */
export function readBackRevision(relay, event, WebSocketClass = WebSocket) {
  if (!verifyEvent(event)) return Promise.reject(new Error('Unsigned QA event'));
  const identifier = event.tags.find(tag => tag[0] === 'd')?.[1];
  if (event.kind !== 35129 || typeof identifier !== 'string') {
    return Promise.reject(new Error('Invalid QA coordinate'));
  }
  return new Promise((resolve, reject) => {
    const subscription = 'hgqa-' + event.id.slice(0, 16);
    let settled = false;
    let found = false;
    let count = 0;
    const socket = new WebSocketClass(relay);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* close after settle */ }
      if (error) reject(error);
      else resolve({ relay, eventId: event.id, queryable: true });
    };
    const timer = setTimeout(() => finish(new Error('Relay readback timeout')), TIMEOUT_MS);
    socket.onopen = () => {
      try {
        socket.send(JSON.stringify(['REQ', subscription, {
          kinds: [35129], authors: [event.pubkey], '#d': [identifier], limit: MAX_READBACK_EVENTS,
        }]));
      } catch { finish(new Error('Relay readback request failed')); }
    };
    socket.onmessage = message => {
      if (typeof message.data !== 'string' || Buffer.byteLength(message.data) > MAX_RELAY_FRAME_BYTES) {
        finish(new Error('Relay readback frame invalid or oversized'));
        return;
      }
      let reply;
      try { reply = JSON.parse(message.data); } catch {
        finish(new Error('Relay readback JSON invalid'));
        return;
      }
      if (!Array.isArray(reply) || reply[1] !== subscription) return;
      if (reply[0] === 'EVENT') {
        count++;
        const candidate = reply[2];
        let valid = false;
        try {
          valid = verifyEvent(candidate) && candidate.kind === 35129 && candidate.pubkey === event.pubkey &&
            candidate.tags.some(tag => tag[0] === 'd' && tag[1] === identifier);
        } catch { /* An invalid relay event fails below. */ }
        if (count > MAX_READBACK_EVENTS || !valid) {
          finish(new Error('Relay readback event invalid'));
          return;
        }
        if (candidate.id === event.id) found = true;
      } else if (reply[0] === 'EOSE') {
        finish(found ? null : new Error('Relay acknowledged but exact QA revision was not queryable'));
      } else if (reply[0] === 'CLOSED') {
        finish(new Error('Relay closed the QA readback subscription'));
      }
    };
    socket.onerror = () => finish(new Error('Relay readback transport failed'));
    socket.onclose = () => finish(new Error('Relay closed before QA readback EOSE'));
  });
}

export async function publishRevision(bundle, revision, WebSocketClass = WebSocket) {
  validateReleasePair(bundle);
  const index = revision === 'v1' ? 0 : revision === 'v2' ? 1 : -1;
  if (index < 0) throw new Error('Select v1 or v2');
  const event = bundle.revisions[index].event;
  const results = await Promise.allSettled(bundle.relays.map(relay => publishToRelay(relay, event, WebSocketClass)));
  const acknowledged = results.filter(result => result.status === 'fulfilled').map(result => result.value);
  if (acknowledged.length === 0) throw new Error('No configured lookup relay accepted the QA revision');
  const readbacks = await Promise.allSettled(acknowledged.map(result =>
    readBackRevision(result.relay, event, WebSocketClass)));
  const accepted = readbacks.filter(result => result.status === 'fulfilled').map(result => result.value);
  if (accepted.length === 0) throw new Error('Relay acknowledged but no lookup relay made the QA revision queryable');
  return { revision, eventId: event.id, accepted, failures: results.length - accepted.length };
}
