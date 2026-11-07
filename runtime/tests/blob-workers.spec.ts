import {test, expect, type Page, type Frame} from '@playwright/test';
import {createServer} from 'node:http';

async function open(page: Page) {
  const egress: string[] = [];
  await page.context().route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith('blob:') || ['http://127.0.0.1:4187/assets/runtime/index.html',
      'http://127.0.0.1:4187/assets/runtime/host.js'].some(asset => url.startsWith(asset))) return route.continue();
    egress.push(url); return route.abort();
  });
  await page.context().routeWebSocket('wss://blocked.invalid/**', socket => {egress.push(socket.url()); socket.close();});
  await page.addInitScript(() => {
    if (window !== top) return;
    const diagnostics: unknown[] = [];
    Object.defineProperty(window, 'HypergolicHost', {value: {postMessage: (raw: string) => diagnostics.push(JSON.parse(raw))}});
    Object.defineProperty(window, 'workerDiagnostics', {value: diagnostics});
  });
  await page.goto('/assets/runtime/index.html?sessionId=local-workers');
  await expect(page.frameLocator('#napplet').getByTestId('lab')).toHaveAttribute('data-ready', 'true');
  const frame = page.frames().find(candidate => candidate.parentFrame() === page.mainFrame())!;
  expect(await page.locator('#napplet').getAttribute('sandbox')).toBe('allow-scripts');
  return {frame, egress};
}

test('local classic blob workers compute without a native or NAP endpoint', async ({page, browserName}) => {
  const {frame, egress} = await open(page);
  const result = await frame.evaluate(async () => {
    const results = [];
    for (const type of ['classic'] as const) {
      const url = URL.createObjectURL(new Blob([`onmessage = async ({data}) => {const result = {sum: data[0] + data[1],
        origin: location.origin, window: typeof window, document: typeof document, parent: typeof parent,
        native: typeof HypergolicHost, napplet: typeof napplet, webkit: typeof webkit};
      try {result.indexedDb = await new Promise(resolve => {
        const request = indexedDB.open('worker-isolation-probe');
        request.onerror = event => {event.preventDefault(); resolve('blocked');};
        request.onsuccess = () => {request.result.close(); resolve('opened');};
      });} catch {result.indexedDb = 'blocked';}
      try {await caches.open('worker-isolation-probe'); result.caches = 'opened';} catch {result.caches = 'blocked';}
postMessage(result);};`], {type: 'text/javascript'}));
      const worker = new Worker(url, {type});
      try {
        results.push(await new Promise(resolve => {worker.onmessage = event => resolve(event.data); worker.onerror = event => resolve({error: event.message}); worker.postMessage([7, 8]);}));
      } finally {worker.terminate(); URL.revokeObjectURL(url);}
    }
    return results;
  });
  expect(result).toEqual(Array.from({length: 1}, () => ({sum: 15, origin: 'null', window: 'undefined',
    document: 'undefined', parent: 'undefined', native: 'undefined', napplet: 'undefined', webkit: 'undefined', indexedDb: 'blocked', caches: browserName === 'webkit' ? 'opened' : 'blocked'})));
  expect(egress).toEqual([]);
  expect(await page.evaluate(() => (window as any).workerDiagnostics)).toEqual([{type: 'ready', sessionId: 'local-workers'}]);
});

test('blob workers inherit network and imported-script denial', async ({page}) => {
  const {frame, egress} = await open(page);
  const result = await frame.evaluate(async () => {
    const url = URL.createObjectURL(new Blob([`(async () => {
      const result = {};
      try {await fetch('https://blocked.invalid/worker'); result.fetch = 'sent';} catch {result.fetch = 'blocked';}
      try {importScripts('https://blocked.invalid/script.js'); result.script = 'loaded';} catch {result.script = 'blocked';}
      try {const socket = new WebSocket('wss://blocked.invalid/socket'); result.socket = await new Promise(resolve => {
        socket.onopen = () => resolve('sent'); socket.onerror = () => resolve('blocked');
      });} catch {result.socket = 'blocked';}
      postMessage(result);
    })();`], {type: 'text/javascript'}));
    const worker = new Worker(url);
    try {return await new Promise(resolve => {worker.onmessage = event => resolve(event.data);});}
    finally {worker.terminate(); URL.revokeObjectURL(url);}
  });
  expect(result).toEqual({fetch: 'blocked', script: 'blocked', socket: 'blocked'});
  expect(egress).toEqual([]);
});

test('data and remote worker scripts stay denied', async ({page}) => {
  const {frame, egress} = await open(page);
  const result = await frame.evaluate(async () => {
    const outcomes = [];
    for (const url of ['data:text/javascript,postMessage(1)', 'https://blocked.invalid/worker.js']) {
      outcomes.push(await new Promise(resolve => {
        try {const worker = new Worker(url, {type: 'module'});
          worker.onmessage = () => {worker.terminate(); resolve('ran');};
          worker.onerror = event => {event.preventDefault(); worker.terminate(); resolve('blocked');};
        } catch {resolve('blocked');}
      }));
    }
    return outcomes;
  });
  expect(result).toEqual(['blocked', 'blocked']);
  expect(egress).toEqual([]);
});


test('opaque frames cannot execute another frame or prior document blob', async ({page, browserName}) => {
  const {frame, egress} = await open(page);
  const firstUrl = await frame.evaluate(() => URL.createObjectURL(new Blob(['postMessage("ran")'], {type: 'text/javascript'})));
  await page.evaluate(() => {
    const other = document.createElement('iframe'); other.id = 'other';
    other.sandbox.add('allow-scripts'); other.srcdoc = '<html><body id="first-generation"></body></html>';
    document.body.append(other);
  });
  await expect(page.frameLocator('#other').locator('#first-generation')).toBeAttached();
  const other = page.frames().find(candidate => candidate !== frame && candidate.parentFrame() === page.mainFrame())!;
  const attempt = (url: string) => other.evaluate(url => new Promise(resolve => {
    try {const worker = new Worker(url); worker.onmessage = () => {worker.terminate(); resolve('ran');};
      worker.onerror = event => {event.preventDefault(); worker.terminate(); resolve('blocked');};
    } catch {resolve('blocked');}
  }), url);
  expect(await attempt(firstUrl)).toBe('blocked');
  const oldUrl = await other.evaluate(() => URL.createObjectURL(new Blob(['postMessage("ran")'], {type: 'text/javascript'})));
  expect(await attempt(oldUrl)).toBe('ran');
  await page.evaluate(() => {document.querySelector<HTMLIFrameElement>('#other')!.srcdoc = '<html><body id="second-generation"></body></html>';});
  await expect(page.frameLocator('#other').locator('#second-generation')).toBeAttached();
  expect(await attempt(oldUrl)).toBe('blocked');
  const freshUrl = await other.evaluate(() => URL.createObjectURL(new Blob(['postMessage("ran")'], {type: 'text/javascript'})));
  expect(await attempt(freshUrl)).toBe('ran');
  if (browserName === 'webkit') {
    const sharedCode = 'onconnect=e=>{e.ports[0].postMessage("ran");e.ports[0].close()}';
    const firstShared = await frame.evaluate(code => URL.createObjectURL(new Blob([code], {type: 'text/javascript'})), sharedCode);
    const attemptShared = (url: string) => other.evaluate(url => new Promise(resolve => {
      try {const worker = new SharedWorker(url);
        worker.port.onmessage = () => {worker.port.close(); resolve('ran');}; worker.port.start();
        worker.onerror = event => {event.preventDefault(); worker.port.close(); resolve('blocked');};
      } catch {resolve('blocked');}
    }), url);
    expect(await attemptShared(firstShared)).toBe('blocked');
    const oldShared = await other.evaluate(code => URL.createObjectURL(new Blob([code], {type: 'text/javascript'})), sharedCode);
    expect(await attemptShared(oldShared)).toBe('ran');
    await page.evaluate(() => {document.querySelector<HTMLIFrameElement>('#other')!.srcdoc = '<html><body id="third-generation"></body></html>';});
    await expect(page.frameLocator('#other').locator('#third-generation')).toBeAttached();
    expect(await attemptShared(oldShared)).toBe('blocked');
    await frame.evaluate(url => URL.revokeObjectURL(url), firstShared);
  }
  await other.evaluate(url => URL.revokeObjectURL(url), freshUrl);
  await frame.evaluate(url => URL.revokeObjectURL(url), firstUrl);
  expect(egress).toEqual([]);
});


test('WebKit local SharedWorker also inherits denial without an endpoint', async ({page, browserName}) => {
  const {frame, egress} = await open(page);
  const result = await frame.evaluate(async () => {
    const url = URL.createObjectURL(new Blob([`onconnect = async ({ports: [port]}) => {
      const result = {origin: location.origin, native: typeof HypergolicHost, napplet: typeof napplet,
        webkit: typeof webkit, window: typeof window, document: typeof document};
      try {await fetch('https://blocked.invalid/shared'); result.fetch = 'sent';} catch {result.fetch = 'blocked';}
      try {importScripts('https://blocked.invalid/shared.js'); result.script = 'loaded';} catch {result.script = 'blocked';}

      try {result.indexedDb = await new Promise(resolve => {
        const request = indexedDB.open('worker-isolation-probe');
        request.onerror = event => {event.preventDefault(); resolve('blocked');};
        request.onsuccess = () => {request.result.close(); resolve('opened');};
      });} catch {result.indexedDb = 'blocked';}
      try {await caches.open('worker-isolation-probe'); result.caches = 'opened';} catch {result.caches = 'blocked';}
      try {const socket = new WebSocket('wss://blocked.invalid/shared'); result.socket = await new Promise(resolve => {
        socket.onopen = () => resolve('sent'); socket.onerror = () => resolve('blocked');
      });} catch {result.socket = 'blocked';}
      port.postMessage(result); port.close();
    };`], {type: 'text/javascript'}));
    let worker: SharedWorker;
    try {worker = new SharedWorker(url);} catch (error) {URL.revokeObjectURL(url); return {denied: (error as Error).name};}
    try {return await new Promise(resolve => {worker.port.onmessage = event => resolve(event.data); worker.port.start();});}
    finally {worker.port.close(); URL.revokeObjectURL(url);}
  });
  expect(result).toEqual(browserName === 'chromium' ? {denied: 'SecurityError'} : {
    origin: 'null', native: 'undefined', napplet: 'undefined', webkit: 'undefined', window: 'undefined',
    document: 'undefined', fetch: 'blocked', script: 'blocked', indexedDb: 'blocked', caches: 'opened', socket: 'blocked',
  });
  expect(egress).toEqual([]);
});


test('another opaque frame or generation cannot attach to a live named SharedWorker', async ({page, browserName}) => {
  const {frame, egress} = await open(page);
  const owner = await frame.evaluate(async () => {
    const url = URL.createObjectURL(new Blob(['onconnect=e=>{const p=e.ports[0];p.onmessage=e=>p.postMessage(e.data);p.start()}'], {type: 'text/javascript'}));
    try {
      const worker = new SharedWorker(url, {name: 'live-opaque-owner'});
      (window as any).liveShared = {worker, url};
      const echo = await new Promise(resolve => {worker.port.onmessage = event => resolve(event.data); worker.port.start(); worker.port.postMessage('owner-control');});
      return {url, echo};
    } catch (error) {URL.revokeObjectURL(url); return {denied: (error as Error).name};}
  });
  if (browserName === 'chromium') {expect(owner).toEqual({denied: 'SecurityError'}); return;}
  expect(owner.echo).toBe('owner-control');
  await page.evaluate(() => {
    const other = document.createElement('iframe'); other.id = 'shared-other'; other.sandbox.add('allow-scripts');
    other.srcdoc = '<html><body id="generation-one"></body></html>'; document.body.append(other);
  });
  await expect(page.frameLocator('#shared-other').locator('#generation-one')).toBeAttached();
  const other = page.frames().find(candidate => candidate !== frame && candidate.parentFrame() === page.mainFrame())!;
  const attach = () => other.evaluate(url => new Promise(resolve => {
    try {
      const worker = new SharedWorker(url!, {name: 'live-opaque-owner'});
      worker.port.onmessage = () => {worker.port.close(); resolve('attached');}; worker.port.start();
      worker.onerror = event => {event.preventDefault(); worker.port.close(); resolve('blocked');};
      worker.port.postMessage('foreign-control');
    } catch {resolve('blocked');}
  }), owner.url);
  expect(await attach()).toBe('blocked');
  await page.evaluate(() => {document.querySelector<HTMLIFrameElement>('#shared-other')!.srcdoc = '<html><body id="generation-two"></body></html>';});
  await expect(page.frameLocator('#shared-other').locator('#generation-two')).toBeAttached();
  expect(await attach()).toBe('blocked');
  expect(await frame.evaluate(() => new Promise(resolve => {
    const {worker} = (window as any).liveShared;
    worker.port.onmessage = (event: MessageEvent) => resolve(event.data); worker.port.postMessage('still-owner');
  }))).toBe('still-owner');
  await frame.evaluate(() => {const {worker, url} = (window as any).liveShared; worker.port.close(); URL.revokeObjectURL(url);});
  expect(egress).toEqual([]);
});


async function cacheProbe(frame: Frame, write: boolean) {
  return frame.evaluate(async write => {
    const url = URL.createObjectURL(new Blob([`onmessage = async ({data: write}) => {
      const result = {};
      try {
        const cache = await caches.open('worker-local-probe');
        if (write) await cache.put('https://storage.invalid/guest', new Response('guest-only-sentinel'));
        const own = await cache.match('https://storage.invalid/guest');
        const parent = await caches.match('https://storage.invalid/parent');
        result.own = own ? await own.text() : null; result.parent = parent ? await parent.text() : null;
      } catch {result.denied = true;}
      postMessage(result);
    };`], {type: 'text/javascript'}));
    const worker = new Worker(url);
    try {return await new Promise(resolve => {worker.onmessage = event => resolve(event.data); worker.postMessage(write);});}
    finally {worker.terminate(); URL.revokeObjectURL(url);}
  }, write);
}

test('worker cache cannot read the parent or cross opaque frame/document scopes', async ({page, browserName}) => {
  const {frame, egress} = await open(page);
  await page.evaluate(async () => {
    const cache = await caches.open('trusted-parent-probe');
    await cache.put('https://storage.invalid/parent', new Response('parent-only-sentinel'));
  });
  expect(await frame.evaluate(async () => {
    try {await caches.open('window-probe'); return 'opened';} catch {return 'blocked';}
  })).toBe('blocked');
  const policy = await frame.locator('meta[http-equiv="Content-Security-Policy"]').first().getAttribute('content');
  // The real runtime deliberately destroys navigated guests. This browser-only owner uses the same policy.
  await page.evaluate(policy => {
    const owner = document.createElement('iframe'); owner.id = 'cache-owner'; owner.sandbox.add('allow-scripts');
    owner.srcdoc = '<html><head><meta http-equiv="Content-Security-Policy" content="' + policy + '"></head><body id="cache-owner-body"></body></html>';
    document.body.append(owner);
  }, policy);
  await expect(page.frameLocator('#cache-owner').locator('#cache-owner-body')).toBeAttached();
  const owner = await (await page.locator('#cache-owner').elementHandle())!.contentFrame();
  expect(await cacheProbe(owner!, true)).toEqual(browserName === 'webkit'
    ? {own: 'guest-only-sentinel', parent: null} : {denied: true});
  await page.evaluate(() => {
    const other = document.createElement('iframe'); other.id = 'cache-other'; other.sandbox.add('allow-scripts');
    other.srcdoc = '<html><body id="cache-other-body"></body></html>'; document.body.append(other);
  });
  await expect(page.frameLocator('#cache-other').locator('#cache-other-body')).toBeAttached();
  const other = page.frames().find(candidate => candidate !== frame && candidate.parentFrame() === page.mainFrame())!;
  expect(await cacheProbe(other, false)).toEqual(browserName === 'webkit' ? {own: null, parent: null} : {denied: true});
  await page.evaluate(() => {
    const owner = document.querySelector<HTMLIFrameElement>('#cache-owner')!;
    owner.srcdoc = '<html><body id="cache-replacement"></body></html>';
  });
  await expect(page.frameLocator('#cache-owner').locator('#cache-replacement')).toBeAttached();
  expect(await cacheProbe(owner!, false)).toEqual(browserName === 'webkit' ? {own: null, parent: null} : {denied: true});
  expect(await page.evaluate(async () => {
    const parent = await caches.match('https://storage.invalid/parent');
    const guest = await caches.match('https://storage.invalid/guest');
    return {parent: await parent!.text(), guest: guest ? await guest.text() : null};
  })).toEqual({parent: 'parent-only-sentinel', guest: null});
  expect(egress).toEqual([]);
});


test('a counted loopback server proves actual SharedWorker fetch and import denial', async ({page, browser, browserName}) => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const script = request.url === '/import.js';
    if (request.url === '/fetch' || script) requests.push(request.url);
    response.writeHead(200, {'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store',
      'Content-Type': script ? 'text/javascript' : 'text/html'});
    response.end(script ? 'self.loopbackImported = true;' : 'ok');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback address');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const source = `onconnect = async ({ports: [port]}) => {
    const result = {};
    try {result.fetch = await (await fetch('${endpoint}/fetch')).text();} catch {result.fetch = 'blocked';}
    try {importScripts('${endpoint}/import.js'); result.script = self.loopbackImported ? 'loaded' : 'missing';} catch {result.script = 'blocked';}
    port.postMessage(result); port.close();
  };`;
  const execute = (source: string) => new Promise(resolve => {
    const url = URL.createObjectURL(new Blob([source], {type: 'text/javascript'}));
    try {
      const worker = new SharedWorker(url);
      worker.port.onmessage = event => {worker.port.close(); URL.revokeObjectURL(url); resolve(event.data);};
      worker.port.start();
    } catch (error) {URL.revokeObjectURL(url); resolve({denied: (error as Error).name});}
  });
  const control = await browser.newContext();
  try {
    const unrestricted = await control.newPage(); await unrestricted.goto(endpoint);
    expect(await unrestricted.evaluate(execute, source)).toEqual({fetch: 'ok', script: 'loaded'});
    expect(requests).toEqual(['/fetch', '/import.js']);
    const {frame} = await open(page);
    expect(await frame.evaluate(execute, source)).toEqual(browserName === 'webkit'
      ? {fetch: 'blocked', script: 'blocked'} : {denied: 'SecurityError'});
    expect(requests).toEqual(['/fetch', '/import.js']);
  } finally {
    await control.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
