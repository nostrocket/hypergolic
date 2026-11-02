import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const generation = '12345678-1234-1234-1234-123456789abc';
const html = readFileSync('fixtures/ux-lab.html');
const approvalHtml = readFileSync('fixtures/approval-lab.html');
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const htmlHash = digest(html);
const version = digest(`${htmlHash} /index.html\n`);
const identity = {
  publisher: '1'.repeat(64), appId: 'published-test', eventId: '2'.repeat(64), version, htmlHash,
};

type Mode = 'normal' | 'bad-hash' | 'malformed-base64' | 'replayed-sequence' | 'unknown-domain' | 'relay-domain' | 'attributed-head' | 'upload-domain' | 'all-domains' | 'outbox-domain' | 'outbox-only' | 'published-approval';

async function openPublished(page: Page, mode: Mode = 'normal', extraQuery = '') {
  const artifact = mode === 'published-approval' ? approvalHtml : mode === 'attributed-head' ? Buffer.from(html.toString().replace('<head>','<HEAD data-fixture="attribute">')) : html;
  const artifactHash = digest(artifact);
  const artifactIdentity = {...identity,htmlHash:artifactHash,version:digest(`${artifactHash} /index.html\n`)};
  await page.addInitScript(({ generation, htmlBase64, htmlLength, identity, badHashVersion, mode }) => {
    if (window !== window.top) return;
    const state = { requests: [] as unknown[], diagnostics: [] as unknown[],
      reply(sequence: number, response: unknown) {
        for (const listener of listenerSet) listener({data: JSON.stringify({
          type: 'capability.result', sessionId: generation, sequence,
          response: JSON.stringify(response),
        })});
      },
    };
    (window as any).__publishedTest = state;
    const bytes = Uint8Array.from(atob(htmlBase64), char => char.charCodeAt(0));
    const listenerSet = new Set<(event: { data: string }) => void>();
    const badHash = 'f'.repeat(64);
    const claims = mode === 'bad-hash'
      ? { ...identity, htmlHash: badHash, version: badHashVersion }
      : identity;
    // The bad-hash case keeps the NIP-5A version internally consistent with
    // its false file claim, so it reaches and exercises byte verification.
    const emit = (sequence: number) => {
      const payload = bytes.slice(sequence * 48 * 1024, (sequence + 1) * 48 * 1024);
      const base64 = mode === 'malformed-base64' ? '!!!!' : btoa(String.fromCharCode(...payload));
      const envelope = {
        type: 'artifact.chunk', sessionId: generation,
        sequence: mode === 'replayed-sequence' ? sequence + 1 : sequence,
        base64, byteLength: payload.length, totalBytes: htmlLength,
        ...claims, domains: mode === 'published-approval' ? ['identity', 'relay', 'theme'] : mode === 'unknown-domain' ? ['future-domain'] : mode === 'outbox-domain' ? ['outbox', 'relay', 'theme'] : mode === 'outbox-only' ? ['outbox', 'theme'] : mode === 'relay-domain' ? ['relay', 'theme'] : mode === 'upload-domain' ? ['upload'] : mode === 'all-domains' ? ['config', 'identity', 'inc', 'intent', 'link', 'notify', 'outbox', 'relay', 'resource', 'storage', 'theme', 'upload'] : ['theme'],
        done: (sequence + 1) * 48 * 1024 >= htmlLength,
      };
      for (const listener of listenerSet) listener({ data: JSON.stringify(envelope) });
    };
    Object.defineProperty(window, 'HypergolicHost', { value: {
      addEventListener: (_type: string, listener: (event: { data: string }) => void) => listenerSet.add(listener),
      removeEventListener: (_type: string, listener: (event: { data: string }) => void) => listenerSet.delete(listener),
      postMessage(raw: string) {
        const request = JSON.parse(raw);
        state.requests.push(request);
        if (request.type === 'artifact.read') { emit(request.sequence); return; }
        if (request.type === 'ready' || request.type === 'error') state.diagnostics.push(request);
        if (request.type === 'capability') {
          const wire = JSON.parse(request.message);
          let response;
          if (wire.type === 'identity.getPublicKey') response = {type: 'identity.getPublicKey.result', id: wire.id, pubkey: '1'.repeat(64)};
          else if (wire.type === 'outbox.query') response = {type: 'outbox.query.result', id: wire.id, events: []};
          else if (wire.type === 'outbox.publish') response = {type: 'outbox.publish.result', id: wire.id, ok: false, error: 'user rejected'};
          if (response) for (const listener of listenerSet) listener({data: JSON.stringify({type: 'capability.result', sessionId: generation, sequence: request.sequence, response: JSON.stringify(response)})});
        }
      },
    } });
    Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Storage disabled', 'SecurityError'); } });
    Object.defineProperty(window, 'sessionStorage', { get() { throw new DOMException('Storage disabled', 'SecurityError'); } });
  }, { generation, htmlBase64: artifact.toString('base64'), htmlLength: artifact.length, identity:artifactIdentity,
    badHashVersion: awaitHashVersionPlaceholder, mode });
  await page.goto(`/assets/runtime/index.html?sessionId=${generation}&source=published${extraQuery}`);
}

// Calculated in Node to keep browser fixture setup simple and deterministic.
const awaitHashVersionPlaceholder = digest(`${'f'.repeat(64)} /index.html\n`);

test('published host works when an older WebView lacks URLSearchParams.size', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(URLSearchParams.prototype, 'size', { configurable: true, get: () => undefined });
  });
  await openPublished(page);
  await expect(page.locator('#napplet')).toHaveCount(1);
  await expect(page.frameLocator('#napplet').getByTestId('lab')).toHaveAttribute('data-ready', 'true');
  await expect.poll(() => page.evaluate(() => (window as any).__publishedTest.diagnostics)).toEqual([
    { type: 'ready', sessionId: generation },
  ]);
});

test('older WebView query counting still rejects unexpected published parameters', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(URLSearchParams.prototype, 'size', { configurable: true, get: () => undefined });
  });
  await openPublished(page, 'normal', '&unexpected=1');
  await expect(page.getByRole('alert')).toHaveText('The napplet could not be loaded.');
  await expect(page.locator('iframe')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__publishedTest.diagnostics)).toEqual([
    { type: 'error', sessionId: generation, code: 'artifact-integrity' },
  ]);
  expect(await page.evaluate(() => (window as any).__publishedTest.requests.filter((request: any) => request.type === 'artifact.read'))).toEqual([]);
});

test('published napplet streams verified bytes, gets theme only, and runs in an isolated frame', async ({ page }) => {
  await openPublished(page);
  await expect(page.locator('#napplet')).toHaveCount(1);
  await expect(page.frameLocator('#napplet').getByTestId('lab')).toHaveAttribute('data-ready', 'true');
  await expect(page.frameLocator('#napplet').getByTestId('theme-status')).toHaveText('Host colors');
  await expect.poll(() => page.evaluate(() => (window as any).__publishedTest.diagnostics)).toEqual([
    { type: 'ready', sessionId: generation },
  ]);
  const result = await page.locator('#napplet').evaluate((frame: HTMLIFrameElement) => ({
    sandbox: frame.getAttribute('sandbox'), src: frame.getAttribute('src'),
  }));
  expect(result).toEqual({ sandbox: 'allow-scripts', src: null });
  const guest = page.frames().find(frame => frame.parentFrame() === page.mainFrame());
  if (!guest) throw new Error('Missing published napplet frame');
  const domains = await guest.evaluate(() => ({
    theme: (window as any).napplet.shell.supports('theme'),
    relay: (window as any).napplet.shell.supports('relay'),
  }));
  expect(domains).toEqual({ theme: true, relay: false });
  const csp = await guest.locator('head > meta[http-equiv="Content-Security-Policy"]').evaluate(node => ({
    first: node === document.head.firstElementChild,
    content: node.getAttribute('content'),
  }));
  expect(csp.first).toBe(true);
  expect(csp.content).toContain("connect-src 'none'");
  const reads = await page.evaluate(() => (window as any).__publishedTest.requests.filter((item: any) => item.type === 'artifact.read'));
  expect(reads.length).toBeGreaterThan(0);
  expect(reads.map((item: any) => item.sequence)).toEqual(reads.map((_item: any, index: number) => index));
});

test('published runtime exposes only the bounded native-declared domains', async ({ page }) => {
  await openPublished(page, 'relay-domain');
  await expect(page.locator('#napplet')).toHaveCount(1);
  const guest = page.frames().find(frame => frame.parentFrame() === page.mainFrame());
  if (!guest) throw new Error('Missing published napplet frame');
  await expect.poll(() => guest.evaluate(() => (window as any).napplet.shell.supports('relay'))).toBe(true);
  expect(await guest.evaluate(() => (window as any).napplet.shell.supports('storage'))).toBe(false);
});

for (const mode of ['bad-hash', 'malformed-base64', 'replayed-sequence', 'unknown-domain'] as const) {
  test(`published ${mode} fails closed before creating the napplet frame`, async ({ page }) => {
    await openPublished(page, mode);
    await expect(page.getByRole('alert')).toHaveText('The napplet could not be loaded.');
    await expect.poll(() => page.evaluate(() => (window as any).__publishedTest.diagnostics)).toEqual([
      { type: 'error', sessionId: generation, code: 'artifact-integrity' },
    ]);
    await expect(page.locator('iframe')).toHaveCount(0);
  });
}

test('trusted media prelude preserves the leading CSP in a valid attributed uppercase published head',async({page})=>{
  await openPublished(page,'attributed-head');
  await expect(page.frameLocator('#napplet').getByTestId('lab')).toHaveAttribute('data-ready','true');
  const guest=page.frames().find(frame=>frame.parentFrame()===page.mainFrame())!;
  expect(await guest.evaluate(()=>document.head.firstElementChild?.getAttribute('http-equiv'))).toBe('Content-Security-Policy');
});

for (const mode of ['upload-domain', 'all-domains'] as const) {
  test(`published ${mode} preserves native-declared access through artifact verification`, async ({page}) => {
    await openPublished(page, mode);
    await expect.poll(() => page.evaluate(() => (window as any).__publishedTest.diagnostics)).toEqual([{type: 'ready', sessionId: generation}]);
    const guest = page.frames().find(frame => frame.parentFrame() === page.mainFrame())!;
    await expect.poll(() => guest.evaluate(() => (window as any).napplet.shell.supports('upload'))).toBe(true);
    expect(await guest.evaluate(() => (window as any).napplet.shell.supports('resource'))).toBe(mode === 'all-domains');
    expect(await guest.evaluate(() => (window as any).napplet.shell.supports('link'))).toBe(mode === 'all-domains');
    expect(await guest.evaluate(() => (window as any).napplet.shell.supports('inc'))).toBe(mode === 'all-domains');
    for (const domain of ['intent','notify','config']) expect(await guest.evaluate(domain => (window as any).napplet.shell.supports(domain), domain)).toBe(mode === 'all-domains');
  });
}


test('verified-byte published runtime exposes Outbox only from native grants and carries real SDK read/publication rejection', async ({page}) => {
  await openPublished(page, 'outbox-domain');
  const guest = page.frames().find(frame => frame.parentFrame() === page.mainFrame())!;
  await expect.poll(() => guest.evaluate(() => (window as any).napplet.shell.supports('outbox'))).toBe(true);
  expect(await guest.evaluate(() => (window as any).napplet.outbox.query({kinds: [1], limit: 0}))).toMatchObject({type: 'outbox.query.result', events: []});
  expect(await guest.evaluate(() => (window as any).napplet.outbox.publish({kind: 1, created_at: 1_800_000_000, tags: [], content: 'published admission fixture'}, {toOutbox: false, relays: ['wss://relay.example.org']}))).toMatchObject({type: 'outbox.publish.result', ok: false, error: 'user rejected'});
  const calls = await page.evaluate(() => (window as any).__publishedTest.requests.filter((x: any) => x.type === 'capability').map((x: any) => JSON.parse(x.message)));
  expect(calls.map((x: any) => x.type)).toEqual(['outbox.query', 'outbox.publish']);
  expect(calls[1].options).toMatchObject({toOutbox: false, relays: ['wss://relay.example.org']});
});
test('URL parameters cannot grant published Outbox or bypass the exact native artifact path', async ({page}) => {
  await openPublished(page, 'normal', '&domains=outbox,relay,theme');
  await expect.poll(() => page.evaluate(() => (window as any).__publishedTest.diagnostics)).toEqual([{type: 'error', code: 'artifact-integrity', sessionId: generation}]);
  await expect(page.locator('#napplet')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__publishedTest.requests)).toHaveLength(1);
});
test('an Outbox-only native grant neither exposes usable Outbox nor acquires relay authority', async ({page}) => {
  await openPublished(page, 'outbox-only'); await expect(page.locator('#napplet')).toHaveCount(1);
  const guest = page.frames().find(frame => frame.parentFrame() === page.mainFrame())!;
  await expect.poll(() => guest.evaluate(() => (window as any).napplet.shell.supports('outbox'))).toBe(false);
  expect(await guest.evaluate(() => (window as any).napplet.shell.supports('relay'))).toBe(false);
  await guest.evaluate(() => {parent.postMessage({type: 'outbox.query', id: 'missing-relay', filters: [{kinds: [1], limit: 0}]}, '*');});
  expect(await page.evaluate(() => (window as any).__publishedTest.requests.filter((x: any) => x.type === 'capability'))).toHaveLength(0);
});


// Real Approval Lab SDK, verified-byte bootstrap, Kehto and native client.
// Native artifact transport, grants and replies are doubled; no signing or network.
async function submitPublishedApproval(page: Page) {
  await openPublished(page, 'published-approval');
  const ui = page.frameLocator('#napplet');
  await expect(ui.locator('#identity-status')).toHaveText('Identity connected');
  await ui.locator('#content').fill('published delayed approval');
  await ui.locator('#send').click();
  await expect.poll(() => page.evaluate(() => (window as any).__publishedTest.requests
    .filter((entry: any) => entry.type === 'capability' && JSON.parse(entry.message).type === 'relay.publish').length)).toBe(1);
  return ui;
}

async function publishedApprovalCalls(page: Page) {
  return page.evaluate(() => (window as any).__publishedTest.requests
    .filter((entry: any) => entry.type === 'capability' && JSON.parse(entry.message).type === 'relay.publish'));
}

test('published Approval Lab SDK survives both short deadlines and receives one correlated delayed denial', async ({page}) => {
  await page.clock.install({time: new Date('2026-01-01T00:00:00Z')});
  await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
  const ui = await submitPublishedApproval(page);
  const original = await publishedApprovalCalls(page);
  const guest = page.frames().find(frame => frame.parentFrame() === page.mainFrame())!;
  await guest.evaluate(() => {
    const state = window as any;
    state.__shortRead = 'pending';
    state.napplet.relay.query({kinds: [1], limit: 0}).then(
      () => { state.__shortRead = 'settled'; },
      () => { state.__shortRead = 'settled'; });
  });
  await expect.poll(() => page.evaluate(() => (window as any).__publishedTest.requests
    .filter((entry: any) => entry.type === 'capability' && JSON.parse(entry.message).type === 'relay.query').length)).toBe(1);
  await page.clock.fastForward(28_000);
  expect(await guest.evaluate(() => (window as any).__shortRead)).toBe('settled');
  await expect(ui.locator('.request[data-sequence="1"]')).toHaveAttribute('data-state', 'sending');
  await page.clock.fastForward(3_000);
  await expect(ui.locator('#status')).toHaveText('Request 1 captured and sent to the shell.');
  await expect(ui.locator('.request[data-sequence="1"]')).toHaveAttribute('data-state', 'sending');
  expect(await publishedApprovalCalls(page)).toEqual(original);
  await page.evaluate(() => {
    const state = (window as any).__publishedTest;
    const envelope = state.requests.find((entry: any) => entry.type === 'capability' && JSON.parse(entry.message).type === 'relay.publish');
    const wire = JSON.parse(envelope.message);
    const denied = {type: 'relay.publish.result', id: wire.id, ok: false, error: 'user rejected'};
    state.reply(envelope.sequence, denied);
    state.reply(envelope.sequence, denied); // Duplicate does not settle/retry twice.
  });
  await expect(ui.locator('.request[data-sequence="1"] .event-id')).toHaveText('user rejected');
  await expect(ui.locator('#status')).toHaveText('Request 1 failed. No automatic retry.');
  await expect(ui.locator('#pending')).toHaveText('0');
  expect(await publishedApprovalCalls(page)).toEqual(original);
});

test('published Approval Lab remains bounded by the original 660-second response deadline', async ({page}) => {
  await page.clock.install({time: new Date('2026-01-01T00:00:00Z')});
  await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
  const ui = await submitPublishedApproval(page);
  const original = await publishedApprovalCalls(page);
  await page.clock.fastForward(659_999);
  await expect(ui.locator('.request[data-sequence="1"]')).toHaveAttribute('data-state', 'sending');
  await page.clock.fastForward(2);
  await expect(ui.locator('.request[data-sequence="1"]')).toHaveAttribute('data-state', 'failed');
  await expect(ui.locator('#pending')).toHaveText('0');
  expect(await publishedApprovalCalls(page)).toEqual(original);
});
