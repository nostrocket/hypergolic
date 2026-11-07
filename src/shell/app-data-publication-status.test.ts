import assert from 'node:assert/strict';
import test from 'node:test';
import type {RelayOutcome} from '../network/relay-service.ts';
import {appDataPublicationStatus} from './app-data-publication-status.ts';

function outcomes(...statuses: RelayOutcome['status'][]): readonly RelayOutcome[] {
  return statuses.map((status, index) => ({
    relay: `wss://relay-${index}.example/`, eventId: 'a'.repeat(64), status, reason: '',
  }));
}

test('only acceptance from every selected peer reports completion', () => {
  assert.equal(appDataPublicationStatus(outcomes('accepted')), 'The required relay accepted the public record.');
  assert.equal(appDataPublicationStatus(outcomes('accepted', 'accepted')),
    'All 2 required relays accepted the public record.');
  for (const status of ['rejected', 'cancelled-before-send'] as const) {
    assert.equal(appDataPublicationStatus(outcomes('accepted', status)),
      '1 of 2 required relays accepted the public record. The update is incomplete.');
  }
});

test('missing acknowledgements remain unknown beside accepted or rejected results', () => {
  assert.equal(appDataPublicationStatus(outcomes('accepted', 'unknown')),
    '1 of 2 required relays accepted the public record. Delivery to 1 relay is unconfirmed.');
  assert.equal(appDataPublicationStatus(outcomes('rejected', 'unknown', 'unknown')),
    '0 of 3 required relays accepted the public record. Delivery to 2 relays is unconfirmed.');
});

test('zero accepted relays cannot imply that publication completed', () => {
  assert.equal(appDataPublicationStatus(outcomes('rejected', 'cancelled-before-send')),
    '0 of 2 required relays accepted the public record. The update is incomplete.');
  assert.equal(appDataPublicationStatus([]), 'Publication could not be confirmed.');
});
