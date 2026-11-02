import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { decrypt, encrypt, getConversationKey } from 'nostr-tools/nip44';

function frame(socket, accept) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Fixture response deadline')), 5000);
    function finish(error, value) { clearTimeout(timer); socket.off('message', message); socket.off('error', failed); error ? reject(error) : resolve(value); }
    function failed(error) { finish(error); }
    function message(raw) {
      try { const value = JSON.parse(raw.toString()); if (accept(value)) finish(null, value); }
      catch (error) { finish(error); }
    }
    socket.on('message', message); socket.once('error', failed);
  });
}
function opened(socket) { return new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); }); }
async function ready(path, child) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (child.exitCode !== null) throw new Error('Fixture server exited during startup');
    try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(20);
  }
  throw new Error('Fixture startup deadline');
}

test('controlled TLS relay carries encrypted requests, rejects a wrong hostname and records exact signing counts', { timeout: 20000 }, async t => {
  const parent = await mkdtemp(join(tmpdir(), 'hypergolic-nip46-peer-')), output = join(parent, 'server');
  const child = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url)), '--output', output, '--fixture-keys', 'public-vectors'], { stdio: 'ignore' });
  const stopped = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    child.kill('SIGTERM');
    const result = await Promise.race([stopped, delay(5000, null, { ref: false })]);
    if (result === null) { child.kill('SIGKILL'); await stopped; }
    try {
      assert(result !== null, 'Fixture must stop without forced termination');
      assert.equal(result.code, 0);
      await assert.rejects(stat(join(output, 'server.key')), { code: 'ENOENT' });
    } finally { await rm(parent, { recursive: true, force: true }); }
  });
  const config = await ready(join(output, 'ready.json'), child);
  const expected = new Uint8Array(32); expected[31] = 9;
  assert.equal(config.userPubkey, getPublicKey(expected)); expected.fill(0);
  const ca = await readFile(config.certificate);
  const transport = { ca, lookup: (_host, options, callback) => options.all
    ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4) };
  const wrongHost = new WebSocket(config.relayURL, { ...transport, servername: 'other.example.org' }); sockets.push(wrongHost);
  await assert.rejects(opened(wrongHost), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  const socket = new WebSocket(config.relayURL, transport); sockets.push(socket); await opened(socket);
  const eose = frame(socket, value => value[0] === 'EOSE');
  socket.send(JSON.stringify(['REQ', 'fixture', { kinds: [24133], authors: [config.peerPubkey] }]));
  assert.deepEqual(await eose, ['EOSE', 'fixture']);
  const key = generateSecretKey(), conversation = getConversationKey(key, config.peerPubkey);
  t.after(() => { key.fill(0); conversation.fill(0); });
  let sequence = 0;
  async function call(method, params = []) {
    const id = `wire-${++sequence}`;
    const response = frame(socket, value => value[0] === 'EVENT');
    socket.send(JSON.stringify(['EVENT', finalizeEvent({ kind: 24133, created_at: 123456,
      tags: [['p', config.peerPubkey]], content: encrypt(JSON.stringify({ id, method, params }), conversation) }, key)]));
    const outer = (await response)[2];
    assert.equal(verifyEvent(structuredClone(outer)), true);
    const payload = JSON.parse(decrypt(outer.content, conversation)); assert.equal(payload.id, id); return payload;
  }
  const token = new URL(config.bunkerURL).searchParams.get('secret');
  assert.equal((await call('connect', [config.peerPubkey, token])).result, 'ack');
  assert.equal((await call('get_public_key')).result, config.userPubkey);
  const approved = { kind: 1, created_at: 123456, tags: [], content: 'WSS exact event' };
  const signed = JSON.parse((await call('sign_event', [JSON.stringify(approved)])).result);
  assert.equal(verifyEvent(structuredClone(signed)), true); assert.equal(signed.pubkey, config.userPubkey);
  for (const field of Object.keys(approved)) assert.deepEqual(signed[field], approved[field]);
  assert.equal((await fetch(config.controlURL, { method: 'POST', body: '{}' })).status, 403);
  const headers = { 'x-fixture-control': config.nonce, 'content-type': 'application/json' };
  assert.equal((await fetch(config.controlURL, { method: 'POST', headers,
    body: JSON.stringify({ fault: 'wrong-user', relays: [config.changedRelayURL] }) })).status, 200);
  assert.deepEqual((await call('switch_relays')).result, [config.changedRelayURL]);
  const foreign = JSON.parse((await call('sign_event', [JSON.stringify(approved)])).result);
  assert.equal(verifyEvent(structuredClone(foreign)), true); assert.notEqual(foreign.pubkey, config.userPubkey);
  const receipt = await (await fetch(config.statusURL, { headers })).json();
  assert.equal(receipt.methodCounts.sign_event, 2); assert.equal(receipt.signatures, 2);
  assert.deepEqual(receipt.requests.filter(value => value.method === 'sign_event').map(value => value.approvedEvent), [approved, approved]);
  assert.equal(JSON.stringify(receipt).includes(token), false);
  assert.equal((await fetch(config.controlURL, { method: 'POST', headers,
    body: JSON.stringify({ fault: 'auth-url' }) })).status, 200);
  const challenged = await call('sign_event', [JSON.stringify(approved)]);
  assert.equal(challenged.result, 'auth_url');
  const completion = { clientPubkey: getPublicKey(key), id: challenged.id, decision: 'approve' };
  const finalFrame = frame(socket, value => value[0] === 'EVENT');
  assert.equal((await fetch(config.controlURL, { method: 'POST', headers,
    body: JSON.stringify({ completeAuth: completion }) })).status, 200);
  const authOuter = (await finalFrame)[2];
  assert.equal(verifyEvent(structuredClone(authOuter)), true);
  const finalReply = JSON.parse(decrypt(authOuter.content, conversation));
  assert.equal(finalReply.id, challenged.id);
  const authSigned = JSON.parse(finalReply.result);
  assert.equal(verifyEvent(structuredClone(authSigned)), true); assert.equal(authSigned.pubkey, config.userPubkey);
  for (const field of Object.keys(approved)) assert.deepEqual(authSigned[field], approved[field]);
  assert.equal((await fetch(config.controlURL, { method: 'POST', headers,
    body: JSON.stringify({ completeAuth: completion }) })).status, 400);
  const completed = await (await fetch(config.statusURL, { headers })).json();
  assert.equal(completed.methodCounts.sign_event, 3); assert.equal(completed.signatures, 3);
  assert.equal(completed.authCompletions, 1); assert.equal(completed.pendingAuth, 0);
  assert.equal((await fetch(config.controlURL, { method: 'POST', headers,
    body: JSON.stringify({ fault: 'valid-plus-invalid-suffix' }) })).status, 200);
  const malformed = new Promise(resolve => socket.once('error', resolve));
  const valid = JSON.parse((await call('sign_event', [JSON.stringify(approved)])).result);
  assert.equal(verifyEvent(structuredClone(valid)), true); assert.equal(valid.pubkey, config.userPubkey);
  assert.equal((await malformed).code, 'WS_ERR_UNEXPECTED_MASK');
  const poisoned = await (await fetch(config.statusURL, { headers })).json();
  assert.equal(poisoned.methodCounts.sign_event, 4); assert.equal(poisoned.signatures, 4);
});
