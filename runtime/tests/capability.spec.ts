import { test, expect, type Page, type Frame } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window !== window.top) return;
    Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Storage disabled', 'SecurityError'); } });
  });
});

async function open(page: Page, query = ''): Promise<Frame> {
  await page.goto(`/tests/capabilities/index.html${query}`);
  await expect(page.locator('#napplet')).toHaveCount(1);
  const frame = page.frames().find(frame => frame.parentFrame());
  if (!frame) throw new Error('Missing sandbox frame');
  if (!query.includes('holdReady')) await expect(frame.locator('body')).toHaveAttribute('data-ready', 'true');
  return frame;
}
const state = (page: Page) => page.evaluate(() => (window as any).lab.state);
const received = (frame: Frame) => frame.evaluate(() => (window as any).received);
async function barrier(frame: Frame): Promise<void> {
  const id = `barrier-${Date.now()}`;
  await frame.evaluate(id => parent.postMessage({ type: 'theme.get', id }, '*'), id);
  await expect.poll(async () => (await received(frame)).some((message: any) => message.id === id)).toBe(true);
}
const template = { kind: 1, content: 'test-only never signed', tags: [['t', 'adapter-proof']], created_at: 1 };

test('genuine shell handshake admits the declared domains once and no native bridge exists', async ({ page }) => {
  const frame = await open(page);
  const environment = await frame.evaluate(() => (window as any).napplet.shell.ready());
  expect(environment.capabilities.domains).toEqual(['relay', 'storage', 'theme']);
  await frame.evaluate(() => parent.postMessage({ type: 'shell.ready' }, '*'));
  await barrier(frame);
  expect((await received(frame)).filter((message: any) => message.type === 'shell.init')).toHaveLength(1);
  expect(await frame.evaluate(() => ({ bridge: typeof (window as any).HypergolicHost,
    parentAccess: (() => { try { return typeof (parent as any).lab; } catch { return 'blocked'; } })() })))
    .toEqual({ bridge: 'undefined', parentAccess: 'blocked' });
});

test('allowed original envelopes route after ACL and firewall without signing or legacy relay service', async ({ page }) => {
  const frame = await open(page);
  const reply = await frame.evaluate(async template => {
    const api = (window as any).napplet;
    await api.storage.setItem('note', 'saved');
    const value = await api.storage.getItem('note');
    const keys = await api.storage.keys();
    const published = await api.relay.publish(template).then(() => 'unexpected success', (error: Error) => error.message);
    return { value, keys, published };
  }, template);
  expect(reply).toEqual({ value: 'saved', keys: ['note'], published: 'test-only declined' });
  const result = await state(page);
  expect(result.calls).toHaveLength(4);
  expect(result.calls[3].windowId).toBe('native-owned-test-session');
  expect(result.calls[3].message.event).toEqual(template);
  expect(result.calls[3].message).not.toHaveProperty('pubkey');
  expect(result.signerReads).toBe(0);
  expect(result.legacyRelayCalls).toBe(0);
  expect(result.deniedAdapters).toEqual([]);
  expect(result.audit.slice(-3)).toEqual(['acl:relay:write:allow', 'firewall:pass', 'operation:relay.publish']);
});

test('whole source window and subscribe optional relay field reach only the admitted override', async ({ page }) => {
  const frame = await open(page);
  const message = { type: 'relay.subscribe', id: 'sub-request', subId: 'same-sub', filters: [{ kinds: [1] }], relay: 'wss://example.invalid' };
  await frame.evaluate(message => parent.postMessage(message, '*'), message);
  await barrier(frame);
  expect((await state(page)).calls).toEqual([{ windowId: 'native-owned-test-session', message }]);
  expect(await received(frame)).toContainEqual({ type: 'relay.closed', subId: 'same-sub', reason: 'test-only closed' });
});

test('registered source cannot invoke native routes before actual readiness or in an undeclared domain', async ({ page }) => {
  const frame = await open(page, '?holdReady&noRelay');
  await frame.evaluate(template => parent.postMessage({ type: 'relay.publish', id: 'pre-ready', event: template }, '*'), template);
  await page.evaluate(() => { (window as any).lab.state.holdReady = false; });
  await frame.evaluate(() => parent.postMessage({ type: 'shell.ready' }, '*'));
  await expect(frame.locator('body')).toHaveAttribute('data-ready', 'true');
  await frame.evaluate(template => parent.postMessage({ type: 'relay.publish', id: 'unavailable', event: template }, '*'), template);
  await barrier(frame);
  expect((await state(page)).calls).toEqual([]);
  expect((await received(frame)).filter((message: any) => ['pre-ready', 'unavailable'].includes(message.id))).toEqual([]);
});

test('unregistered sibling, synthetic source and forged result cannot reach the override', async ({ page }) => {
  const frame = await open(page);
  await page.evaluate(() => {
    const sibling = document.createElement('iframe'); sibling.id = 'sibling'; sibling.sandbox.add('allow-scripts');
    sibling.srcdoc = '<script>parent.postMessage({type:"shell.ready"},"*");parent.postMessage({type:"storage.set",id:"sibling",key:"x",value:"y"},"*")</script>';
    document.body.append(sibling);
    window.dispatchEvent(new MessageEvent('message', { source: document.querySelector<HTMLIFrameElement>('#napplet')!.contentWindow,
      data: { type: 'storage.set', id: 'synthetic', key: 'x', value: 'y' } }));
  });
  await frame.evaluate(() => parent.postMessage({ type: 'storage.set.result', id: 'forged-result' }, '*'));
  await barrier(frame);
  expect((await state(page)).calls).toEqual([]);
});

test('ACL denial returns canonical results and never calls host operation or firewall', async ({ page }) => {
  const frame = await open(page);
  await page.evaluate(() => (window as any).lab.block());
  for (const [type, extra] of [
    ['storage.get', { key: 'x' }], ['storage.set', { key: 'x', value: 'y' }],
    ['storage.remove', { key: 'x' }], ['storage.keys', {}],
    ['relay.publish', { event: template }], ['relay.publishEncrypted', { event: template, recipient: 'x' }],
    ['relay.query', { filters: [] }], ['relay.subscribe', { subId: 'sub', filters: [] }], ['relay.close', { subId: 'close' }],
  ] as const) await frame.evaluate(message => parent.postMessage(message, '*'), { type, id: type, ...extra });
  await barrier(frame);
  const result = await state(page);
  expect(result.calls).toEqual([]);
  expect(result.audit.some((entry: string) => entry.startsWith('firewall:'))).toBe(false);
  expect(result.signerReads).toBe(0);
  const denied = (await received(frame)).filter((message: any) => message.type !== 'shell.init' && !String(message.id).startsWith('barrier-'));
  expect(denied).toHaveLength(9);
  for (const type of ['storage.get', 'storage.set', 'storage.remove', 'storage.keys']) {
    expect(denied).toContainEqual({ type: `${type}.result`, id: type, error: expect.stringMatching(/^denied:/) });
  }
  expect(denied).toContainEqual({ type: 'relay.publish.result', id: 'relay.publish', ok: false, error: 'denied: relay:write' });
  expect(denied).toContainEqual({ type: 'relay.publishEncrypted.result', id: 'relay.publishEncrypted', ok: false, error: expect.any(String) });
  expect(denied).toContainEqual({ type: 'relay.query.result', id: 'relay.query', events: [], error: 'denied: relay:read' });
  expect(denied).toContainEqual({ type: 'relay.closed', subId: 'sub', reason: 'denied: relay:read' });
  expect(denied).toContainEqual({ type: 'relay.closed', subId: 'close', reason: 'denied: relay:read' });
});

for (const policy of ['deny', 'ask'] as const) test(`firewall ${policy} retains canonical denial and does not call host override`, async ({ page }) => {
  const frame = await open(page);
  await page.evaluate(policy => (window as any).lab.firewall(policy), policy);
  const error = await frame.evaluate(async template => (window as any).napplet.relay.publish(template)
    .then(() => 'unexpected success', (error: Error) => error.message), template);
  expect(error).toMatch(/^firewall:/);
  const result = await state(page);
  expect(result.calls).toEqual([]);
  expect(result.signerReads).toBe(0);
  expect(result.audit).toEqual(['acl:relay:write:allow', `firewall:${policy === 'deny' ? 'reject' : 'prompt'}`]);
  expect((await received(frame)).find((message: any) => message.type === 'relay.publish.result'))
    .toMatchObject({ ok: false, error });
});

test('absent hook preserves old builtin route and does not alter existing service semantics', async ({ page }) => {
  const frame = await open(page, '?noHook');
  const value = await frame.evaluate(async template => (window as any).napplet.relay.publish(template)
    .then(() => 'unexpected success', (error: Error) => error.message), template);
  expect(value).toMatch(/signer/i);
  expect((await state(page)).calls).toEqual([]);
  expect((await state(page)).signerReads).toBe(1);
  expect((await state(page)).legacyRelayCalls).toBe(0);
});

for (const key of ['throw', 'reject']) test(`override ${key} becomes canonical failure without exposing exception or builtin fallback`, async ({ page }) => {
  const frame = await open(page);
  const error = await frame.evaluate(async key => (window as any).napplet.storage.getItem(key)
    .then(() => 'unexpected success', (error: Error) => error.message), key);
  expect(error).toBe('operation failed');
  expect((await state(page)).calls).toHaveLength(1);
  expect((await state(page)).signerReads).toBe(0);
});

for (const revoke of ['unregister', 'replaceEntry', 'destroy'] as const) test(`late callback is suppressed after ${revoke}`, async ({ page }) => {
  const frame = await open(page, '?defer');
  await frame.evaluate(() => parent.postMessage({ type: 'storage.get', id: 'late', key: 'x' }, '*'));
  await expect.poll(async () => (await state(page)).calls.length).toBe(1);
  await page.evaluate(revoke => { (window as any).lab[revoke](); (window as any).lab.release(); }, revoke);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect((await received(frame)).some((message: any) => message.id === 'late')).toBe(false);
});

test('publish remains pending after 30 seconds under explicit 660-second policy while reads retain 30 seconds', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
  const frame = await open(page, '?longTimeout&defer');
  await frame.evaluate(template => {
    const w = window as any; w.results = [];
    w.napplet.relay.publish(template).then(() => w.results.push('success'), (e: Error) => w.results.push(e.message));
    w.napplet.storage.getItem('read').catch((e: Error) => w.results.push(e.message));
  }, template);
  await expect.poll(async () => (await state(page)).calls.length).toBe(2);
  await page.clock.fastForward(31_000);
  expect(await frame.evaluate(() => (window as any).results)).toEqual(['storage.get timed out']);
  await page.evaluate(() => (window as any).lab.release());
  await expect.poll(() => frame.evaluate(() => (window as any).results)).toEqual(['storage.get timed out', 'test-only declined']);
  expect((await state(page)).signerReads).toBe(0);
});

for (const [query, deadline] of [['?defer', 30_000], ['?defer&longTimeout', 660_000]] as const) test(`publication deadline expires at ${deadline}ms`, async ({ page }) => {
    await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
    const frame = await open(page, query);
    await frame.evaluate(template => { const w = window as any; w.failure = null;
      w.napplet.relay.publish(template).catch((e: Error) => { w.failure = e.message; }); }, template);
    await expect.poll(async () => (await state(page)).calls.length).toBe(1);
    await page.clock.fastForward(deadline - 1);
    expect(await frame.evaluate(() => (window as any).failure)).toBeNull();
    await page.clock.fastForward(2);
    expect(await frame.evaluate(() => (window as any).failure)).toBe('relay.publish timed out');
});

test('host timeout map rejects invalid values and cannot inject executable text', async ({ page }) => {
  await open(page);
  expect(await page.evaluate(() => {
    const render = (window as any).lab.render;
    return [0, -1, 0.5, Infinity, 2147483648, NaN].map(value => {
      try { render({ domains: [], requestTimeoutsMs: { 'relay.publish': value } }); return 'accepted'; }
      catch (error) { return (error as Error).message; }
    });
  })).toEqual(Array(6).fill('Invalid host request timeout'));
  expect(await page.evaluate(() => {
    try { (window as any).lab.render({ domains: [], requestTimeoutsMs: { '</script>': 1 } }); return 'accepted'; }
    catch (error) { return (error as Error).message; }
  })).toBe('Invalid host request timeout');
});

test('secure correlation IDs use getRandomValues when randomUUID is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    if (window === window.top) return;
    Object.defineProperty(crypto, 'randomUUID', { value: undefined });
    Math.random = () => { throw new Error('Insecure random forbidden'); };
  });
  const frame = await open(page);
  expect(await frame.evaluate(() => (window as any).napplet.storage.getItem('secure-id'))).toBeNull();
  expect((await state(page)).calls[0].message.id).toMatch(/^napplet-[a-f0-9]{32}$/);
});


test('Outbox original query reaches the override after ACL and firewall; ACL denial keeps required empty events', async ({page}) => {
  const frame = await open(page, '?outbox');
  expect(await frame.evaluate(async () => (window as any).napplet.outbox.query({kinds:[1],limit:0}))).toMatchObject({events:[],type:'outbox.query.result',id:expect.any(String)});
  let result = await state(page);
  expect(result.calls).toHaveLength(1);
  expect(result.calls[0].message).toMatchObject({type:'outbox.query',filters:[{kinds:[1],limit:0}]});
  expect(result.audit.slice(-3)).toEqual(['acl:outbox:read:allow','firewall:pass','operation:outbox.query']);
  await page.evaluate(() => (window as any).lab.block());
  const denied = await frame.evaluate(async () => (window as any).napplet.outbox.query({kinds:[1],limit:0}));
  expect(denied).toMatchObject({events:[],error:'denied: outbox:read'});
  result = await state(page);expect(result.calls).toHaveLength(1);expect(result.signerReads).toBe(0);
});

for (const policy of ['deny','ask'] as const) test(`Outbox firewall ${policy} returns canonical empty events without invoking native`, async ({page}) => {
  const frame = await open(page, '?outbox');
  await page.evaluate(policy => (window as any).lab.firewall(policy), policy);
  const result = await frame.evaluate(async () => (window as any).napplet.outbox.query({kinds:[1],limit:0}));
  expect(result).toMatchObject({events:[],error:expect.stringMatching(/^firewall:/)});
  expect((await state(page)).calls).toEqual([]);
});

for(const operation of ['getEvent','resolveRelays'] as const)test(`Outbox ${operation} override respects ACL and firewall without builtin routing`,async({page})=> {
  const frame=await open(page,'?outbox');
  const read=()=>frame.evaluate(async operation=>operation==='getEvent'?(window as any).napplet.outbox.getEvent('a'.repeat(64)):(window as any).napplet.outbox.resolveRelays({pubkey:'b'.repeat(64)}),operation);
  await read();expect((await state(page)).calls[0].message.type).toBe('outbox.'+operation);
  await page.evaluate(()=>(window as any).lab.firewall('deny'));
  const denied=await read();expect(denied).toMatchObject({error:expect.stringMatching(/^firewall:/)});expect((await state(page)).calls).toHaveLength(1);
});

for(const policy of ['acl','deny','ask'] as const)test(`Outbox publication ${policy} denial stays canonical and calls no native operation or signer`,async({page})=> {
 const frame=await open(page,'?outbox');
 if(policy==='acl')await page.evaluate(()=>(window as any).lab.block());else await page.evaluate(policy=>(window as any).lab.firewall(policy),policy);
 const reply=await frame.evaluate(async template=>(window as any).napplet.outbox.publish(template),template);
 const error=reply.error;expect(reply.ok).toBe(false);
 expect(error).toMatch(policy==='acl'?/^denied: outbox:write/:/^firewall:/);
 expect((await received(frame)).find((value:any)=>value.type==='outbox.publish.result')).toMatchObject({ok:false,error});
 const result=await state(page);expect(result.calls).toEqual([]);expect(result.signerReads).toBe(0);
});
