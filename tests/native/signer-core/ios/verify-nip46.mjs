import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(process.argv[2] + '/package.json');
const { verifyEvent, getEventHash } = require('nostr-tools');
let assertions = 0;
const equal = (a, b) => { assert.equal(a, b); assertions++; };
const different = (a, b) => { assert.notEqual(a, b); assertions++; };
const event = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const peer = JSON.parse(readFileSync(process.argv[4], 'utf8'));
equal(event.content, 'Native WSS exact event 🛰️');
equal(event.pubkey, peer.userPubkey);
equal(event.id, getEventHash(event));
equal(verifyEvent(event), true);
different(peer.peerPubkey, peer.userPubkey);
equal(peer.methodCounts.sign_event, 23);
equal(peer.signatures, 19);
equal(peer.invalidEvents, 0);
equal(peer.authCompletions, 6);
equal(peer.pendingAuth, 0);
for (const request of peer.requests.filter(value => value.method === 'sign_event')) {
  equal(peer.requests.filter(other => other.id === request.id).length, 1);
}
equal(peer.wire.eventFrames, peer.receivedEvents);
equal(peer.wire.poisonedWrites, 2);
console.log(JSON.stringify({ independentVerifier: 'nostr-tools and controlled peer counters', assertions,
  eventId: event.id, pubkey: event.pubkey, signingRequests: peer.methodCounts.sign_event, signaturesProduced: peer.signatures }));
