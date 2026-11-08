import {test, expect, type Page} from '@playwright/test';
import {createServer, type Server} from 'node:http';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {finalizeEvent, getPublicKey} from 'nostr-tools/pure';

const generation = '12345678-1234-4234-8234-123456789abc', revision = '22345678-1234-4234-8234-123456789abc';
const key = new Uint8Array(32).fill(7), author = getPublicKey(key);
const context = {profile: 'paired-lan-v1', sessionId: generation, sourceRevision: revision, author, publishTtl: 5, subscribeTtl: 3, granted: true};
let server: Server, base: string;
test.beforeAll(async () => {
  const assets = process.env.MESH_NATIVE_PROOF_ASSETS ?? fileURLToPath(new URL('../.test-fixtures/mesh-native/', import.meta.url));
  server = createServer((request, response) => {
    const name = request.url?.split('?')[0]?.slice(1); if (!['main.html', 'parent.html', 'main.js', 'adapter.js'].includes(name ?? '')) {response.writeHead(404); response.end(); return;}
    response.writeHead(200, {'content-type': name!.endsWith('.js') ? 'text/javascript' : 'text/html'}); response.end(readFileSync(join(assets, name!)));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address();
  if (!address || typeof address === 'string') throw Error('Missing owned listener'); base = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));});
const digest = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');
async function open(page: Page, options: {main?: boolean; domains?: string[]; mesh?: unknown; change?: boolean; large?: boolean} = {}) {
  const html = `<!doctype html><html><head><title>Owned Mesh</title></head><body><p id="owned">Owned Mesh</p>${options.large ? '<!--' + 'x'.repeat(50000) + '-->' : ''}</body></html>`;
  const hash = digest(html), metadata = {publisher: '1'.repeat(64), appId: 'owned-mesh', eventId: '2'.repeat(64), htmlHash: hash, version: digest(`${hash} /index.html\n`), domains: options.domains ?? ['mesh'], ...(options.mesh === null ? {} : {mesh: options.mesh ?? context})};
  await page.addInitScript(({generation, metadata, html, change}) => {
    if (window !== top) return;
    const listeners = new Set<(event: {data: string}) => void>();
    const state = {posts: [] as any[], emit(value: object) {for (const listener of [...listeners]) listener({data: JSON.stringify(value)});}};
    (window as any).__native = state;
    Object.defineProperty(window, 'HypergolicHost', {value: {
      addEventListener: (_: string, listener: (event: {data: string}) => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: (event: {data: string}) => void) => listeners.delete(listener),
      postMessage(raw: string) {
        const row = JSON.parse(raw); state.posts.push(row);
        if (row.type !== 'artifact.read') return;
        const bytes = new TextEncoder().encode(html), part = bytes.slice(row.sequence * 49152, (row.sequence + 1) * 49152);
        const claims = change && row.sequence > 0 ? {...metadata, mesh: {...metadata.mesh, sourceRevision: '32345678-1234-4234-8234-123456789abc'}} : metadata;
        state.emit({...claims, type: 'artifact.chunk', sessionId: generation, sequence: row.sequence, totalBytes: bytes.length, byteLength: part.length, base64: btoa(String.fromCharCode(...part)), done: (row.sequence + 1) * 49152 >= bytes.length});
      },
    }});
  }, {generation, metadata: metadata as any, html, change: options.change ?? false});
  await page.goto(base + (options.main ? `/main.html?sessionId=${generation}&source=published` : '/parent.html'));
  if (!options.main) await page.evaluate(({generation, context}) => {
    const api = (window as any).OwnedMeshAdapter;
    const client = api.createNativeClient((window as any).HypergolicHost, generation, {mesh: api.captureNativeMeshContext(context, generation)});
    (window as any).__client = client; (window as any).__results = {}; (window as any).__streams = [];
  }, {generation, context});
}
const posts = (page: Page) => page.evaluate(() => (window as any).__native.posts as any[]);
async function next(page: Page, type: string, count = 1) {
  await expect.poll(async () => (await posts(page)).filter(row => row.type === type).length).toBeGreaterThanOrEqual(count);
  return (await posts(page)).filter(row => row.type === type).at(-1);
}
const emit = (page: Page, value: object) => page.evaluate(value => (window as any).__native.emit(value), value);
const response = (sequence: number, value: unknown) => ({type: 'mesh.response', sessionId: generation, sourceRevision: revision, sequence, response: JSON.stringify(value)});
const stream = (sequence: number, delivery: number, value: unknown, phase = 'stored') => ({type: 'mesh.stream', sessionId: generation, sourceRevision: revision, sequence, delivery, phase, response: JSON.stringify(value)});
const signed = (content: string, kind = 20431) => JSON.parse(JSON.stringify(finalizeEvent({kind, content, tags: [], created_at: Math.floor(Date.now() / 1000)}, key)));

test('native context is exact, branded, generation bound and does not globally advertise Mesh', async ({page}) => {
  await open(page);
  const result = await page.evaluate(({generation, context}) => {
    const api = (window as any).OwnedMeshAdapter, native = (window as any).HypergolicHost;
    const bad = [undefined, context, {...context, sessionId: 'wrong'}].map(mesh => api.createNativeClient(native, generation, {mesh}).mesh.available());
    const rejected = [{...context, extra: true}, {...context, granted: false}, {...context, publishTtl: 256}, {...context, sourceRevision: 'not-native'}].map(value => {try {api.captureNativeMeshContext(value, generation); return false;} catch {return true;}});
    return {bad, rejected, available: (window as any).__client.mesh.available(), supported: api.supportedDomains.includes('mesh')};
  }, {generation, context});
  expect(result).toEqual({bad: [false, false, false], rejected: [true, true, true, true], available: true, supported: false});
  expect(await posts(page)).toEqual([]);
});

test('all unary methods capture before await, clamp to actual native caps and verify correlated signed publication', async ({page}) => {
  await open(page);
  await page.evaluate(() => {
    const client = (window as any).__client.mesh, results = (window as any).__results;
    const event = {kind: 20431, content: 'before', tags: [] as string[][], created_at: 123};
    client.request({type: 'mesh.publish', id: 'publish', event, ttl: 9}).then((value: unknown) => results.publish = value);
    event.content = 'after'; event.tags.push(['after']);
    client.request({type: 'mesh.info', id: 'info'}).then((value: unknown) => results.info = value);
    client.request({type: 'mesh.blobs', id: 'blobs', hashes: ['AB'.repeat(32), 'ab'.repeat(32)]}).then((value: unknown) => results.blobs = value);
  });
  const rows = (await posts(page)).filter(row => row.type === 'mesh'), request = JSON.parse(rows[0].message);
  expect(request.event).toEqual({kind: 20431, content: 'before', tags: [], created_at: 123}); expect(request.ttl).toBe(5);
  expect(rows.every(row => row.timeoutMs > 0 && row.timeoutMs <= (JSON.parse(row.message).type === 'mesh.blobs' ? 3000 : 15000))).toBe(true);
  const event = signed('before');
  await emit(page, response(rows[0].sequence, {type: 'mesh.publish.result', id: 'publish', ok: true, event, eventId: event.id, ttl: 5}));
  await emit(page, response(rows[1].sequence, {type: 'mesh.info.result', id: 'info', online: true, peers: 1, limits: {publishTtl: 5, subscribeTtl: 3}}));
  await emit(page, response(rows[2].sequence, {type: 'mesh.blobs.result', id: 'blobs', peers: 1, blobs: {['ab'.repeat(32)]: 1}}));
  await expect.poll(() => page.evaluate(() => Object.keys((window as any).__results).sort())).toEqual(['blobs', 'info', 'publish']);
  expect((await posts(page)).some(row => row.type === 'capability' || row.type === 'relay-stream')).toBe(false);
});

test('native stream correlation, local EOSE, ACK, refusal and id-free close stay separate from Relay', async ({page}) => {
  await open(page);
  await page.evaluate(() => {(window as any).__client.mesh.subscribe({type: 'mesh.subscribe', id: 'start', subId: 'same-id', filters: [{kinds: [20431]}], ttl: 0}, (value: unknown) => (window as any).__streams.push(value));});
  const sub = await next(page, 'mesh'), event = signed('stored');
  await emit(page, stream(sub.sequence, 1, {type: 'mesh.event', subId: 'same-id', result: {event}}));
  await emit(page, stream(sub.sequence, 2, {type: 'mesh.eose', subId: 'same-id', ttl: 0}));
  await page.clock.install(); await page.clock.runFor(16000);
  await emit(page, stream(sub.sequence, 3, {type: 'mesh.event', subId: 'same-id', result: {event: signed('live')}}, 'live'));
  await expect.poll(() => page.evaluate(() => (window as any).__streams.length)).toBe(3);
  expect((await posts(page)).filter(row => row.type === 'mesh.ack').map(row => [row.streamSequence, row.delivery])).toEqual([[sub.sequence, 1], [sub.sequence, 2], [sub.sequence, 3]]);
  await page.evaluate(() => {(window as any).__client.mesh.close({type: 'mesh.close', subId: 'same-id'}); (window as any).__client.mesh.subscribe({type: 'mesh.subscribe', id: 'refused', subId: 'same-id', filters: [{}]}, (value: unknown) => (window as any).__streams.push(value));});
  const rows = (await posts(page)).filter(row => row.type === 'mesh');
  expect(JSON.parse(rows[1].message)).toEqual({type: 'mesh.close', subId: 'same-id'});
  await emit(page, response(rows[2].sequence, {type: 'mesh.subscribe.result', id: 'refused', error: 'not paired'}));
  await expect.poll(() => page.evaluate(() => (window as any).__streams.at(-1))).toEqual({type: 'mesh.subscribe.result', id: 'refused', error: 'not paired'});
});

test('wrong result identities, malformed success and out-of-order stream deliveries cannot be accepted', async ({page}) => {
  await open(page);
  await page.evaluate(() => {(window as any).__client.mesh.request({type: 'mesh.info', id: 'original'}).then((value: unknown) => (window as any).__results.accepted = value, () => (window as any).__results.rejected = true);});
  const request = await next(page, 'mesh'), good = response(request.sequence, {type: 'mesh.info.result', id: 'original', online: false, peers: 0, limits: {publishTtl: 5, subscribeTtl: 3}});
  await emit(page, {...good, sessionId: 'other'}); await emit(page, {...good, sourceRevision: 'other'});
  expect(await page.evaluate(() => (window as any).__results)).toEqual({});
  await emit(page, response(request.sequence, {type: 'mesh.info.result', id: 'wrong', online: false, peers: 0, limits: {publishTtl: 5, subscribeTtl: 3}}));
  await expect.poll(() => page.evaluate(() => (window as any).__results)).toEqual({rejected: true});
  await emit(page, good);
  await page.evaluate(() => {(window as any).__client.mesh.subscribe({type: 'mesh.subscribe', id: 'sub', subId: 'sub', filters: [{}]}, (value: unknown) => (window as any).__streams.push(value));});
  const sub = await next(page, 'mesh', 2); await emit(page, stream(sub.sequence, 2, {type: 'mesh.eose', subId: 'sub', ttl: 3}));
  await expect.poll(() => page.evaluate(() => (window as any).__streams)).toEqual([{type: 'mesh.closed', subId: 'sub', reason: 'Invalid Mesh delivery'}]);
  expect((await posts(page)).filter(row => row.type === 'mesh.ack')).toEqual([]);
});

test('four pending slots and original deadlines reject late replies without poisoning a fresh request', async ({page}) => {
  await open(page); await page.clock.install();
  await page.evaluate(() => {for (let index = 0; index < 5; index++) (window as any).__client.mesh.request({type: 'mesh.blobs', id: 'held-' + index, hashes: []}).then((value: unknown) => (window as any).__results[index] = value, () => (window as any).__results[index] = 'rejected');});
  expect((await posts(page)).filter(row => row.type === 'mesh')).toHaveLength(4);
  await page.clock.runFor(3001); await expect.poll(() => page.evaluate(() => Object.values((window as any).__results))).toEqual(Array(5).fill('rejected'));
  const old = (await posts(page))[0]; await emit(page, response(old.sequence, {type: 'mesh.blobs.result', id: 'held-0', peers: 0, blobs: {}}));
  await page.evaluate(() => {(window as any).__client.mesh.request({type: 'mesh.info', id: 'fresh'}).then((value: unknown) => (window as any).__results.fresh = value);});
  const fresh = await next(page, 'mesh', 5); expect(fresh.sequence).toBeGreaterThan(old.sequence);
  await emit(page, response(fresh.sequence, {type: 'mesh.info.result', id: 'fresh', online: false, peers: 0, limits: {publishTtl: 5, subscribeTtl: 3}}));
  await expect.poll(() => page.evaluate(() => (window as any).__results.fresh?.id)).toBe('fresh');
});

test('native revocation is irreversible and destroy is registration-scoped and idempotent', async ({page}) => {
  await open(page);
  await page.evaluate(() => {(window as any).__client.mesh.subscribe({type: 'mesh.subscribe', id: 'sub', subId: 'sub', filters: [{}]}, (value: unknown) => (window as any).__streams.push(value));});
  await emit(page, {type: 'mesh.revoked', sessionId: generation, sourceRevision: revision});
  await expect.poll(() => page.evaluate(() => (window as any).__streams)).toEqual([{type: 'mesh.closed', subId: 'sub', reason: 'Mesh source revoked'}]);
  await page.evaluate(() => {(window as any).__client.destroy(); (window as any).__client.destroy();});
  expect((await posts(page)).filter(row => row.type === 'mesh.dispose')).toEqual([{type: 'mesh.dispose', sessionId: generation, sourceRevision: revision, sequence: 2}]);
  expect(await page.evaluate(() => (window as any).__client.mesh.available())).toBe(false);
});

test('verified native artifact activates the actual eager SDK facade and removal disposes its source', async ({page}) => {
  await open(page, {main: true});
  const guest = page.frameLocator('#napplet'); await expect(guest.locator('#owned')).toHaveText('Owned Mesh');
  const frame = await (await page.locator('#napplet').elementHandle())!.contentFrame(); if (!frame) throw Error('Missing guest');
  await frame.evaluate(() => {(window as any).__values = []; (window as any).napplet.mesh.info().then((value: unknown) => (window as any).__values.push(value));});
  const row = await next(page, 'mesh'), request = JSON.parse(row.message);
  await emit(page, response(row.sequence, {type: 'mesh.info.result', id: request.id, online: false, peers: 0, limits: {publishTtl: 5, subscribeTtl: 3}}));
  await expect.poll(() => frame.evaluate(() => (window as any).__values)).toEqual([{online: false, peers: 0, limits: {publishTtl: 5, subscribeTtl: 3}}]);
  await page.locator('#napplet').evaluate(frame => frame.remove()); await next(page, 'mesh.dispose');
  expect((await posts(page)).filter(row => row.type === 'capability' || row.type === 'relay-stream')).toEqual([]);
});

test('artifact context cannot widen absent grants or change across chunks; navigation retires old source', async ({page}) => {
  const ordinary = await page.context().newPage();
  await open(ordinary, {main: true, domains: ['theme'], mesh: null});
  await expect(ordinary.frameLocator('#napplet').locator('#owned')).toHaveText('Owned Mesh');
  const ordinaryFrame = await (await ordinary.locator('#napplet').elementHandle())!.contentFrame();
  if (!ordinaryFrame) throw Error('Missing ordinary guest');
  expect(await ordinaryFrame.evaluate(() => typeof (window as any).napplet.mesh)).toBe('undefined');
  expect((await posts(ordinary)).filter(row => row.type.startsWith('mesh'))).toEqual([]);
  await ordinary.close();
  for (const options of [{mesh: null}, {domains: ['theme']}, {mesh: {...context, sessionId: 'wrong'}}, {large: true, change: true}]) {
    const other = await page.context().newPage();
    await open(other, {main: true, ...options}); await expect(other.getByRole('alert')).toHaveText('The napplet could not be loaded.');
    expect((await posts(other)).filter(row => row.type === 'mesh')).toEqual([]); await other.close();
  }
  await open(page, {main: true}); await expect(page.frameLocator('#napplet').locator('#owned')).toHaveCount(1);
  const frame = await (await page.locator('#napplet').elementHandle())!.contentFrame(); if (!frame) throw Error('Missing guest');
  await frame.evaluate(() => {location.href = 'about:blank';});
  await expect(page.getByRole('alert')).toHaveText('The napplet could not be loaded.'); await next(page, 'mesh.dispose');
});
