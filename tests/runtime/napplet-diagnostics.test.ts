import assert from 'node:assert/strict';
import test from 'node:test';
import {createNappletDiagnostics, redactedSummary} from '../../src/runtime/napplet-diagnostics.ts';
import {parseRelaySubscribe} from '../../src/network/relay-subscription-contract.ts';

const raw = {type:'relay.subscribe', id:'private-id', subId:'private-sub', relay:'wss://relay.example.org/private-path',
  filters:[{kinds:[31237],limit:500,authors:['a'.repeat(64)]}]};
test('relay observations distinguish refusal, empty history and timeout without exporting destinations or filters', () => {
  const trace = createNappletDiagnostics();
  const request = parseRelaySubscribe(raw);
  trace.relay(request, raw).rejected(true);
  trace.relay(request).observe({type:'relay.eose',subId:raw.subId});
  trace.relay(request).observe({type:'relay.closed',subId:raw.subId,reason:'relay timeout'});
  const rows = trace.snapshot();
  assert.equal(rows[1]?.hostname,'relay.example.org');
  assert.equal(rows[1]?.networkSettings,true);
  const summary = redactedSummary(rows);
  for (const expected of ['Relay destination denied','Stored events complete','0 events observed','Relay timed out','Requested limit 500','Host filter limit 32']) assert.ok(summary.includes(expected));
  for (const excluded of ['relay.example.org','private-',raw.filters[0]!.authors[0]!]) assert.ok(!summary.includes(excluded));
});
test('snapshots freeze pending work, keep separate bindings independent and evict old entries', () => {
  let now = 100;
  const trace = createNappletDiagnostics(() => now);
  const finish = trace.resource();
  const pending = trace.snapshot();
  now += 250;
  finish(false);
  assert.equal(pending[1]?.title,'Resource request pending');
  assert.equal(trace.snapshot()[1]?.detail,'Elapsed 250 ms.');
  const other = createNappletDiagnostics();
  for (let i = 0; i < 100; i++) trace.resource();
  assert.equal(trace.snapshot().length,64);
  assert.equal(other.snapshot().length,1);
});
