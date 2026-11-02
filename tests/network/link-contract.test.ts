import {test} from 'node:test';
import assert from 'node:assert/strict';
import {captureLinkResult, linkDenied, linkRequestId, parseLinkRequest} from '../../src/links/link-contract.ts';
test('link contract captures immutable options and preserves exact URI', () => {
  const value = {type: 'link.open', id: 'one', url: 'https://example.com/a%2Fb?x=1#frag', options: {label: 'Page'}};
  const result = parseLinkRequest(value); value.options.label = 'Changed';
  assert.equal(result.options?.label, 'Page'); assert.equal(result.url, value.url); assert(Object.isFrozen(result));
});
test('invalid correlatable requests remain correlatable for denial', () => {
  for (const patch of [{url: null}, {url: ''}, {options: null}, {options: {url: 'https://evil.test'}}, {options: {label: 1}}, {gesture: true}, {options: {label: 'x'.repeat(257)}}]) {
    const value = {type: 'link.open', id: 'one', url: 'https://example.com', ...patch};
    assert.equal(linkRequestId(value), 'one'); assert.throws(() => parseLinkRequest(value));
  }
});
test('getter and prototype payloads cannot establish trusted request fields', () => {
  let called = false; const value = {get id() {called = true; return 'one';}, type: 'link.open'};
  assert.equal(linkRequestId(value), null); assert.equal(called, false);
  assert.throws(() => parseLinkRequest(Object.create({type: 'link.open', id: 'one', url: 'https://example.com'})));
});
test('canonical results require captured correlation, exact status and denial-only optional error', () => {
  assert.equal(captureLinkResult(linkDenied('one'), 'one').status, 'denied');
  assert.equal(captureLinkResult({type: 'link.open.result', id: 'one', status: 'opened'}, 'one').status, 'opened');
  for (const value of [{type:'link.open.result',id:'other',status:'opened'}, {type:'link.open.result',id:'one',status:'success'}, {type:'link.open.result',id:'one',status:'opened',error:'late'}, {type:'link.open.result',id:'one',status:'denied',url:'https://evil.test'}]) assert.throws(() => captureLinkResult(value, 'one'));
});
