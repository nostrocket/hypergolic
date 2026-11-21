import {test, expect} from '@playwright/test';
async function open(page: import('@playwright/test').Page, mode: string, legacy = false) {
  await page.addInitScript(({mode, legacy}) => {
    if (window !== window.top) return;
    if (legacy) Object.defineProperty(Object, 'hasOwn', {configurable: true, value: undefined});
    const listeners = new Set<(e: {data: string}) => void>();
    const calls: unknown[] = []; (window as any).linkCalls = calls;
    (window as any).HypergolicHost = {addEventListener: (_: string, fn: any) => listeners.add(fn), removeEventListener: (_: string, fn: any) => listeners.delete(fn),
      postMessage(raw: string) {
        const envelope = JSON.parse(raw); if (envelope.type !== 'capability') return;
        const request = JSON.parse(envelope.message); calls.push(request);
        const link = request.message ?? request;
        const receipt = {type: 'link.open.result', id: mode === 'wrong-id' ? 'wrong' : link.id, status: mode === 'opened' ? 'opened' : 'denied', ...(mode === 'opened' ? {} : {error: 'user-denied'})};
        const response = request.type === 'routing.call' ? {type: 'routing.call.result', id: request.id, response: receipt} : receipt;
        const data = JSON.stringify({type: 'capability.result', sessionId: envelope.sessionId, sequence: envelope.sequence, response: mode === 'revoked' ? null : JSON.stringify(response)});
        if (mode === 'delayed-denial') window.setTimeout(() => {
          for (const listener of listeners) listener({data});
        }, 45_000);
        else for (const listener of listeners) listener({data});
      }};
  }, {mode, legacy});
  await page.goto('/assets/runtime/index.html?sessionId=links-browser&fixture=resource-lab');
  const frame = page.frameLocator('#napplet'); await expect(frame.getByTestId('lab')).toHaveAttribute('data-ready', 'true'); return frame;
}
for (const mode of ['opened', 'denied', 'wrong-id']) test('genuine SDK link service resolves canonical status: ' + mode, async ({page}) => {
  const frame = await open(page, mode); await frame.locator('#open-link').click();
  const status = mode === 'opened' ? 'opened' : 'denied';
  await expect(frame.locator('#link-result')).toHaveText(JSON.stringify({status}));
  const calls = await page.evaluate(() => (window as any).linkCalls);
  expect(calls).toHaveLength(1);expect(calls[0]).toMatchObject({type: 'link.open', url: 'https://example.com/?hypergolic=link-tracer', options: {label: 'Read external page'}});
  expect(Object.keys(calls[0]).sort()).toEqual(['id', 'options', 'type', 'url']);
});

test('native identity revocation settles transport without a stale SDK receipt', async ({page}) => {
  const frame = await open(page, 'revoked');
  await page.clock.install();
  await frame.locator('#open-link').click();
  await expect.poll(() => page.evaluate(() => (window as any).linkCalls.length)).toBe(1);
  // A null native revocation clears the transport timer; it must not become denial now or on timeout.
  await page.clock.fastForward(28_000);
  await expect(frame.locator('#link-result')).toBeEmpty();
  await expect(frame.locator('#link-status')).not.toHaveText('Link opening denied.');
  await frame.locator('#open-link').click();
  await expect.poll(() => page.evaluate(() => (window as any).linkCalls.length)).toBe(2);
  await expect(frame.locator('#link-result')).toBeEmpty();
});

test('genuine SDK link starts with an older WebView static API', async ({page}) => {
  const frame = await open(page, 'opened', true);
  await frame.locator('#open-link').click();
  await expect(frame.locator('#link-result')).toHaveText(JSON.stringify({status: 'opened'}));
});

test('SDK napplet link delegates to in-shell review with its request ID intact', async ({page}) => {
  const frame = await open(page, 'opened');
  await frame.locator('#link-url').fill('nostr:naddr1example');
  await frame.locator('#open-link').click();
  await expect(frame.locator('#link-result')).toHaveText(JSON.stringify({status: 'opened'}));
  const calls = await page.evaluate(() => (window as any).linkCalls);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({type: 'routing.call', message: {type: 'link.open', url: 'nostr:naddr1example'}});
});

test('a pending napplet review outlives a short web-link handoff and returns its denial reason', async ({page}) => {
  const frame = await open(page, 'delayed-denial');
  await page.clock.install();
  await frame.locator('#link-url').fill('nostr:naddr1example');
  await frame.locator('#open-link').click();
  await expect.poll(() => page.evaluate(() => (window as any).linkCalls.length)).toBe(1);
  await page.clock.fastForward(45_001);
  await expect(frame.locator('#link-result')).toHaveText(JSON.stringify({status: 'denied', error: 'user-denied'}));
});
