import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(process.argv[2] + '/package.json');
const { verifyEvent, getEventHash } = require('nostr-tools');
let assertions = 0;
const equal = (a, b) => { assert.equal(a, b); assertions++; };
const directory = process.argv[3];
const event = JSON.parse(readFileSync(directory + '/handoff-ui-signature.json'));
const peer = JSON.parse(readFileSync(directory + '/fixture/receipt.json'));
equal(event.content, 'Disposable Safari exact event 🛰️'); equal(event.pubkey, peer.userPubkey);
equal(event.id, getEventHash(event)); equal(verifyEvent(event), true);
for (const scenario of ['approve', 'cancel', 'background']) {
  const state = JSON.parse(readFileSync(directory + '/handoff-ui-' + scenario + '.json'));
  equal(state.scenario, scenario); equal(state.signatureReturned, scenario === 'approve'); equal(state.possibleSign, true);
  equal(state.sourceLive, scenario === 'approve'); equal(state.state, scenario === 'approve' ? 'resumed' : 'denied');
  if (scenario !== 'approve') equal(state.errorCode, 'SIGNER_UNCERTAIN');
}
equal(peer.methodCounts.sign_event, 3); equal(peer.signatures, 3); equal(peer.authCompletions, 3); equal(peer.pendingAuth, 0);
equal(peer.invalidEvents, 0);
for (const request of peer.requests) equal(peer.requests.filter(other => other.id === request.id).length, 1);
equal(peer.wire.eventFrames, peer.receivedEvents); equal(peer.wire.poisonedWrites, 0);
console.log(JSON.stringify({ assertions, independentVerifier: 'nostr-tools and controlled peer', signingRequests: peer.methodCounts.sign_event, signaturesProduced: peer.signatures, authenticationCompletions: peer.authCompletions }));
