import { test, expect, type Page, type Frame } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Browser-only diagnostic sink. It is installed on the top document only and
// does not claim to emulate Android's origin-scoped WebMessageListener security.
async function instrument(page: Page, holdReady = false) {
  await page.addInitScript(({ holdReady }) => {
    const state = window as any;
    state.__received = [];
    window.addEventListener('message', event => {
      state.__received.push(event.data);
      if (window === window.top && state.__holdReady && event.data?.type === 'shell.ready' && Object.keys(event.data).length === 1) {
        event.stopImmediatePropagation();
      }
    });
    if (window !== window.top) return;
    state.__holdReady = holdReady;
    state.__diagnostics = [];
    Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Storage disabled', 'SecurityError'); } });
    Object.defineProperty(window, 'sessionStorage', { get() { throw new DOMException('Storage disabled', 'SecurityError'); } });
    Object.defineProperty(window, 'HypergolicHost', { value: {
      postMessage: (value: string) => state.__diagnostics.push(JSON.parse(value)),
    } });
  }, { holdReady });
}
const diagnostics = (page: Page) => page.evaluate(() => (window as any).__diagnostics);
async function open(page: Page, sessionId = 'test-session', holdReady = false): Promise<Frame> {
  await instrument(page, holdReady);
  await page.goto(`/assets/runtime/index.html?sessionId=${sessionId}`);
  await expect(page.locator('#napplet')).toHaveCount(1);
  const frame = await page.locator('#napplet').contentFrame();
  await expect(frame.getByTestId('lab')).toHaveAttribute('data-ready', 'true');
  if (!holdReady) {
    await expect.poll(() => diagnostics(page)).toEqual([{ type: 'ready', sessionId }]);
    await expect(frame.getByTestId('theme-status')).toHaveText('Host colors');
  }
  const actual = page.frames().find(f => f.parentFrame() === page.mainFrame());
  if (!actual) throw new Error('Missing napplet frame');
  return actual;
}
const messages = (frame: Frame) => frame.evaluate(() => (window as any).__received);

// This reads the built delivery artifact, independently of the host's build implementation.
test('delivery has two assets and the original fixture bytes plus original unsigned manifest', async () => {
  expect(readdirSync('dist').sort()).toEqual(['host.js', 'index.html']);
  const lock = JSON.parse(readFileSync('fixtures/lock.json', 'utf8'));
  const manifest = JSON.parse(readFileSync('fixtures/ux-lab-manifest.json', 'utf8'));
  const hash = createHash('sha256').update(readFileSync('fixtures/ux-lab.html')).digest('hex');
  expect(hash).toBe('01ab63dbcdadab0b44fd6f3b9a6bcfbd98d8c1de1510f96c821d3efe1876909c');
  expect(hash).toBe(lock.sha256);
  expect(manifest.tags).toContainEqual(['path', '/index.html', hash]);
  expect(manifest).not.toHaveProperty('sig');
  expect(manifest).not.toHaveProperty('pubkey');
  const index = JSON.parse(readFileSync('assets-manifest.json', 'utf8'));
  for (const [name, record] of Object.entries(index.assets) as [string, any][]) {
    const bytes = readFileSync('dist/' + name);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(record.sha256);
    expect(bytes.byteLength).toBe(record.bytes);
  }
});

for (const [fixture, expectedSha, expectedAggregate] of [
  ['approval-lab', '0c1269933e49a9f3e0f797813b8f80d276e3fabf171466fffc0fbe38901b15e2', '047fde2775327d45b3172b42990d4278af6b56080d2e8af544b7d8cdf5cbc99d'],
  ['approval-lab-v3', '6e738a11409843d019523bf121ebe24ffe25a175ca0a742cfc22d49c4a887f24', '1ca3093bc473cca8487f87b6d44174d1634159b9a41d9d7ef26a07ce686416e7'],
  ['approval-lab-v2', '8e091402081521f5e2df4f9ebcfa6dfea84366c4035c7ccdd35bf60725471dcc', 'a59c8c811dace66c3285ef98f30b52c5f57d2fa5d92715b0f3a2e93b201630ac'],
  ['approval-lab-v1', '95c8360ae963c91f5c9a09e9f88eec06db46a810538394d6dc12ca587befaae1', 'a3c2ec6e0cd8068d942866f80f622f21df53cc188f000bc2af6caf34126e6889'],
]) test(`Approval Lab ${fixture} is byte-pinned and remains an unsigned catalog artifact`, async () => {
  const bytes = readFileSync(`fixtures/${fixture}.html`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const manifest = JSON.parse(readFileSync(`fixtures/${fixture}-manifest.json`, 'utf8'));
  const aggregateHash = createHash('sha256').update(`${sha256} /index.html\n`).digest('hex');
  expect(sha256).toBe(expectedSha);
  expect(aggregateHash).toBe(expectedAggregate);
  expect(manifest.tags).toContainEqual(['path', '/index.html', sha256]);
  expect(manifest.tags).toContainEqual(['x', aggregateHash, 'aggregate']);
  expect(manifest.tags).toContainEqual(['requires', 'identity']);
  expect(manifest.tags).toContainEqual(['requires', 'relay']);
  expect(manifest).not.toHaveProperty('pubkey');
  expect(manifest).not.toHaveProperty('sig');
});

test('saved Feed Lab artifact keeps its exact bytes and authority', async () => {
  const bytes = readFileSync('fixtures/feed-lab-v1.html');
  const manifest = JSON.parse(readFileSync('fixtures/feed-lab-v1-manifest.json', 'utf8'));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe('2cb048da03eb3f9d9759a04961960ca2bc469386e8edddc58df4f54cdc8b92d0');
  expect(manifest.aggregateHash).toBe('eec5f146e50415c9c07db0298682a75d4e4c94e7e3ef7e18a3f37a87e1825642');
  expect(manifest.tags.filter((tag: string[]) => tag[0] === 'requires')).toEqual([
    ['requires', 'identity'], ['requires', 'outbox'], ['requires', 'relay'],
  ]);
});

test('top host derives v4 UUIDs from secure bytes when WebView lacks crypto.randomUUID', async ({ page }) => {
  await page.addInitScript(() => {
    if (window !== window.top) return;
    const original = crypto.getRandomValues.bind(crypto);
    let calls = 0;
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
    Object.defineProperty(crypto, 'getRandomValues', { configurable: true, value: (bytes: Uint8Array) => {
      calls++;
      return original(bytes);
    } });
    (window as any).__secureUuidCalls = () => calls;
  });
  await open(page, 'legacy-uuid');
  const result = await page.evaluate(() => ({ uuid: crypto.randomUUID(), calls: (window as any).__secureUuidCalls() }));
  expect(result.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(result.calls).toBeGreaterThan(0);
});

test('bundled guest starts when an older WebView lacks Object.hasOwn', async ({ page }) => {
  await page.addInitScript(() => {
    if (window === window.top) Object.defineProperty(Object, 'hasOwn', { configurable: true, value: undefined });
  });
  const frame = await open(page, 'legacy-webview');
  await expect(frame.getByTestId('theme-status')).toHaveText('Host colors');
});

test('real Kehto handshake and theme work with top-document DOM storage disabled', async ({ page }) => {
  const frame = await open(page);
  const result = await frame.evaluate(async () => {
    const shell = (window as any).napplet.shell;
    const environment = await shell.ready();
    let calls = 0;
    shell.onReady(() => { calls++; });
    return { environment, services: shell.services, theme: shell.supports('theme'),
      relay: shell.supports('relay'), upload: shell.supports('upload'), unknown: shell.supports('made-up'), calls,
      domains: Object.keys((window as any).napplet) };
  });
  expect(result).toEqual({ environment: { capabilities: { domains: ['theme'] }, services: ['theme', 'hypergolic.close-check.v1'] },
    services: ['theme', 'hypergolic.close-check.v1'], theme: true, relay: false, upload: false, unknown: false, calls: 1, domains: ['shell', 'theme'] });
  expect((await messages(frame)).filter((m: any) => m.type === 'shell.init')).toHaveLength(1);
  await frame.evaluate(() => {
    parent.postMessage({ type: 'shell.ready' }, '*');
    parent.postMessage({ type: 'shell.ready' }, '*');
    parent.postMessage({ type: 'theme.get', id: 'barrier' }, '*');
  });
  await expect.poll(async () => (await messages(frame)).some((m: any) => m.id === 'barrier')).toBe(true);
  expect((await messages(frame)).filter((m: any) => m.type === 'shell.init')).toHaveLength(1);
  expect(await diagnostics(page)).toEqual([{ type: 'ready', sessionId: 'test-session' }]);
});

test('pre-ready traffic cannot establish a session and forged readiness carries no authority', async ({ page }) => {
  const frame = await open(page, 'held-session', true);
  await frame.evaluate(() => {
    parent.postMessage({ type: 'theme.get', id: 'before-ready' }, '*');
    parent.postMessage({ type: 'shell.ready', dTag: 'forged', capabilities: ['relay'] }, '*');
  });
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 150)));
  expect(await diagnostics(page)).toEqual([]);
  expect((await messages(frame)).filter((m: any) => m.type === 'shell.init' || m.id === 'before-ready')).toEqual([]);
  await page.evaluate(() => { (window as any).__holdReady = false; });
  await frame.evaluate(() => parent.postMessage({ type: 'shell.ready' }, '*'));
  await expect.poll(() => diagnostics(page)).toEqual([{ type: 'ready', sessionId: 'held-session' }]);
  expect(await frame.evaluate(() => (window as any).napplet.shell.supports('relay'))).toBe(false);
});

test('malformed and privileged envelopes are ignored while valid requests still work', async ({ page }) => {
  const frame = await open(page);
  await frame.evaluate(() => {
    for (const message of [null, [], 'shell.ready', { type: 'theme.get' },
      { type: 'theme.get', id: 'x'.repeat(129) }, { type: 'theme.get', id: 'extra', token: 'forged' },
      { type: 'relay.publish', id: 'sign', event: { kind: 1, content: 'deny' } },
      { type: 'storage.set', id: 'write', key: 'x', value: 'y' },
      { type: 'upload.info', id: 'upload-info' },
      { type: 'upload.upload', id: 'upload-forged', request: {data: new Blob(['blocked'])} },
      { type: 'shell.supports', id: 'probe' }]) parent.postMessage(message, '*');
    parent.postMessage({ type: 'theme.get', id: 'valid-after-denials' }, '*');
  });
  await expect.poll(async () => (await messages(frame)).some((m: any) => m.id === 'valid-after-denials')).toBe(true);
  expect((await messages(frame)).filter((m: any) => ['extra', 'sign', 'write', 'probe', 'upload-info', 'upload-forged'].includes(m.id))).toEqual([]);
  expect(await diagnostics(page)).toHaveLength(1);
});

test('unregistered sibling and forged synthetic source cannot obtain capabilities', async ({ page }) => {
  const frame = await open(page);
  await page.evaluate(() => {
    const sibling = document.createElement('iframe');
    sibling.id = 'intruder'; sibling.sandbox.add('allow-scripts');
    sibling.srcdoc = '<script>window.results=[];addEventListener("message",e=>results.push(e.data));parent.postMessage({type:"shell.ready"},"*");parent.postMessage({type:"theme.get",id:"sibling"},"*");</script>';
    document.body.append(sibling);
    const source = document.querySelector<HTMLIFrameElement>('#napplet')!.contentWindow;
    window.dispatchEvent(new MessageEvent('message', { source, data: { type: 'theme.get', id: 'synthetic' } }));
  });
  await frame.evaluate(() => parent.postMessage({ type: 'theme.get', id: 'after-sibling' }, '*'));
  await expect.poll(async () => (await messages(frame)).some((m: any) => m.id === 'after-sibling')).toBe(true);
  const intruder = page.frames().find(f => f.parentFrame() === page.mainFrame() && f !== frame)!;
  expect(await intruder.evaluate(() => (window as any).results)).toEqual([]);
  expect((await messages(frame)).some((m: any) => m.id === 'synthetic')).toBe(false);
});

test('opaque frame has no native bridge, parent DOM or browser storage access', async ({ page }) => {
  const frame = await open(page);
  const result = await frame.evaluate(() => {
    const available: Record<string, boolean> = {};
    for (const [name, access] of Object.entries({
      parent: () => parent.document.body,
      parentBridge: () => (parent as any).HypergolicHost,
      localStorage: () => localStorage.getItem('x'),
      sessionStorage: () => sessionStorage.getItem('x'),
      indexedDB: () => indexedDB.open('x'),
    })) { try { access(); available[name] = true; } catch { available[name] = false; } }
    return { available, ownBridge: typeof (window as any).HypergolicHost,
      legacyBridge: typeof (window as any).ReactNativeWebView, nostr: typeof (window as any).nostr };
  });
  expect(result).toEqual({ available: { parent: false, parentBridge: false, localStorage: false, sessionStorage: false, indexedDB: false },
    ownBridge: 'undefined', legacyBridge: 'undefined', nostr: 'undefined' });
  expect(await page.locator('#napplet').getAttribute('sandbox')).toBe('allow-scripts');
});

test('CSP blocks direct fetch, socket, worker, image, script and top navigation', async ({ page }) => {
  const frame = await open(page);
  const external: string[] = [];
  await page.route('https://example.invalid/**', route => { external.push(route.request().url()); return route.abort(); });
  await page.routeWebSocket('wss://example.invalid/**', socket => { external.push(socket.url()); socket.close(); });
  const result = await frame.evaluate(async () => {
    const denied: Record<string, boolean> = {};
    const violations: string[] = [];
    addEventListener('securitypolicyviolation', event => violations.push(event.effectiveDirective));
    try { await fetch('https://example.invalid/leak'); denied.fetch = false; } catch { denied.fetch = true; }
    denied.socket = await new Promise<boolean>(resolve => {
      try { const socket = new WebSocket('wss://example.invalid/socket'); socket.onopen = () => { socket.close(); resolve(false); }; socket.onerror = () => resolve(true); } catch { resolve(true); }
    });
    const blob = URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' }));
    denied.worker = await new Promise<boolean>(resolve => {
      try { const worker = new Worker(blob); worker.onmessage = () => { worker.terminate(); resolve(false); }; worker.onerror = event => { event.preventDefault(); worker.terminate(); resolve(true); }; } catch { resolve(true); }
    });
    URL.revokeObjectURL(blob);
    denied.image = await new Promise<boolean>(resolve => { const image = new Image(); image.onload = () => resolve(false); image.onerror = () => resolve(true); image.src = 'https://example.invalid/image'; });
    denied.script = await new Promise<boolean>(resolve => { const script = document.createElement('script'); script.onload = () => resolve(false); script.onerror = () => resolve(true); script.src = 'https://example.invalid/script.js'; document.head.append(script); });
    try { top!.location.href = 'https://example.invalid/top'; denied.top = false; } catch { denied.top = true; }
    return { denied, violations };
  });
  expect(result.denied).toEqual({ fetch: true, socket: true, worker: true, image: true, script: true, top: true });
  expect(result.violations).toEqual(expect.arrayContaining(['connect-src', 'worker-src', 'img-src']));
  expect(external).toEqual([]);
  expect(page.url()).toContain('/assets/runtime/index.html?sessionId=test-session');
});

test('hide and restore preserves live counter, draft and both scroll axes; reload starts fresh', async ({ page, context }) => {
  const frame = await open(page, 'first');
  await frame.getByTestId('increment').click();
  await frame.getByTestId('draft').fill('Keep this instance');
  await frame.getByTestId('marker-7').click();
  await frame.getByTestId('edge-right-4').click();
  const before = await frame.evaluate(() => ({ y: scrollY, x: document.getElementById('rail')!.scrollLeft }));
  const other = await context.newPage();
  const second = await open(other, 'second');
  await second.getByTestId('draft').fill('Independent second instance');
  await page.locator('#napplet').evaluate(element => { (element as HTMLElement).hidden = true; });
  await page.locator('#napplet').evaluate(element => { (element as HTMLElement).hidden = false; });
  expect(await frame.evaluate(() => ({ y: scrollY, x: document.getElementById('rail')!.scrollLeft }))).toEqual(before);
  await expect(frame.getByTestId('draft')).toHaveValue('Keep this instance');
  await expect(frame.getByTestId('counter')).toHaveText('1');
  await expect(second.getByTestId('draft')).toHaveValue('Independent second instance');
  await page.reload();
  await expect(page.frameLocator('#napplet').getByTestId('counter')).toHaveText('0');
  await expect(page.frameLocator('#napplet').getByTestId('draft')).toHaveValue('');
  await other.close();
});

test('invalid session and missing native adapter fail closed before iframe creation', async ({ page, context }) => {
  await instrument(page);
  await page.goto('/assets/runtime/index.html?sessionId=bad%3Cscript%3E');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(0);
  expect(await diagnostics(page)).toEqual([{ type: 'error', sessionId: 'bad<script>', code: 'invalid-session' }]);
  const missing = await context.newPage();
  await missing.goto('/assets/runtime/index.html?sessionId=no-adapter');
  await expect(missing.getByRole('alert')).toBeVisible();
  await expect(missing.locator('iframe')).toHaveCount(0);
  await missing.close();
});

test('runtime digest mismatch fails before fixture code runs', async ({ page }) => {
  await instrument(page);
  const script = readFileSync('dist/host.js', 'utf8').replaceAll('01ab63dbcdadab0b44fd6f3b9a6bcfbd98d8c1de1510f96c821d3efe1876909c', '0'.repeat(64));
  await page.route('**/host.js', route => route.fulfill({ body: script, contentType: 'text/javascript' }));
  await page.goto('/assets/runtime/index.html?sessionId=modified');
  await expect.poll(() => diagnostics(page)).toEqual([{ type: 'error', sessionId: 'modified', code: 'fixture-integrity' }]);
  await expect(page.locator('iframe')).toHaveCount(0);
});


test('document navigation ends the generation and removes the bound napplet', async ({ page }) => {
  const frame = await open(page, 'navigated');
  await frame.evaluate(() => { location.href = 'about:blank'; });
  await expect.poll(() => diagnostics(page)).toEqual([
    { type: 'ready', sessionId: 'navigated' },
    { type: 'error', sessionId: 'navigated', code: 'frame-navigation' },
  ]);
  await expect(page.locator('#napplet')).toHaveCount(0);
  await expect(page.getByRole('alert')).toBeVisible();
});


test('Kehto request IDs use secure random bytes when randomUUID is unavailable', async ({ page }) => {
  const frame = await open(page, 'secure-fallback');
  const result = await frame.evaluate(async () => {
    const lengths: number[] = [];
    const original = crypto.getRandomValues.bind(crypto);
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
    Object.defineProperty(crypto, 'getRandomValues', { configurable: true, value: (array: Uint8Array) => {
      lengths.push(array.byteLength);
      return original(array);
    } });
    Math.random = () => { throw new Error('Weak randomness must not be used'); };
    const theme = await (window as any).napplet.theme.get();
    return { theme, lengths };
  });
  expect(result.lengths).toEqual([16]);
  expect(['#F5A04B', '#AA4708']).toContain(result.theme.colors.primary);
  const requests = await page.evaluate(() => (window as any).__received.filter((value: any) => value?.type === 'theme.get'));
  expect(requests.at(-1).id).toMatch(/^napplet-[0-9a-f]{32}$/);
});

test('Kehto refuses to emit a request when secure randomness is unavailable', async ({ page }) => {
  const frame = await open(page, 'no-secure-randomness');
  const count = () => page.evaluate(() => (window as any).__received.filter((value: any) => value?.type === 'theme.get').length);
  const before = await count();
  const result = await frame.evaluate(async () => {
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
    Object.defineProperty(crypto, 'getRandomValues', { value: undefined, configurable: true });
    Math.random = () => { throw new Error('Weak randomness must not be used'); };
    try { await (window as any).napplet.theme.get(); return 'unexpected success'; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  });
  expect(result).toBe('Secure randomness unavailable');
  expect(await count()).toBe(before);
});


test('host theme follows system appearance and pushes the complete current palette', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  const frame = await open(page, 'shell-appearance');
  const read = () => frame.evaluate(() => (window as any).napplet.theme.get());
  expect((await read()).colors).toEqual({ background: '#080F17', text: '#EEF3F7', primary: '#F5A04B' });
  await frame.evaluate(() => {
    (window as any).__themeChanges = [];
    (window as any).napplet.theme.onChanged((theme: unknown) => (window as any).__themeChanges.push(theme));
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => frame.evaluate(() => (window as any).__themeChanges.at(-1)?.colors)).toEqual({
    background: '#FFFFFF', text: '#17202A', primary: '#AA4708',
  });
  expect((await read()).colors).toEqual({ background: '#FFFFFF', text: '#17202A', primary: '#AA4708' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => frame.evaluate(() => (window as any).__themeChanges.at(-1)?.colors.background)).toBe('#080F17');
});
