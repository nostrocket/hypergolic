import {test, expect, type Page, type Frame} from '@playwright/test';
import {createServer, type Server} from 'node:http';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {finalizeEvent} from 'nostr-tools/pure';
import {injectNappletNamespacePrelude} from '@kehto/shell';
import {injectMeshFacade} from '../src/mesh-guest.ts';
import {injectSupportReport} from '../src/support-report.ts';

let server: Server, base: string;
const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'">`;
const basic = `<!doctype html><html><head>${csp}</head><body><p id="fixture">Owned Mesh facade</p><script>window.__api=window.napplet.mesh;</script></body></html>`;
test.beforeAll(async () => {
  server = createServer((_req, res) => {res.writeHead(200, {'content-type': 'text/html'}); res.end('<!doctype html><html><body>Owned parent</body></html>');});
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address();
  if (!address || typeof address === 'string') throw Error('Missing owned listener'); base = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));});
async function open(page: Page, options: {ready?: boolean; timeout?: number; html?: string; granted?: boolean} = {}): Promise<Frame> {
  const declared = options.granted === false ? [] : ['mesh'];
  // Same insertion order as renderGuest: facade executes before the installed namespace prelude.
  const namespace = injectNappletNamespacePrelude(injectSupportReport(options.html ?? basic), {domains: declared});
  const html = options.granted === false ? namespace : injectMeshFacade(namespace, {timeoutMs: options.timeout ?? 17000});
  await page.goto(base);
  await page.evaluate(({html, ready, declared}) => {
    const state = {requests: [] as any[], readyRequests: 0, frame: document.createElement('iframe'),
      send(message: object) {this.frame.contentWindow!.postMessage(message, '*');},
      initialize() {this.send({type: 'shell.init', capabilities: {domains: ['shell', ...declared]}, services: []});}};
    (window as any).__parent = state; state.frame.id = 'guest'; state.frame.style.cssText = 'width:100%;height:650px;border:0'; state.frame.sandbox.add('allow-scripts');
    window.addEventListener('message', event => {
      if (event.source !== state.frame.contentWindow) return;
      if (event.data?.type === 'shell.ready') {state.readyRequests++; if (ready) state.initialize(); return;}
      if (typeof event.data?.type === 'string' && event.data.type.startsWith('mesh.')) state.requests.push(event.data);
    });
    state.frame.srcdoc = html; document.body.append(state.frame);
  }, {html, ready: options.ready !== false, declared});
  const frame = await (await page.locator('#guest').elementHandle())!.contentFrame(); if (!frame) throw Error('Missing opaque guest');
  await expect.poll(() => frame.evaluate(() => typeof (window as any).napplet?.shell?.ready)).toBe('function');
  if (options.ready !== false) await frame.evaluate(async () => {await (window as any).napplet.shell.ready();});
  return frame;
}
const requests = (page: Page) => page.evaluate(() => (window as any).__parent.requests as any[]);
const send = (page: Page, value: object) => page.evaluate(value => (window as any).__parent.send(value), value);
async function latest(page: Page, type: string, count = 1): Promise<any> {
  await expect.poll(async () => (await requests(page)).filter(row => row.type === type).length).toBeGreaterThanOrEqual(count);
  return (await requests(page)).filter(row => row.type === type).at(-1);
}

test('installed Kehto bootstrap preserves eager facade and info/blobs/publication result semantics', async ({page}) => {
  const guest = await open(page);
  expect(await guest.evaluate(() => (window as any).__api === (window as any).napplet.mesh)).toBe(true);
  expect(await guest.evaluate(() => location.origin)).toBe('null');
  await guest.evaluate(() => {
    const api = (window as any).napplet.mesh, state: Record<string, unknown> = (window as any).__results = {};
    api.info().then((value: unknown) => state.info = value); api.blobs(['AB'.repeat(32), 'ab'.repeat(32)]).then((value: unknown) => state.blobs = value);
    api.publish({kind: 1, content: 'hello'}).then((value: unknown) => state.publish = value);
  });
  const info = await latest(page, 'mesh.info'), blobs = await latest(page, 'mesh.blobs'), publish = await latest(page, 'mesh.publish');
  expect(blobs.hashes).toEqual(['ab'.repeat(32)]);
  await send(page, {type: 'mesh.info.result', id: info.id, online: false, peers: 0, limits: {publishTtl: 2, subscribeTtl: 1}});
  await send(page, {type: 'mesh.blobs.result', id: blobs.id, peers: 2, blobs: {['ab'.repeat(32)]: 1}});
  await send(page, {type: 'mesh.publish.result', id: publish.id, ok: false, error: 'owned refusal'});
  await expect.poll(() => guest.evaluate(() => (window as any).__results)).toEqual({info: {online: false, peers: 0, limits: {publishTtl: 2, subscribeTtl: 1}}, blobs: {peers: 2, blobs: {['ab'.repeat(32)]: 1}}, publish: {ok: false, error: 'owned refusal'}});
  await guest.evaluate(() => {const api = (window as any).napplet.mesh, state: string[] = (window as any).__errors = []; api.info().catch((error: Error) => state.push(error.message)); api.blobs([]).catch((error: Error) => state.push(error.message));});
  const badInfo = await latest(page, 'mesh.info', 2), badBlobs = await latest(page, 'mesh.blobs', 2);
  await send(page, {type: 'mesh.info.result', id: badInfo.id, error: 'circle unavailable'}); await send(page, {type: 'mesh.blobs.result', id: badBlobs.id, error: 'catalog unavailable'});
  await expect.poll(() => guest.evaluate(() => (window as any).__errors)).toEqual(['circle unavailable', 'catalog unavailable']);
  await guest.evaluate(() => {(window as any).napplet.mesh.publish({kind: 1, content: 'owned success'}).then((value: unknown) => (window as any).__success = value);});
  const accepted = await latest(page, 'mesh.publish', 2);
  const signed = JSON.parse(JSON.stringify(finalizeEvent({kind: 1, content: 'owned success', tags: [], created_at: 123}, new Uint8Array(32).fill(3))));
  await send(page, {type: 'mesh.publish.result', id: accepted.id, ok: true, event: signed, eventId: signed.id, ttl: 2});
  await expect.poll(() => guest.evaluate(() => (window as any).__success)).toEqual({ok: true, event: signed, eventId: signed.id, ttl: 2});
});

test('caller snapshots precede shell.ready and close before bootstrap creates no native subscription', async ({page}) => {
  const guest = await open(page, {ready: false});
  await guest.evaluate(() => {
    const api = (window as any).napplet.mesh, event = {kind: 20431, content: 'before', tags: [['t', 'before']], created_at: 123};
    const filters = [{kinds: [20431], '#t': ['before']}], hashes = ['AB'.repeat(32)];
    api.publish(event, {ttl: 2}); const kept = api.subscribe(filters, {ttl: 0}); api.blobs(hashes);
    const stopped = api.subscribe([{kinds: [1]}]); stopped.close();
    event.content = 'after'; event.tags[0]![1] = 'after'; filters[0]!['#t'][0] = 'after'; hashes[0] = 'cd'.repeat(32);
    (window as any).__kept = kept;
  });
  expect(await requests(page)).toEqual([]);
  await page.evaluate(() => (window as any).__parent.initialize());
  await expect.poll(async () => (await requests(page)).length).toBe(3);
  const rows = await requests(page);
  expect(rows.find(row => row.type === 'mesh.publish').event).toEqual({kind: 20431, content: 'before', tags: [['t', 'before']], created_at: 123});
  expect(rows.find(row => row.type === 'mesh.subscribe').filters).toEqual([{kinds: [20431], '#t': ['before']}]);
  expect(rows.find(row => row.type === 'mesh.blobs').hashes).toEqual(['ab'.repeat(32)]);
  expect(rows.filter(row => row.type === 'mesh.close')).toEqual([]);
  await guest.evaluate(() => (window as any).__kept.close());
  const close = await latest(page, 'mesh.close'); expect(Object.keys(close).sort()).toEqual(['subId', 'type']);
});

test('refused and opened subscription closures reach closed listeners; stream and callback shapes match WoT', async ({page}) => {
  const guest = await open(page);
  await guest.evaluate(() => {
    const state: {events: unknown[]; eose: unknown[]; closed: unknown[]} = (window as any).__stream = {events: [], eose: [], closed: []}, api = (window as any).napplet.mesh;
    const sub = api.subscribe([{kinds: [20431]}], {ttl: 0});
    sub.on('event', (value: unknown) => state.events.push(value)); sub.on('event', () => {throw Error('publisher handler');});
    sub.on('eose', (value: unknown) => state.eose.push(value)); sub.on('closed', (value: unknown) => state.closed.push(value)); (window as any).__sub = sub;
  });
  const sub = await latest(page, 'mesh.subscribe');
  const event = {id: '1'.repeat(64), pubkey: '2'.repeat(64), kind: 20431, content: '{"v":1}', tags: [['t', 'wotformer']], created_at: 123, sig: '3'.repeat(128)};
  await send(page, {type: 'mesh.event', subId: sub.subId, result: {event}});
  await send(page, {type: 'mesh.eose', subId: sub.subId, ttl: 0}); await send(page, {type: 'mesh.eose', subId: sub.subId, ttl: 0});
  await send(page, {type: 'mesh.closed', subId: sub.subId, reason: 'owner closed'});
  await send(page, {type: 'mesh.event', subId: sub.subId, result: {event}});
  await expect.poll(() => guest.evaluate(() => (window as any).__stream)).toEqual({events: [{event}], eose: [0], closed: ['owner closed']});
  await guest.evaluate(() => {const state = (window as any).__stream; (window as any).napplet.mesh.subscribe([{}]).on('closed', (reason: unknown) => state.closed.push(reason));});
  const refused = await latest(page, 'mesh.subscribe'); await send(page, {type: 'mesh.subscribe.result', id: refused.id, error: 'mesh not granted'});
  await expect.poll(() => guest.evaluate(() => (window as any).__stream.closed)).toEqual(['owner closed', 'mesh not granted']);
});

test('actual parent WindowProxy is required despite synthetic events and poisoned MessageEvent prototypes', async ({page}) => {
  const guest = await open(page);
  await guest.evaluate(() => {(window as any).__state = []; (window as any).napplet.mesh.info().then((value: unknown) => (window as any).__state.push(value));});
  const request = await latest(page, 'mesh.info');
  const reply = {type: 'mesh.info.result', id: request.id, online: true, peers: 1, limits: {publishTtl: 2, subscribeTtl: 1}};
  await guest.evaluate(reply => {
    window.dispatchEvent(new MessageEvent('message', {source: parent, data: reply}));
    Object.defineProperty(MessageEvent.prototype, 'source', {get: () => parent, configurable: true});
    Object.defineProperty(MessageEvent.prototype, 'data', {get: () => reply, configurable: true});
    window.postMessage(reply, '*');
  }, reply);
  await page.waitForTimeout(50); expect(await guest.evaluate(() => (window as any).__state)).toEqual([]);
  await page.evaluate(reply => {const sibling = document.createElement('iframe'); sibling.sandbox.add('allow-scripts'); sibling.srcdoc = '<script>parent.frames[0].postMessage('+JSON.stringify(reply)+',"*")<\/script>'; document.body.append(sibling);}, reply);
  await page.waitForTimeout(50); expect(await guest.evaluate(() => (window as any).__state)).toEqual([]);
  await send(page, reply); await expect.poll(() => guest.evaluate(() => (window as any).__state.length)).toBe(1);
});

test('timeouts and pagehide close only posted subscriptions, reject waiting work, and ignore late replies', async ({page}) => {
  const guest = await open(page, {timeout: 120});
  await guest.evaluate(() => {const api = (window as any).napplet.mesh, state: {closed: unknown[]; info: string[]; publish: unknown[]} = (window as any).__timeout = {closed: [], info: [], publish: []}; api.subscribe([{}]).on('closed', (value: unknown) => state.closed.push(value)); api.info().catch((error: Error) => state.info.push(error.message)); api.publish({kind: 1, content: ''}).then((value: unknown) => state.publish.push(value));});
  const sub = await latest(page, 'mesh.subscribe'), info = await latest(page, 'mesh.info');
  await expect.poll(() => guest.evaluate(() => (window as any).__timeout.closed)).toEqual(['Mesh subscription timed out']);
  await expect.poll(async () => (await requests(page)).filter(row => row.type === 'mesh.close').length).toBe(1);
  await send(page, {type: 'mesh.info.result', id: info.id, online: false, peers: 0, limits: {publishTtl: 2, subscribeTtl: 1}});
  await send(page, {type: 'mesh.event', subId: sub.subId, result: {event: {}}});
  expect(await guest.evaluate(() => (window as any).__timeout.publish)).toEqual([{ok: false, error: 'Mesh request timed out'}]);
  await guest.evaluate(() => {const api = (window as any).napplet.mesh, state: {closed: unknown[]; rejected: string[]} = (window as any).__hide = {closed: [], rejected: []}; api.subscribe([{}]).on('closed', (value: unknown) => state.closed.push(value)); api.info().catch((error: Error) => state.rejected.push(error.message));});
  await latest(page, 'mesh.subscribe', 2); await guest.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await expect.poll(() => guest.evaluate(() => (window as any).__hide)).toEqual({closed: ['Mesh page closed'], rejected: ['Mesh page closed']});
  const count = (await requests(page)).length;
  await guest.evaluate(() => {(window as any).napplet.mesh.publish({kind: 1, content: ''});}); await page.waitForTimeout(30);
  expect((await requests(page)).length).toBe(count);
});

test('bounded pending/listeners/subscriptions refuse locally and invalid arrays are not truncated', async ({page}) => {
  const guest = await open(page);
  const result = await guest.evaluate(async () => {
    const api = (window as any).napplet.mesh, errors: string[] = [], results: unknown[] = [];
    const held = Array.from({length: 4}, () => api.info().catch((error: Error) => errors.push(error.message)));
    const fifth = await api.publish({kind: 1, content: ''});
    const subs = Array.from({length: 5}, () => api.subscribe([{}])); subs.forEach(sub => sub.on('closed', (reason: unknown) => results.push(reason)));
    const row = api.subscribe([{}]);
    // Pending capacity closes these handles without a native post; test listener limit separately after reset.
    try {await api.blobs(Array(65).fill('a'.repeat(64)));} catch {results.push('invalid65');}
    void held; void row; return {fifth, closed: results};
  });
  expect(result.fifth.ok).toBe(false); expect(result.closed).toContain('invalid65');
  expect((await requests(page)).filter(row => row.type === 'mesh.info')).toHaveLength(4);
  await page.reload(); const second = await open(page);
  const listener = await second.evaluate(() => {const api = (window as any).napplet.mesh, sub = api.subscribe([{}]); let refused = false; for (let i = 0; i < 16; i++) sub.on('event', () => {}); try {sub.on('event', () => {});} catch {refused = true;} const invalid: unknown[] = []; api.subscribe([{}, {}, {}, {}, {}]).on('closed', (reason: unknown) => invalid.push(reason)); return {refused, invalid};});
  expect(listener.refused).toBe(true); expect(listener.invalid).toHaveLength(1);
  await second.evaluate(() => {for (let i = 0; i < 3; i++) (window as any).napplet.mesh.subscribe([{}]);});
  await latest(page, 'mesh.subscribe', 4);
  for (const row of (await requests(page)).filter(row => row.type === 'mesh.subscribe')) await send(page, {type: 'mesh.eose', subId: row.subId, ttl: 1});
  const fifthSubscription = await second.evaluate(() => {let reason: unknown; (window as any).napplet.mesh.subscribe([{}]).on('closed', (value: unknown) => {reason = value;}); return reason;});
  expect(typeof fifthSubscription).toBe('string'); expect((await requests(page)).filter(row => row.type === 'mesh.subscribe')).toHaveLength(4);
});

const publishedSource = process.env.MESH_VERIFIED_WOTFORMER_HTML;
function publication(): string {
  if (!publishedSource) throw Error('Explicit verified publisher fixture required');
  const raw = readFileSync(publishedSource, 'utf8');
  expect(createHash('sha256').update(raw).digest('hex')).toBe('93f591ddf20fcdcdfcfb6fff298b318dbd3e57f2a45e667700676dfdf08ec46c');
  return raw.replace('<head>', '<head>'+csp);
}
async function publisherReady(guest: Frame): Promise<void> {
  await guest.waitForLoadState('load'); // Inline module initialization completes before load; WebKit may decline eager programmatic focus.
}
test('unchanged verified WoTformer Controller consumes an owned Display event and sends through the facade', async ({page}) => {
  test.skip(!publishedSource, 'Explicit verified publication fixture required');
  const guest = await open(page, {html: publication()}); await publisherReady(guest);
  await guest.locator('#pickController').click(); await expect(guest.locator('#ctl')).toBeVisible();
  const sub = await latest(page, 'mesh.subscribe'); expect(sub.ttl).toBe(0); expect(sub.filters[0].kinds).toEqual([20431]); expect(sub.filters[0]['#t']).toEqual(['wotformer']);
  await send(page, {type: 'mesh.eose', subId: sub.subId, ttl: 0});
  const display = JSON.parse(JSON.stringify(finalizeEvent({kind: 20431, created_at: Math.floor(Date.now()/1000), tags: [['t', 'wotformer']],
    content: JSON.stringify({v: 1, sid: 'owned-display', t: 'disp', name: 'Owned display', n: 0, max: 4, ph: 'lobby'})}, new Uint8Array(32).fill(2))));
  await send(page, {type: 'mesh.event', subId: sub.subId, result: {event: display}});
  await guest.getByRole('button', {name: /Owned display/}).click();
  await expect.poll(async () => (await requests(page)).some(row => row.type === 'mesh.publish' && JSON.parse(row.event.content).t === 'join')).toBe(true);
  const publish = (await requests(page)).find(row => row.type === 'mesh.publish' && JSON.parse(row.event.content).t === 'join'); expect(publish.event.kind).toBe(20431); expect(publish.event.tags[0]).toEqual(['t', 'wotformer']); expect(publish.event.tags[1][0]).toBe('expiration'); expect(typeof publish.event.created_at).toBe('number'); expect(JSON.parse(publish.event.content)).toMatchObject({v: 1, t: 'join', to: 'owned-display'});
  await send(page, {type: 'mesh.publish.result', id: publish.id, ok: false, error: 'owned publication refusal'});
  await expect(guest.locator('#ctlStatus')).toContainText('owned publication refusal');
  await send(page, {type: 'mesh.closed', subId: sub.subId, reason: 'owned subscription closure'});
  await expect(guest.locator('#ctlStatus')).toContainText('owned subscription closure');
});

test('real pagehide tears down locally; departing close is best-effort and omitted injection has no namespace', async ({page}, testInfo) => {
  const lifecycle: string[] = []; page.on('console', message => {if (message.text().startsWith('owned-pagehide:')) lifecycle.push(message.text());});
  const guest = await open(page);
  await guest.evaluate(() => {(window as any).napplet.mesh.subscribe([{}]).on('closed', (reason: unknown) => console.log('owned-pagehide:closed:'+reason)); window.addEventListener('pagehide', () => console.log('owned-pagehide:event'));});
  const request = await latest(page, 'mesh.subscribe'); await send(page, {type: 'mesh.eose', subId: request.subId, ttl: 1});
  await guest.evaluate(() => {location.href = 'about:blank';});
  await expect.poll(() => lifecycle).toContain('owned-pagehide:closed:Mesh page closed');
  await expect.poll(() => lifecycle).toContain('owned-pagehide:event');
  // Chrome can discard an outgoing postMessage from a departing document. Parent source disposal is authoritative.
  const closes = (await requests(page)).filter(row => row.type === 'mesh.close'); expect(closes.length).toBeLessThanOrEqual(1);
  for (const close of closes) expect(close).toEqual({type: 'mesh.close', subId: request.subId});
  await testInfo.attach('actual-pagehide-observation', {body: JSON.stringify({lifecycle, requests: await requests(page), frameUrl: guest.url(), parentDisposalRequired: true}), contentType: 'application/json'});
  const ungranted = await open(page, {granted: false}); expect(await ungranted.evaluate(() => typeof (window as any).napplet.mesh)).toBe('undefined');
});

test('bootstrap deadline closes waiting work and later shell.init cannot create orphan operations', async ({page}) => {
  const guest = await open(page, {ready: false, timeout: 120});
  await guest.evaluate(() => {
    const api = (window as any).napplet.mesh, results: {info: string[]; publish: unknown[]; closed: unknown[]} = (window as any).__boot = {info: [], publish: [], closed: []};
    api.info().catch((error: Error) => results.info.push(error.message));
    api.publish({kind: 1, content: ''}).then((result: unknown) => results.publish.push(result));
    api.subscribe([{}]).on('closed', (reason: unknown) => results.closed.push(reason));
  });
  await expect.poll(() => guest.evaluate(() => (window as any).__boot)).toEqual({info: ['Mesh request timed out'], publish: [{ok: false, error: 'Mesh request timed out'}], closed: ['Mesh subscription timed out']});
  expect(await requests(page)).toEqual([]); await page.evaluate(() => (window as any).__parent.initialize());
  await guest.evaluate(async () => {await (window as any).napplet.shell.ready();}); expect(await requests(page)).toEqual([]);
});
