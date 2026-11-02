import assert from 'node:assert/strict';
import test from 'node:test';
import {CloseCheckCoordinator, type CloseCheckRequest, type CloseState} from './close-check.ts';
function fixture() {
  let next = 0, clock = 0;
  const coordinator = new CloseCheckCoordinator(() => `check-${++next}`, () => clock);
  coordinator.ready('first', 'generation-1'); coordinator.ready('second', 'generation-2');
  let request: CloseCheckRequest;
  const start = (session = 'first') => coordinator.request(session, value => { request = value; });
  const reply = (state: CloseState, patch: Partial<CloseCheckRequest> = {}) => coordinator.receive({...request!, type: 'close-check', state, ...patch});
  return {coordinator, start, reply, advance: (ms: number) => { clock += ms; }, request: () => request!};
}
for (const state of ['clean', 'dirty', 'unknown'] as const) test(`captured native ${state} result is consumed once`, async () => {
  const h = fixture(), result = h.start(); h.reply(state); assert.equal(await result, state); assert.equal(h.coordinator.isPending(), false);
  const second = h.start(); h.coordinator.receive({...h.request(), id: 'check-1', type: 'close-check', state: 'clean'}); assert.equal(h.coordinator.isPending(), true);
  h.reply('dirty'); assert.equal(await second, 'dirty');
});
for (const patch of [{sessionId: 'second'}, {generation: 'generation-2'}, {id: 'forged'}]) test(`foreign or forged reply cannot resolve ${JSON.stringify(patch)}`, async () => {
  const h = fixture(), result = h.start(); h.reply('clean', patch); assert.equal(h.coordinator.isPending(), true); h.reply('dirty'); assert.equal(await result, 'dirty');
});
test('deadline check rejects clean even when the timer callback is delayed', async () => {
  const h = fixture(), result = h.start(); h.advance(500); h.reply('clean'); assert.equal(await result, 'unknown');
});
test('unsupported and silent guests retain the warning outcome', async () => {
  const h = fixture(); assert.equal(await h.start('unloaded'), 'unknown'); assert.equal(await h.start(), 'unknown');
});
for (const action of ['background', 'replacement', 'close'] as const) test(`${action} cancels an outstanding close decision`, async () => {
  const h = fixture(), result = h.start();
  if (action === 'background') h.coordinator.cancel(); else if (action === 'replacement') h.coordinator.ready('first', 'generation-new'); else h.coordinator.forget('first');
  h.reply('clean'); assert.equal(await result, null);
});
test('malformed native reply with extra authoritative fields cannot produce clean', async () => {
  const h = fixture(), result = h.start(); h.coordinator.receive({...h.request(), type: 'close-check', state: 'clean', publisher: 'forged'} as never); assert.equal(await result, 'unknown');
});
test('replacing a pending request cancels the old promise and isolates its late reply', async () => {
  const h = fixture(), old = h.start(), oldRequest = h.request(), current = h.start('second'); assert.equal(await old, null);
  h.coordinator.receive({...oldRequest, type: 'close-check', state: 'clean'}); assert.equal(h.coordinator.isPending(), true); h.reply('dirty'); assert.equal(await current, 'dirty');
});
