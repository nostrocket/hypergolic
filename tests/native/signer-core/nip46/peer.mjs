import { createHash } from 'node:crypto';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { decrypt, encrypt, getConversationKey } from 'nostr-tools/nip44';

export const FAULTS = Object.freeze(['none', 'wrong-id', 'wrong-peer', 'wrong-recipient',
  'invalid-outer-id', 'invalid-outer-signature', 'bad-mac', 'changed-event',
  'wrong-user', 'wrong-public-key', 'invalid-inner-id', 'invalid-inner-signature', 'refusal',
  'auth-url', 'close-after-send', 'no-response', 'duplicate',
  'valid-plus-invalid-suffix', 'valid-plus-close-trailing']);
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_REQUESTS = 128;
const changed = value => (value[0] === '0' ? '1' : '0') + value.slice(1);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const verified = event => {
  try { return verifyEvent(structuredClone(event)); } catch { return false; }
};

/** Test-only signer. Its receipt omits scalars, connection tokens and decrypted connect parameters. */
export function createPeer(options = {}) {
  const peerKey = options.peerKey?.slice() ?? generateSecretKey();
  const userKey = options.userKey?.slice() ?? generateSecretKey();
  const foreignKey = generateSecretKey();
  const peerPubkey = getPublicKey(peerKey), userPubkey = getPublicKey(userKey);
  if (peerPubkey === userPubkey) throw new Error('Fixture peer and user keys must differ');
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const sessions = new Set(), replies = new Map(), pendingAuth = new Map(), requests = [];
  let fault = 'none', faultMethod = 'sign_event', relays = null, stringRelays = false;
  let authURL = 'https://auth.example.org/fixture', authCompletions = 0;
  let receivedBytes = 0, receivedEvents = 0, invalidEvents = 0, signatures = 0, closed = false;

  function responseEvent(client, response, mode) {
    const conversation = getConversationKey(peerKey, client);
    let content;
    try { content = encrypt(JSON.stringify(response), conversation); } finally { conversation.fill(0); }
    if (mode === 'bad-mac') {
      const bytes = Buffer.from(content, 'base64'); bytes[bytes.length - 1] ^= 1;
      content = bytes.toString('base64'); bytes.fill(0);
    }
    const recipient = mode === 'wrong-recipient' ? getPublicKey(foreignKey) : client;
    const event = finalizeEvent({ kind: 24133, created_at: now(), tags: [['p', recipient]], content },
      mode === 'wrong-peer' ? foreignKey : peerKey);
    if (mode === 'invalid-outer-id') event.id = changed(event.id);
    if (mode === 'invalid-outer-signature') event.sig = changed(event.sig);
    return event;
  }

  function sign(params, mode, entry) {
    if (params.length !== 1) throw new Error('invalid params');
    const template = JSON.parse(params[0]);
    const fields = ['kind', 'created_at', 'tags', 'content'];
    if (Object.hasOwn(template, 'pubkey')) fields.push('pubkey');
    if (!exact(template, fields) || (template.pubkey !== undefined && template.pubkey !== userPubkey)) throw new Error('wrong account');
    entry.approvedEvent = structuredClone(template);
    const candidate = { ...template, ...(mode === 'changed-event' ? { content: template.content + ' changed' } : {}) };
    const signed = finalizeEvent(candidate, mode === 'wrong-user' ? foreignKey : userKey);
    signatures++;
    if (mode === 'invalid-inner-id') signed.id = changed(signed.id);
    if (mode === 'invalid-inner-signature') signed.sig = changed(signed.sig);
    entry.returnedEvent = structuredClone(signed);
    return JSON.stringify(signed);
  }

  function result(request, client, mode, entry) {
    const { method, params } = request;
    if (method === 'connect') {
      // Fixed fixture diagnostics only. Never retain tokens, parameters or exception strings.
      const refuse = code => { entry.fixtureRejectionCode = code; throw new Error('connection refused'); };
      if (params.length < 1 || params.length > 4) refuse('connect-param-count');
      if (params[0] !== peerPubkey) refuse('connect-peer-mismatch');
      if (options.secret !== undefined && params[1] !== options.secret) refuse('connect-token-mismatch');
      if (sessions.size && !sessions.has(client)) refuse('connect-session-client-mismatch');
      if (params.length === 4) {
        try { JSON.parse(params[3]); } catch { refuse('connect-metadata-invalid'); }
      }
      sessions.add(client); return 'ack';
    }
    if (!sessions.has(client)) throw new Error('connect required');
    if (method === 'sign_event') return sign(params, mode, entry);
    if (params.length !== 0) throw new Error('invalid params');
    if (method === 'get_public_key') return mode === 'wrong-public-key' ? getPublicKey(foreignKey) : userPubkey;
    if (method === 'switch_relays') return stringRelays ? JSON.stringify(relays) : relays;
    if (method === 'ping') return 'pong';
    if (method === 'logout') { sessions.delete(client); return 'ack'; }
    throw new Error('unsupported method');
  }

  function decode(event) {
    if (!exact(event, ['id', 'pubkey', 'created_at', 'kind', 'tags', 'content', 'sig']) ||
        event.kind !== 24133 || JSON.stringify(event.tags) !== JSON.stringify([['p', peerPubkey]]) || !verified(event)) throw new Error('invalid outer event');
    const conversation = getConversationKey(peerKey, event.pubkey);
    let request;
    try { request = JSON.parse(decrypt(event.content, conversation)); } finally { conversation.fill(0); }
    if (!exact(request, ['id', 'method', 'params']) || typeof request.id !== 'string' ||
        request.id.length < 1 || request.id.length > 128 || typeof request.method !== 'string' ||
        request.method.length > 32 || !Array.isArray(request.params) || request.params.length > 4 ||
        !request.params.every(value => typeof value === 'string')) throw new Error('invalid RPC');
    return request;
  }

  function processEvent(event) {
    if (closed) throw new Error('Fixture is closed');
    const bytes = Buffer.byteLength(JSON.stringify(event));
    receivedEvents++; receivedBytes += bytes;
    if (bytes > MAX_FRAME_BYTES || receivedBytes > 32 * 1024 * 1024 || receivedEvents > 256) throw new Error('Fixture traffic limit');
    let request;
    try { request = decode(event); } catch { invalidEvents++; return { events: [], accepted: false, close: false }; }
    const key = `${event.pubkey}:${request.id}`, inputHash = digest(request);
    const previous = replies.get(key);
    if (previous) {
      if (previous.inputHash !== inputHash) { invalidEvents++; return { events: [], accepted: false, close: false }; }
      return structuredClone(previous.outcome);
    }
    if (requests.length >= MAX_REQUESTS) throw new Error('Fixture request limit');
    const mode = request.method === faultMethod ? fault : 'none';
    const entry = { id: request.id, method: request.method, clientPubkey: event.pubkey, eventId: event.id, fault: mode };
    requests.push(entry);
    let response = { id: mode === 'wrong-id' ? request.id + '-foreign' : request.id };
    if (mode === 'refusal') response.error = 'Fixture signer refused';
    else if (mode === 'auth-url') {
      Object.assign(response, { result: 'auth_url', error: authURL });
      pendingAuth.set(key, { request, client: event.pubkey, entry });
    }
    else {
      try { response.result = result(request, event.pubkey, mode, entry); }
      catch { response.error = 'Fixture request rejected'; }
    }
    const events = ['close-after-send', 'no-response'].includes(mode) ? [] : [responseEvent(event.pubkey, response, mode)];
    if (mode === 'duplicate') events.push(structuredClone(events[0]));
    const outcome = { events, accepted: true, close: mode === 'close-after-send',
      ...(mode.startsWith('valid-plus-') ? { wireFault: mode } : {}) };
    replies.set(key, { inputHash, outcome });
    return structuredClone(outcome);
  }

  function completeAuth(value) {
    if (closed || !exact(value, ['clientPubkey', 'id', 'decision']) ||
        typeof value.clientPubkey !== 'string' || typeof value.id !== 'string' ||
        !['approve', 'refuse'].includes(value.decision)) throw new Error('Invalid fixture completion');
    const key = `${value.clientPubkey}:${value.id}`, pending = pendingAuth.get(key);
    if (!pending) throw new Error('No matching fixture authentication');
    pendingAuth.delete(key); authCompletions++;
    const mode = faultMethod === pending.request.method && fault !== 'auth-url' ? fault : 'none';
    const response = { id: mode === 'wrong-id' ? pending.request.id + '-foreign' : pending.request.id };
    if (value.decision === 'refuse' || mode === 'refusal') {
      response.error = 'Fixture authentication refused'; pending.entry.authResult = 'refused';
    } else {
      try {
        response.result = result(pending.request, pending.client, mode, pending.entry);
        pending.entry.authResult = response.result === 'ack' ? 'ack' : 'result';
      } catch { response.error = 'Fixture request rejected'; pending.entry.authResult = 'error'; }
    }
    pending.entry.authDecision = value.decision;
    const events = ['close-after-send', 'no-response'].includes(mode) ? [] : [responseEvent(pending.client, response, mode)];
    if (mode === 'duplicate') events.push(structuredClone(events[0]));
    const outcome = { events, accepted: true, close: mode === 'close-after-send',
      ...(mode.startsWith('valid-plus-') ? { wireFault: mode } : {}) };
    replies.get(key).outcome = outcome;
    return structuredClone(outcome);
  }

  return Object.freeze({ peerPubkey, userPubkey, processEvent, completeAuth,
    setAuthURL(value) {
      if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid fixture authentication URL');
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Invalid fixture authentication URL');
      authURL = url.href;
    },
    setFault(value, method = 'sign_event') {
      if (!FAULTS.includes(value) || typeof method !== 'string' || method.length > 32) throw new Error('Invalid fixture fault');
      fault = value; faultMethod = method;
    },
    setRelays(value, encoded = false) {
      if (value !== null && (!Array.isArray(value) || value.length > 4 || !value.every(item => typeof item === 'string' && item.length < 4096))) throw new Error('Invalid fixture relay set');
      relays = value === null ? null : [...value]; stringRelays = encoded === true;
    },
    receipt: () => structuredClone({ peerPubkey, userPubkey, receivedEvents, receivedBytes, invalidEvents,
      signatures, authCompletions, pendingAuth: pendingAuth.size, methodCounts: Object.fromEntries([...new Set(requests.map(item => item.method))].map(method =>
        [method, requests.filter(item => item.method === method).length])), requests }),
    close() { closed = true; peerKey.fill(0); userKey.fill(0); foreignKey.fill(0); sessions.clear(); replies.clear(); pendingAuth.clear(); },
  });
}
