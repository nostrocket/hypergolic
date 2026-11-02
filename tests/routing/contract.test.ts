import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoutingMessage, parseIntentRequest, routingPayload, transposeConvention } from '../../src/routing/routing-contract.ts';

test('capture exact immutable payload and independent routing role/convention', () => {
  const payload = { target: ['hello', 3, false, null], nested: { caption: '⚡' } };
  const request = parseIntentRequest({ archetype: 'note', convention: 'napplet:profile/open', payload, behavior: { focus: true } });
  payload.target[0] = 'changed'; assert.deepEqual(request.payload, { target: ['hello', 3, false, null], nested: { caption: '⚡' } });
  assert(Object.isFrozen(request) && Object.isFrozen(request.payload)); assert.equal(request.action, 'open');
  assert.deepEqual(parseIntentRequest({ archetype: 'note' }), { archetype: 'note', action: 'open' });
  assert.deepEqual(parseIntentRequest({ archetype: 'note', payload: null }).payload, null);
});
test('reject accessor/prototype/symbol/hidden/unsupported values without executing guest code', () => {
  let read = false; const accessor = { get archetype() { read = true; return 'note'; } };
  for (const value of [accessor, Object.create({ archetype: 'note' }), { archetype: 'note', sender: 'victim' }, { archetype: 'note', [Symbol('scope')]: true }]) assert.throws(() => parseIntentRequest(value));
  assert.equal(read, false);
  const cycle: { self?: unknown } = {}; cycle.self = cycle;
  for (const value of [cycle, undefined, -0, NaN, Infinity, BigInt(1), new Date(), new Uint8Array(2), [undefined], new Array(2), { hidden: undefined }]) assert.throws(() => routingPayload(value));
  const hidden = {}; Object.defineProperty(hidden, 'secret', { value: 1 }); assert.throws(() => routingPayload(hidden));
});
test('query transposition preserves text/plus and rejects ambiguity before delivery', () => {
  assert.deepEqual(transposeConvention('napplet:profile/open?pubkey=a%2Bb&truth=false&empty=', false), { convention: 'napplet:profile/open', payload: { pubkey: 'a+b', truth: 'false', empty: '' } });
  assert.deepEqual(transposeConvention('napplet:profile/open?x=a+b', false).payload, { x: 'a+b' });
  for (const uri of ['napplet:note/open#x','napplet:note/open?a=1&a=2','napplet:note/open?a=1&%61=2','napplet:note/open?a=%zz','napplet:note/open?','napplet:note/open?a']) assert.throws(() => transposeConvention(uri, false));
  assert.throws(() => transposeConvention('napplet:note/open?a=1', true));
});
test('canonical INC schema has no forged sender or invented emission receipt', () => {
  const emit = parseRoutingMessage({ type: 'inc.emit', topic: 'napplet:note/open?a=1' }); assert.deepEqual(emit, { type: 'inc.emit', topic: 'napplet:note/open', payload: { a: '1' } });
  for (const extra of [{ id: 'ack' }, { sender: 'victim' }, { peer: 'victim' }, { generation: 'old' }]) assert.throws(() => parseRoutingMessage({ type: 'inc.emit', topic: 'opaque', ...extra }));
  assert.deepEqual(parseRoutingMessage({ type: 'inc.subscribe', id: 'a1', topic: 'opaque?literal=yes' }), { type: 'inc.subscribe', id: 'a1', topic: 'opaque?literal=yes' });
  assert.deepEqual(parseRoutingMessage({ type: 'inc.channel.emit', channelId: 'c1', payload: null }), { type: 'inc.channel.emit', channelId: 'c1', payload: null });
});
test('engineering limits bound nested/large payloads and identifiers', () => {
  let nested: unknown = null; for (let i = 0; i < 34; i++) nested = { nested }; assert.throws(() => routingPayload(nested));
  assert.throws(() => routingPayload('⚡'.repeat(12000))); assert.throws(() => routingPayload(Array(2049).fill(null)));
  assert.throws(() => parseRoutingMessage({ type: 'intent.handlers', id: 'x'.repeat(129) }));
  assert.throws(() => parseIntentRequest({ archetype: 'note', behavior: { focus: 'yes' } }));
  assert.throws(() => parseRoutingMessage({ type: 'inc.event', sender: 'victim', topic: 'x' }));
});
