import assert from 'node:assert/strict';
import {finalizeEvent, generateSecretKey, type EventTemplate, type VerifiedEvent} from 'nostr-tools/pure';

export function signedFixture(input: EventTemplate): VerifiedEvent {
  const {kind, created_at, tags, content} = input;
  return JSON.parse(JSON.stringify(finalizeEvent({kind, created_at, tags, content}, generateSecretKey())));
}

export function expectedResult(example: {event: unknown; sidecar?: unknown}, input: unknown, signed: VerifiedEvent, actual: {sidecar?: unknown}) {
  assert.deepEqual(example.event, input, 'Trace must deliver the event provided by its relay');
  const sidecar = actual.sidecar === undefined ? {} : {sidecar: example.sidecar};
  return {event: signed, ...sidecar};
}
