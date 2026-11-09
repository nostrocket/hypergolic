import {expect, test} from '@playwright/test';
import {createNativeClient} from '../src/native-client';
import {createResourceAdapter} from '../src/resource-adapter';
import type {NappletMessage} from '@kehto/runtime';

function harness(timeouts: Record<string, number> = {}) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousPerformance = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  const timers = new Map<number, {at: number; callback(): void}>();
  let now = 0, timer = 0, receive: ((event: {data: unknown}) => void) | undefined;
  const sent: {sequence: number; deferred?: true; message: string}[] = [];
  let throwId = '';
  Object.defineProperty(globalThis, 'performance', {configurable: true, value: {now: () => now}});
  Object.defineProperty(globalThis, 'window', {configurable: true, value: {
    addEventListener() {}, removeEventListener() {},
    setTimeout(callback: () => void, duration: number) {timers.set(++timer, {at: now + duration, callback}); return timer;},
    clearTimeout(id: number) {timers.delete(id);},
  }});
  const client = createNativeClient({addEventListener(_type, listener) {receive = listener;}, postMessage(raw) {
    const row = JSON.parse(raw); sent.push(row);
    if (JSON.parse(row.message).id === throwId) throw new Error('bridge unavailable');
  }}, 'resource-admission', {requestTimeoutsMs: timeouts});
  const calls = () => sent.map(row => ({...JSON.parse(row.message), deferred: row.deferred, sequence: row.sequence}));
  const reply = (id: string, fields: object = {}, generation = 'resource-admission') => {
    const row = sent.filter(row => JSON.parse(row.message).id === id).at(-1)!;
    const request = JSON.parse(row.message);
    receive!({data: JSON.stringify({type: 'capability.result', sessionId: generation, sequence: row.sequence,
      response: JSON.stringify({type: request.type + '.result', id, ...fields})})});
  };
  const hold = (count = 4) => Array.from({length: count}, (_, index) => client.request({type: 'outbox.query',
    id: 'query-' + index, filters: [{kinds: [1], limit: 1}]} as NappletMessage).catch(() => {}));
  return {client, calls, reply, hold, throwNext(id: string) {throwId = id;}, timers,
    advance(duration: number) {
      now += duration;
      for (const [id, entry] of [...timers]) if (entry.at <= now && timers.delete(id)) entry.callback();
    },
    restore() {
      client.destroy();
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
      if (previousPerformance) Object.defineProperty(globalThis, 'performance', previousPerformance); else Reflect.deleteProperty(globalThis, 'performance');
    },
  };
}
const message = (id: string) => ({type: 'resource.bytes', id, url: 'blossom:sha256:' + 'a'.repeat(64)}) as NappletMessage;
const flush = async () => {for (let index = 0; index < 12; index++) await Promise.resolve();};

test('Resource bytes and chunks wait behind deferred reads and reconstruct the original Blob', async () => {
  const h = harness(), replies: any[] = []; let live = true;
  const adapter = createResourceAdapter(h.client, () => () => live);
  try {
    h.hold(); const work = adapter({message: message('image'), send: value => {replies.push(value);}});
    await flush(); expect(h.calls()).toHaveLength(4); expect(replies).toEqual([]);
    h.reply('query-0', {events: []}); expect(h.calls().at(-1).id).toBe('image');
    // More deferred work can arrive between the descriptor and its first chunk.
    const extra = h.client.request({type: 'outbox.query', id: 'extra', filters: [{kinds: [1], limit: 1}]} as NappletMessage).catch(() => {});
    h.reply('image', {transfer: {handle: '00000000-0000-4000-8000-000000000001', length: 7, mime: 'text/plain'}});
    await flush(); expect(h.calls().some(call => call.type === 'resource.__chunk')).toBe(false);
    h.reply('extra', {events: []}); await flush();
    const chunk = h.calls().at(-1); expect(chunk.type).toBe('resource.__chunk');
    h.reply(chunk.id, {base64: btoa('neutral')}); await work; await extra;
    expect(await replies[0].blob.text()).toBe('neutral');
    expect(h.calls().filter(call => call.type.startsWith('resource.')).every(call => call.deferred === undefined)).toBe(true);
    expect(h.calls().map(call => call.sequence)).toEqual(h.calls().map((_, index) => index + 1));
  } finally {live = false; h.restore();}
});

test('queued cancellation never posts the initial request and leaves unrelated FIFO work intact', async () => {
  const h = harness(), replies: any[] = [], adapter = createResourceAdapter(h.client, () => () => true);
  try {
    h.hold(); const cancelled = adapter({message: message('cancelled'), send: value => {replies.push(value);}});
    const next = h.client.request(message('next')).catch(() => {});
    await adapter({message: {type: 'resource.cancel', id: 'cancelled'}, send() {}}); await cancelled;
    h.reply('query-0'); await flush();
    expect(h.calls().filter(call => call.type.startsWith('resource.')).map(call => call.id)).toEqual(['next']);
    expect(replies).toEqual([]); h.reply('next'); await next;
  } finally {h.restore();}
});

test('a cancelled operation removes queued chunks without cancelling another operation', async () => {
  const h = harness();
  try {
    h.hold();
    const chunk = h.client.resourceRequest({type: 'resource.__chunk', id: 'chunk', handle: 'private', offset: 0} as NappletMessage, 'image').catch(() => 'cancelled');
    const other = h.client.request(message('other')).catch(() => {});
    const cancel = h.client.request({type: 'resource.cancel', id: 'image'} as NappletMessage).catch(() => {});
    expect(await chunk).toBe('cancelled'); h.reply('query-0'); await flush();
    expect(h.calls().filter(call => call.type.startsWith('resource.')).map(call => call.id)).toEqual(['other']);
    h.reply('other'); await other; await flush();
    expect(h.calls().at(-1).type).toBe('resource.cancel'); h.reply('image'); await cancel;
    expect(h.calls().some(call => call.id === 'chunk')).toBe(false);
  } finally {h.restore();}
});

test('queued work snapshots its payload, rechecks the recipient, and ignores a stale generation', async () => {
  const h = harness(); let live = true;
  try {
    h.hold(); const captured = message('captured') as any;
    const valid = h.client.resourceRequest(captured, 'captured', () => {if (!live) throw Error('revoked');}).catch(() => 'revoked');
    captured.url = 'https://mutated.invalid';
    const revoked = h.client.resourceRequest(message('revoked'), 'revoked', () => {throw Error('revoked');}).catch(() => 'revoked');
    h.reply('query-0', {}, 'old-generation'); expect(h.calls()).toHaveLength(4);
    h.reply('query-0'); expect(h.calls().at(-1).url).toBe('blossom:sha256:' + 'a'.repeat(64));
    h.reply('captured'); await valid; await flush(); expect(await revoked).toBe('revoked');
    expect(h.calls().some(call => call.id === 'revoked')).toBe(false);
  } finally {live = false; h.restore();}
});

test('queue time consumes the original deadline and timed-out work cannot post later', async () => {
  const h = harness({'resource.bytes': 100});
  try {
    h.hold(); let settled = false;
    const work = h.client.request(message('deadline')).catch(() => {settled = true;});
    h.advance(60); h.reply('query-0'); h.advance(39); await flush(); expect(settled).toBe(false);
    h.advance(1); await work; expect(settled).toBe(true);
    const queued = h.client.request(message('expires-queued')).catch(() => 'expired');
    // Restore four outstanding deferred reads, leaving this second Resource queued.
    h.client.request({type:'outbox.query',id:'later',filters:[{kinds:[1]}]} as NappletMessage).catch(() => {});
    const expires = h.client.request(message('never-posted')).catch(() => 'expired');
    h.advance(100); await queued; expect(await expires).toBe('expired');
    h.reply('later'); expect(h.calls().some(call => call.id === 'never-posted')).toBe(false);
  } finally {h.restore();}
});

test('the Resource queue is finite and destruction releases every queued timer and promise', async () => {
  const h = harness();
  try {
    h.hold(); const waiting = Array.from({length:16}, (_, i) => h.client.request(message('waiting-' + i)).catch(() => 'closed'));
    await expect(h.client.request(message('overflow'))).rejects.toThrow('Native capability unavailable');
    h.client.destroy(); expect(await Promise.all(waiting)).toEqual(Array(16).fill('closed')); expect(h.timers.size).toBe(0);
    await expect(h.client.request(message('after-destroy'))).rejects.toThrow(); expect(h.calls()).toHaveLength(4);
  } finally {h.restore();}
});

test('queued bytes are bounded and cancellation releases their reservation', async () => {
  const h = harness();
  try {
    h.hold(); const large = {...message('large'), padding:'x'.repeat(200 * 1024)} as NappletMessage;
    const work = h.client.request(large).catch(() => {});
    await expect(h.client.request({...message('overflow'), padding:'x'.repeat(60 * 1024)} as NappletMessage)).rejects.toThrow();
    await h.client.request({type:'resource.cancel',id:'large'} as NappletMessage); await work;
    const replacement = h.client.request(large).catch(() => {}); h.client.destroy(); await replacement;
  } finally {h.restore();}
});

test('ordinary four/deferred twelve limits remain and freed or failed slots drain Resource FIFO', async () => {
  const h = harness();
  try {
    h.hold(12); await expect(h.client.request({type:'outbox.query',id:'overflow',filters:[{kinds:[1]}]} as NappletMessage)).rejects.toThrow();
    await expect(h.client.request({type:'storage.get',id:'ordinary',key:'x',scope:'shared'} as NappletMessage)).rejects.toThrow();
    const first = h.client.request(message('first')).catch(() => 'failed'), second = h.client.request(message('second')).catch(() => {});
    h.throwNext('first'); for (let i = 0; i < 9; i++) h.reply('query-' + i);
    expect(await first).toBe('failed'); expect(h.calls().slice(-2).map(call => call.id)).toEqual(['first','second']);
    h.reply('second'); await second; expect(h.calls().slice(0,12).every(call => call.deferred === true)).toBe(true);
  } finally {h.restore();}
});

test('an expiring deferred read releases its slot without restarting the Resource deadline', async () => {
  const h = harness();
  try {
    h.hold(); h.advance(10); let settled = false;
    const work = h.client.request(message('after-timeout')).catch(() => {settled = true;});
    h.advance(26_990); expect(h.calls().at(-1).id).toBe('after-timeout');
    h.advance(9); await flush(); expect(settled).toBe(false);
    h.advance(1); await work; expect(settled).toBe(true);
  } finally {h.restore();}
});

test('duplicate cancellation retains its queued native control after the root descriptor settles', async () => {
  const h = harness();
  try {
    const root = h.client.request(message('image')); h.hold();
    let firstSettled = false;
    const firstCancel = h.client.request({type:'resource.cancel',id:'image'} as NappletMessage).then(() => {firstSettled = true;});
    h.reply('image'); await root; await flush();
    await h.client.request({type:'resource.cancel',id:'image'} as NappletMessage);
    expect(firstSettled).toBe(false); expect(h.calls().filter(call => call.type === 'resource.cancel')).toHaveLength(0);
    h.reply('query-0'); expect(h.calls().at(-1).type).toBe('resource.cancel');
    h.reply('image'); await firstCancel;
    expect(h.calls().filter(call => call.type === 'resource.cancel')).toHaveLength(1);
  } finally {h.restore();}
});
