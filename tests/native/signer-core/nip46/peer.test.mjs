import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { decrypt, encrypt, getConversationKey } from 'nostr-tools/nip44';
import { createPeer, FAULTS } from './peer.mjs';

const scalar = value => { const key = new Uint8Array(32); key[31] = value; return key; };
const clientKey = scalar(11), clientPubkey = getPublicKey(clientKey);
const template = { kind: 1, created_at: 123456, tags: [['t', 'native-signer-proof']], content: 'Exact approved event' };
function client(peer) {
  const conversation = getConversationKey(clientKey, peer.peerPubkey);
  let sequence = 0;
  const event = (method, params = [], id = `request-${++sequence}`) => finalizeEvent({
    kind: 24133, created_at: 123456, tags: [['p', peer.peerPubkey]],
    content: encrypt(JSON.stringify({ id, method, params }), conversation),
  }, clientKey);
  const decode = outer => JSON.parse(decrypt(outer.content, conversation));
  const call = (method, params) => decode(peer.processEvent(event(method, params)).events[0]);
  return { event, decode, call, close: () => conversation.fill(0) };
}
function connected(t) {
  const peer = createPeer({ peerKey: scalar(7), userKey: scalar(9), secret: 'disposable-fixture-secret', now: () => 123456 });
  const rpc = client(peer); t.after(() => { rpc.close(); peer.close(); });
  assert.equal(rpc.call('connect', [peer.peerPubkey, 'disposable-fixture-secret', '', '{"name":"Hypergolic fixture"}']).result, 'ack');
  return { peer, rpc };
}

test('peer separates connection and user keys, signs exact fields and emits no publication', t => {
  const { peer, rpc } = connected(t);
  assert.notEqual(peer.peerPubkey, peer.userPubkey);
  assert.equal(rpc.call('get_public_key').result, peer.userPubkey);
  assert.equal(rpc.call('switch_relays').result, null);
  const event = JSON.parse(rpc.call('sign_event', [JSON.stringify({ ...template, pubkey: peer.userPubkey })]).result);
  assert.equal(verifyEvent(structuredClone(event)), true);
  assert.equal(event.pubkey, peer.userPubkey);
  for (const field of Object.keys(template)) assert.deepEqual(event[field], template[field]);
  assert.equal(rpc.call('logout').result, 'ack');
  assert.equal(rpc.call('sign_event', [JSON.stringify(template)]).error, 'Fixture request rejected');
  assert.equal(peer.receipt().signatures, 1);
  assert.equal(peer.receipt().methodCounts.sign_event, 2);
  assert.equal(JSON.stringify(peer.receipt()).includes('disposable-fixture-secret'), false);
});

test('wrong connection token and unconnected signing never create a signature', t => {
  const peer = createPeer({ secret: 'required-token' }), rpc = client(peer);
  t.after(() => { rpc.close(); peer.close(); });
  assert(rpc.call('connect', [peer.peerPubkey, 'wrong-token']).error);
  assert(rpc.call('sign_event', [JSON.stringify(template)]).error);
  assert.equal(peer.receipt().signatures, 0);
});

test('same request replay is idempotent and changed payload under the same id is rejected', t => {
  const { peer, rpc } = connected(t);
  const request = rpc.event('sign_event', [JSON.stringify(template)], 'fixed-id');
  const first = peer.processEvent(request), duplicate = peer.processEvent(structuredClone(request));
  assert.deepEqual(duplicate, first);
  assert.equal(peer.receipt().signatures, 1);
  assert.equal(peer.processEvent(rpc.event('sign_event', [JSON.stringify({ ...template, content: 'different' })], 'fixed-id')).accepted, false);
  assert.equal(peer.receipt().methodCounts.sign_event, 1);
});

test('relay changes exercise both specified array/null and string representations', t => {
  const { peer, rpc } = connected(t);
  for (const value of [null, ['wss://relay.example.org/changed']]) for (const string of [false, true]) {
    peer.setRelays(value, string);
    assert.deepEqual(rpc.call('switch_relays').result, string ? JSON.stringify(value) : value);
  }
});

test('invalid client outer signature, recipient and encrypted payload are rejected', t => {
  const { peer, rpc } = connected(t);
  const request = rpc.event('get_public_key');
  for (const event of [{ ...request, sig: '0'.repeat(128) },
    finalizeEvent({ ...request, tags: [['p', peer.userPubkey]] }, clientKey),
    finalizeEvent({ ...request, content: 'not-a-nip44-payload' }, clientKey)]) {
    assert.deepEqual(peer.processEvent(event), { events: [], accepted: false, close: false });
  }
  assert.equal(peer.receipt().invalidEvents, 3);
});

for (const fault of FAULTS.filter(value => value !== 'none' && value !== 'wrong-public-key')) test(`adversarial peer produces ${fault}`, t => {
  const { peer, rpc } = connected(t); peer.setFault(fault);
  const request = rpc.event('sign_event', [JSON.stringify(template)], 'fault-request');
  const outcome = peer.processEvent(request);
  assert.equal(outcome.accepted, true);
  assert.equal(peer.receipt().methodCounts.sign_event, 1);
  if (fault === 'close-after-send' || fault === 'no-response') {
    assert.equal(outcome.events.length, 0); assert.equal(peer.receipt().signatures, 1);
    assert.equal(outcome.close, fault === 'close-after-send'); return;
  }
  const outer = outcome.events[0];
  if (fault === 'invalid-outer-id' || fault === 'invalid-outer-signature') {
    assert.equal(verifyEvent(structuredClone(outer)), false); return;
  }
  assert.equal(verifyEvent(structuredClone(outer)), true);
  if (fault === 'bad-mac') { assert.throws(() => rpc.decode(outer)); return; }
  if (fault === 'wrong-peer') { assert.notEqual(outer.pubkey, peer.peerPubkey); return; }
  if (fault === 'wrong-recipient') { assert.notEqual(outer.tags[0][1], clientPubkey); return; }
  const response = rpc.decode(outer);
  if (fault === 'wrong-id') { assert.notEqual(response.id, 'fault-request'); return; }
  if (fault === 'refusal') { assert(response.error); assert.equal(peer.receipt().signatures, 0); return; }
  if (fault === 'auth-url') {
    assert.equal(response.result, 'auth_url'); assert.equal(response.error, 'https://auth.example.org/fixture');
    assert.equal(peer.receipt().signatures, 0); return;
  }
  const signed = JSON.parse(response.result);
  if (fault === 'invalid-inner-id' || fault === 'invalid-inner-signature') assert.equal(verifyEvent(structuredClone(signed)), false);
  else assert.equal(verifyEvent(structuredClone(signed)), true);
  if (fault === 'changed-event') assert.notEqual(signed.content, template.content);
  if (fault === 'wrong-user') assert.notEqual(signed.pubkey, peer.userPubkey);
  if (fault === 'duplicate') assert.deepEqual(outcome.events, [outer, outer]);
  if (fault.startsWith('valid-plus-')) {
    assert.equal(outcome.wireFault, fault);
    assert.equal(signed.pubkey, peer.userPubkey); assert.equal(signed.content, template.content);
  }
});


test('wrong-public-key returns a different valid account from the authenticated peer', t => {
  const { peer, rpc } = connected(t); peer.setFault('wrong-public-key', 'get_public_key');
  const outcome = peer.processEvent(rpc.event('get_public_key', [], 'account-check'));
  assert.equal(outcome.events.length, 1);
  const outer = outcome.events[0];
  assert.equal(verifyEvent(structuredClone(outer)), true);
  assert.equal(outer.pubkey, peer.peerPubkey);
  const response = rpc.decode(outer);
  assert.equal(response.id, 'account-check');
  assert.match(response.result, /^[0-9a-f]{64}$/);
  assert.notEqual(response.result, peer.userPubkey);
  const conversation = getConversationKey(clientKey, response.result);
  assert.equal(conversation.length, 32); conversation.fill(0);
  assert.equal(peer.receipt().methodCounts.get_public_key, 1);
  assert.equal(peer.receipt().signatures, 0);
});


for (const decision of ['approve', 'refuse']) test(`authentication ${decision} completes only the original request once`, t => {
  const { peer, rpc } = connected(t); peer.setFault('auth-url');
  const request = rpc.event('sign_event', [JSON.stringify(template)], 'authentication-request');
  const challenge = peer.processEvent(request);
  assert.equal(rpc.decode(challenge.events[0]).result, 'auth_url');
  assert.equal(peer.receipt().signatures, 0); assert.equal(peer.receipt().pendingAuth, 1);
  assert.deepEqual(peer.processEvent(request), challenge);
  for (const change of [{ id: 'other' }, { clientPubkey: peer.userPubkey }]) {
    assert.throws(() => peer.completeAuth({ clientPubkey, id: 'authentication-request', decision, ...change }));
  }
  assert.equal(peer.receipt().authCompletions, 0);
  const outcome = peer.completeAuth({ clientPubkey, id: 'authentication-request', decision });
  const outer = outcome.events[0], response = rpc.decode(outer);
  assert.equal(verifyEvent(structuredClone(outer)), true); assert.equal(outer.pubkey, peer.peerPubkey);
  assert.equal(response.id, 'authentication-request');
  if (decision === 'approve') {
    const signed = JSON.parse(response.result);
    assert.equal(verifyEvent(structuredClone(signed)), true); assert.equal(signed.pubkey, peer.userPubkey);
    for (const field of Object.keys(template)) assert.deepEqual(signed[field], template[field]);
  } else assert.equal(response.error, 'Fixture authentication refused');
  assert.deepEqual(peer.processEvent(request), outcome);
  assert.throws(() => peer.completeAuth({ clientPubkey, id: 'authentication-request', decision }));
  const receipt = peer.receipt();
  assert.equal(receipt.authCompletions, 1); assert.equal(receipt.pendingAuth, 0);
  assert.equal(receipt.methodCounts.sign_event, 1); assert.equal(receipt.signatures, decision === 'approve' ? 1 : 0);
});

test('connection authentication retains its original parameters without exposing them in receipts', t => {
  const token = 'disposable-auth-token', peer = createPeer({ secret: token }), rpc = client(peer);
  t.after(() => { rpc.close(); peer.close(); }); peer.setFault('auth-url', 'connect');
  peer.setAuthURL('https://auth.example.org/login?challenge=public-test-id');
  const request = rpc.event('connect', [peer.peerPubkey, token], 'connection-auth');
  const challenge = rpc.decode(peer.processEvent(request).events[0]);
  assert.equal(challenge.error, 'https://auth.example.org/login?challenge=public-test-id');
  const reply = rpc.decode(peer.completeAuth({ clientPubkey, id: 'connection-auth', decision: 'approve' }).events[0]);
  assert.equal(reply.id, 'connection-auth'); assert.equal(reply.result, 'ack');
  assert.equal(rpc.call('get_public_key').result, peer.userPubkey);
  assert.equal(peer.receipt().methodCounts.connect, 1);
  assert.equal(JSON.stringify(peer.receipt()).includes(token), false);
  for (const url of ['http://auth.example.org/', 'https://user:password@auth.example.org/', 'https://auth.example.org/#fragment']) {
    assert.throws(() => peer.setAuthURL(url));
  }
});


for (const fault of ['wrong-peer', 'wrong-id', 'changed-event', 'duplicate', 'no-response']) test(`authentication final reply can exercise ${fault}`, t => {
  const { peer, rpc } = connected(t); peer.setFault('auth-url');
  peer.processEvent(rpc.event('sign_event', [JSON.stringify(template)], 'final-fault'));
  peer.setFault(fault);
  const outcome = peer.completeAuth({ clientPubkey, id: 'final-fault', decision: 'approve' });
  assert.equal(peer.receipt().methodCounts.sign_event, 1); assert.equal(peer.receipt().authCompletions, 1);
  assert.equal(peer.receipt().signatures, 1);
  if (fault === 'no-response') { assert.equal(outcome.events.length, 0); return; }
  const outer = outcome.events[0];
  if (fault === 'wrong-peer') { assert.notEqual(outer.pubkey, peer.peerPubkey); return; }
  const response = rpc.decode(outer);
  if (fault === 'wrong-id') { assert.notEqual(response.id, 'final-fault'); return; }
  if (fault === 'changed-event') assert.notEqual(JSON.parse(response.result).content, template.content);
  if (fault === 'duplicate') assert.deepEqual(outcome.events, [outer, outer]);
});


test('Android-shaped connection auth reports only bounded final ACK or token rejection diagnostics', t => {
  for (const correct of [true, false]) {
    const token = 'disposable-android-auth-token', wrong = 'disposable-wrong-android-token';
    const peer = createPeer({ secret: token }), rpc = client(peer);
    t.after(() => { rpc.close(); peer.close(); });
    peer.setFault('auth-url', 'connect');
    const id = correct ? 'android-auth-ack' : 'android-auth-token-mismatch';
    const request = rpc.event('connect', [peer.peerPubkey, correct ? token : wrong, 'sign_event', '{"name":"Hypergolic"}'], id);
    assert.equal(rpc.decode(peer.processEvent(request).events[0]).result, 'auth_url');
    // Match the public control API's auth:false default method before completion.
    peer.setFault('none', 'sign_event');
    const final = rpc.decode(peer.completeAuth({ clientPubkey, id, decision: 'approve' }).events[0]);
    assert.equal(final.id, id);
    if (correct) {
      assert.equal(final.result, 'ack'); assert.equal(Object.hasOwn(final, 'error'), false);
    } else {
      assert.equal(final.error, 'Fixture request rejected'); assert.equal(Object.hasOwn(final, 'result'), false);
    }
    const receipt = peer.receipt(), entry = receipt.requests[0];
    assert.equal(entry.authDecision, 'approve'); assert.equal(entry.authResult, correct ? 'ack' : 'error');
    assert.equal(entry.fixtureRejectionCode, correct ? undefined : 'connect-token-mismatch');
    assert.equal(receipt.methodCounts.connect, 1); assert.equal(receipt.authCompletions, 1);
    assert.equal(receipt.pendingAuth, 0); assert.equal(receipt.signatures, 0);
    for (const privateValue of [token, wrong, 'connection refused', 'params']) {
      assert.equal(JSON.stringify(receipt).includes(privateValue), false);
    }
  }
});
