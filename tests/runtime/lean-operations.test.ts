import assert from 'node:assert/strict';
import test from 'node:test';
import {finalizeEvent, generateSecretKey} from 'nostr-tools/pure';
import {createKeysSession} from '../../runtime/src/keys-adapter.ts';
import {CvmEndpoint} from '../../src/cvm/cvm-session.ts';
import {NappletHashMismatchError, verifyArtifact, verifyManifest} from '../../src/napplets/verified-artifact.ts';
import {loadTrace, sends} from '../reference-shell/trace.mts';

test('Lean keys preserves registration and duplicate-action replies with an unbound shortcut', () => {
  const {steps} = loadTrace('keys');
  const messages: object[] = [];
  const host = createKeysSession({postMessage: (message: object) => messages.push(message)} as unknown as Window, () => true);
  try {
    const first = steps[3];
    host.receive(first.input.msg);
    const [ack, bindings] = sends(first).map(row => row.msg);
    // defaultKey is a suggestion. This shell leaves Ctrl+S unbound.
    const {binding, ...unbound} = ack;
    assert.equal(binding, first.input.msg.action.defaultKey);
    assert.deepEqual(messages.splice(0), [unbound, {type: bindings.type, bindings: []}]);
    host.receive(steps[4].input.msg);
    assert.deepEqual(messages, []);
    host.receive(steps[5].input.msg);
    assert.deepEqual(messages, sends(steps[5]).map(row => row.msg));
  } finally { host.close(); }
});

test('Lean cvm returns a correlated unsupported registry-list reply', async () => {
  const step = loadTrace('cvm').steps[6];
  const scope = {endpoint: 'guest', generation: 'one', sourceRevision: 'one', epoch: 1, identity: '1'.repeat(64),
    publisher: '2'.repeat(64), appId: 'fixture', version: '3'.repeat(64), instance: 'one'};
  const endpoint = new CvmEndpoint(scope, {now: () => 0, assertCurrent() {},
    async review() {return assert.fail('Unsupported operation requested review');},
    async open() {return assert.fail('Unsupported operation opened a session');}});
  try { assert.deepEqual([await endpoint.dispatch(step.input.msg)], sends(step).map(row => row.msg)); }
  finally { endpoint.revoke(); }
});

test('Lean sha256 rejects artifact bytes that differ from the signed hash', async () => {
  const step = loadTrace('sha256').steps[3];
  const {manifest, bytes, w} = step.input;
  assert.deepEqual(step.outputs, [{t: 'rejected', w, error: {t: 'hashMismatch'}}]);
  // The upstream manifest is unsigned. Authenticate the same tags locally before checking the bytes.
  const event = finalizeEvent({kind: manifest.kind, tags: manifest.tags, content: manifest.content, created_at: 1}, generateSecretKey());
  const identifier = manifest.tags.find(([key]: string[]) => key === 'd')[1];
  const verified = await verifyManifest({kind: 35129, pubkey: event.pubkey, identifier, relayHints: []}, JSON.parse(JSON.stringify(event)));
  await assert.rejects(verifyArtifact(verified, Buffer.from(bytes, 'base64')), NappletHashMismatchError);
});
