import { test, expect, type FrameLocator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

const build = new URL('../dist/', import.meta.url);
const sourceHtml = readFileSync(new URL('index.html', build), 'utf8');
const first = 'a'.repeat(64);
const second = 'b'.repeat(64);
const light = { colors: { background: '#ffffff', text: '#17212b', primary: '#b84421' } };
const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'">`;

// Test-only SDK mock. It exercises the fixture UI and genuine SDK wrapper calls;
// it does not prove native admission, approval, signing or relay delivery.
function sdkMock(mode: string): string {
  return `<script>
  const calls = [], pending = [], frozen = [];
  let identityChanged = () => {}, themeChanged = () => {}, resolveIdentity, resolveTheme;
  let scheduledCallback = () => {};
  const state = {
    calls, frozen, pending, delays: [], cleared: [], closed: 0, fail: false, defer: false, malformed: false,
    pushIdentity: value => identityChanged(value),
    pushTheme: value => themeChanged(value),
    identity: value => resolveIdentity(value),
    theme: value => resolveTheme(value),
    resolveAt: (index, id = 'e'.repeat(64)) => pending[index].resolve({ id }),
    rejectAt: (index, message = 'relay rejected') => pending[index].reject(new Error(message)),
    resolveAll: () => pending.forEach((item, index) => item.resolve({ id: index.toString(16).padStart(64, '0') })),
    runTimer: () => scheduledCallback(),
  };
  ${mode === 'manualTimers' ? `window.setTimeout = (callback, delay) => { state.delays.push(delay); scheduledCallback = callback; return 77; };
  window.clearTimeout = id => { state.cleared.push(id); };` : ''}
  window.napplet = {
    identity: {
      getPublicKey: () => ${mode === 'delayIdentity' ? 'new Promise(resolve => { resolveIdentity = resolve; })' : `Promise.resolve(${JSON.stringify(mode === 'signedOut' ? '' : first)})`},
      onChanged: handler => { identityChanged = handler; return { close: () => { state.closed++; identityChanged = () => {}; } }; }
    },
    relay: {
      publish: event => {
        frozen.push({ event: Object.isFrozen(event), tags: Object.isFrozen(event.tags), entries: event.tags.every(Object.isFrozen) });
        calls.push(JSON.parse(JSON.stringify(event)));
        if (state.fail) return Promise.reject(new Error('relay rejected'));
        if (state.malformed) return Promise.resolve({});
        if (state.defer) return new Promise((resolve, reject) => pending.push({ resolve, reject }));
        const sequence = event.tags.find(tag => tag[0] === 'test-sequence')?.[1] ?? '0';
        return Promise.resolve({ id: Number(sequence).toString(16).padStart(64, '0') });
      }
    },
    theme: {
      get: () => ${mode === 'delayTheme' ? 'new Promise(resolve => { resolveTheme = resolve; })' : `Promise.resolve(${JSON.stringify(light)})`},
      onChanged: handler => { themeChanged = handler; return { close: () => { state.closed++; themeChanged = () => {}; } }; }
    }
  };
  window.fixtureTest = state;
  </script>`;
}

async function mount(page: Page, mode = 'normal'): Promise<FrameLocator> {
  await page.setContent('<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%;position:fixed;inset:0}</style>');
  const html = sourceHtml.replace('<head>', '<head>' + csp + (mode === 'absent' ? '' : sdkMock(mode)));
  await page.evaluate((content) => {
    const frame = document.createElement('iframe');
    frame.id = 'fixture'; frame.title = 'Approval Lab fixture';
    frame.sandbox.add('allow-scripts'); frame.srcdoc = content; document.body.append(frame);
  }, html);
  const frame = page.frameLocator('#fixture');
  await expect(frame.getByTestId('lab')).toHaveAttribute('data-ready', 'true');
  if (!['absent', 'delayIdentity', 'signedOut'].includes(mode)) {
    await expect(frame.getByTestId('identity')).toHaveText(first);
  }
  return frame;
}

async function fixtureState<T>(frame: FrameLocator, operation: string, value?: unknown): Promise<T> {
  return frame.locator('body').evaluate((_body, input) => {
    const state = (window as any).fixtureTest;
    if (input.operation === 'calls') return state.calls;
    if (input.operation === 'set-defer') { state.defer = true; return null; }
    if (input.operation === 'set-fail') { state.fail = true; return null; }
    if (input.operation === 'set-malformed') { state.malformed = true; return null; }
    if (input.operation === 'resolve-at') { state.resolveAt(input.value ?? 0); return null; }
    if (input.operation === 'resolve-all') { state.resolveAll(); return null; }
    if (input.operation === 'summary') return { calls: state.calls, delays: state.delays };
    if (input.operation === 'frozen') return state.frozen;
    if (input.operation === 'identity-change') { state.pushIdentity(input.value); return null; }
    if (input.operation === 'late-identity') {
      state.pushIdentity('b'.repeat(64)); state.identity('a'.repeat(64)); return null;
    }
    if (input.operation === 'change-and-resolve') {
      state.pushIdentity('b'.repeat(64)); state.resolveAt(0); return null;
    }
    if (input.operation === 'calls-length') return state.calls.length;
    if (input.operation === 'closed') return state.closed;
    if (input.operation === 'run-timer') { state.runTimer(); return null; }
    if (input.operation === 'timer-summary') return { delays: state.delays, cleared: state.cleared };
    if (input.operation === 'dark-then-light-result') {
      state.pushTheme({ colors: { background: '#140f0b', text: '#f3efeb', primary: '#e8805d' } });
      state.theme({ colors: { background: '#ffffff', text: '#17212b', primary: '#b84421' } });
      return null;
    }
    if (input.operation === 'light-theme') {
      state.pushTheme({ colors: { background: '#ffffff', text: '#17212b', primary: '#b84421' } });
      return null;
    }
    throw new Error(`Unknown fixture operation: ${input.operation}`);
  }, { operation, value });
}

test('accessible name includes the current validated public identity', async ({ page }) => {
  const frame = await mount(page);
  await expect(frame.getByRole('status', { name: `Selected public identity: ${first}`, exact: true })).toHaveText(first);
});

test('accessible identity follows a push instead of the stale startup result', async ({ page }) => {
  const frame = await mount(page, 'delayIdentity');
  await fixtureState(frame, 'late-identity');
  await expect(frame.getByRole('status', { name: `Selected public identity: ${second}`, exact: true })).toHaveText(second);
  await expect(frame.getByRole('status', { name: `Selected public identity: ${first}`, exact: true })).toHaveCount(0);
});

for (const [reason, unavailable] of [['sign-out', ''], ['invalid identity', 'not-a-public-key'], ['trailing line break', first + '\n']]) test(`accessible identity clears the previous key on ${reason}`, async ({ page }) => {
  const frame = await mount(page);
  await fixtureState(frame, 'identity-change', unavailable);
  await expect(frame.getByRole('status', { name: 'No identity selected', exact: true })).toHaveText('');
  await expect(frame.getByRole('status', { name: `Selected public identity: ${first}`, exact: true })).toHaveCount(0);
  await expect(frame.getByTestId('send')).toBeDisabled();
});

test('artifact is one unsigned inline file with exact identity and relay requirements', () => {
  expect(readdirSync(build).sort()).toEqual(['.nip5a-manifest.json', 'index.html']);
  const manifest = JSON.parse(readFileSync(new URL('.nip5a-manifest.json', build), 'utf8'));
  const digest = createHash('sha256').update(sourceHtml).digest('hex');
  const aggregate = createHash('sha256').update(digest + ' /index.html\n').digest('hex');
  expect(manifest.kind).toBe(35129);
  expect(manifest.tags).toContainEqual(['d', 'approval-lab']);
  expect(manifest.tags.filter((tag: string[]) => tag[0] === 'path')).toEqual([['path', '/index.html', digest]]);
  expect(manifest.tags).toContainEqual(['x', aggregate, 'aggregate']);
  expect(manifest.aggregateHash).toBe(aggregate);
  expect(manifest.tags.filter((tag: string[]) => tag[0] === 'requires')).toEqual([
    ['requires', 'identity'], ['requires', 'relay'],
  ]);
  expect(manifest).not.toHaveProperty('sig');
  expect(manifest).not.toHaveProperty('pubkey');
  expect(sourceHtml).not.toMatch(/<script[^>]+src=|<link[^>]+href=|@import|https?:\/\//i);
  expect(sourceHtml).not.toMatch(/\b(?:fetch|WebSocket|localStorage|sessionStorage|indexedDB|XMLHttpRequest)\b|window\.nostr|document\.cookie/);
  expect(sourceHtml).not.toContain('fixtureTest');
  const appSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  expect(appSource).not.toMatch(/window\.napplet|postMessage|window\.nostr|\b(?:fetch|WebSocket|localStorage|sessionStorage|indexedDB|XMLHttpRequest|outbox)\b/);
});

test('single note publishes the exact unsigned literal snapshot and shows its event ID', async ({ page }) => {
  const frame = await mount(page);
  const literal = '<img src=x onerror="window.attack=true">\n🧪 你好';
  await frame.getByTestId('content').fill(literal);
  const before = Math.floor(Date.now() / 1_000);
  await frame.getByTestId('send').click();
  await expect(frame.locator('.request')).toHaveAttribute('data-state', 'published');
  const after = Math.floor(Date.now() / 1_000);
  const calls = await fixtureState<any[]>(frame, 'calls');
  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual({
    kind: 1,
    content: literal,
    tags: [['t', 'hypergolic-approval-lab'], ['test-sequence', '1']],
    created_at: calls[0].created_at,
  });
  expect(calls[0].created_at).toBeGreaterThanOrEqual(before);
  expect(calls[0].created_at).toBeLessThanOrEqual(after);
  expect(calls[0]).not.toHaveProperty('id');
  expect(calls[0]).not.toHaveProperty('pubkey');
  expect(calls[0]).not.toHaveProperty('sig');
  expect(await fixtureState(frame, 'frozen')).toEqual([{ event: true, tags: true, entries: true }]);
  await expect(frame.locator('.request-content')).toHaveText(literal);
  await expect(frame.locator('.event-id')).toContainText('Event ID');
  await expect(frame.locator('img')).toHaveCount(0);
});

test('profile metadata captures escaped JSON and its kind before approval', async ({ page }, testInfo) => {
  const frame = await mount(page);
  await expect(frame.getByTestId('kind-note')).toBeChecked();
  await expect(frame.getByTestId('profile-warning')).toBeHidden();
  await fixtureState(frame, 'set-defer');
  await frame.getByTestId('kind-profile').check();
  await expect(frame.getByTestId('profile-warning')).toBeVisible();
  await expect(frame.getByRole('textbox', { name: 'Profile bio' })).toBeVisible();
  const bio = 'Development QA "quoted"\n🧪 你好 <img src=x>';
  await frame.getByTestId('content').fill(bio);
  await page.screenshot({ path: testInfo.outputPath('approval-lab-profile-warning.png'), fullPage: true });
  await frame.getByRole('button', { name: 'Send profile metadata', exact: true }).click();
  const captured = (await fixtureState<any[]>(frame, 'calls'))[0];
  expect(captured.kind).toBe(0);
  expect(captured.content).toBe(JSON.stringify({ about: bio }));
  expect(captured.tags).toEqual([['t', 'hypergolic-approval-lab'], ['test-sequence', '1']]);
  expect(captured).not.toHaveProperty('pubkey');
  expect(captured).not.toHaveProperty('sig');
  await frame.getByTestId('kind-note').check();
  await frame.getByTestId('content').fill('later note');
  await fixtureState(frame, 'resolve-at', 0);
  await expect(frame.locator('.request')).toHaveAttribute('data-kind', '0');
  await expect(frame.locator('.request-kind')).toHaveText('Profile metadata (kind 0)');
  await expect(frame.locator('.request-content')).toHaveText(captured.content);
  expect((await fixtureState<any[]>(frame, 'calls'))[0]).toEqual(captured);
  expect(await fixtureState(frame, 'frozen')).toEqual([{ event: true, tags: true, entries: true }]);
  await expect(frame.locator('img')).toHaveCount(0);
  await frame.locator('.request').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('approval-lab-profile-captured.png'), fullPage: true });
});

test('delayed profile keeps its captured kind and JSON after editor changes', async ({ page }) => {
  const frame = await mount(page, 'manualTimers');
  await frame.getByTestId('kind-profile').check();
  await frame.getByTestId('content').fill('captured profile bio');
  await frame.getByTestId('send-delayed').click();
  await frame.getByTestId('kind-note').check();
  await frame.getByTestId('content').fill('later note');
  expect(await fixtureState(frame, 'calls-length')).toBe(0);
  await fixtureState(frame, 'run-timer');
  await expect.poll(() => fixtureState<number>(frame, 'calls-length')).toBe(1);
  const calls = await fixtureState<any[]>(frame, 'calls');
  expect(calls[0].kind).toBe(0);
  expect(calls[0].content).toBe(JSON.stringify({ about: 'captured profile bio' }));
  await expect(frame.locator('.request')).toHaveAttribute('data-kind', '0');
});

test('content and timestamp are finalized before an unresolved shell approval', async ({ page }) => {
  const frame = await mount(page);
  await fixtureState(frame, 'set-defer');
  await frame.getByTestId('content').fill('captured exactly');
  await frame.getByTestId('send').click();
  const captured = (await fixtureState<any[]>(frame, 'calls'))[0];
  await frame.getByTestId('content').fill('edited later');
  await fixtureState(frame, 'resolve-at', 0);
  await expect(frame.locator('.request')).toHaveAttribute('data-state', 'published');
  const after = (await fixtureState<any[]>(frame, 'calls'))[0];
  expect(after).toEqual(captured);
  expect(after.content).toBe('captured exactly');
});

test('delayed request snapshots immediately and submits once after five seconds', async ({ page }) => {
  const frame = await mount(page, 'manualTimers');
  await frame.getByTestId('content').fill('delayed original');
  await frame.getByTestId('send-delayed').click();
  await expect(frame.locator('.request')).toHaveAttribute('data-state', 'scheduled');
  await frame.getByTestId('content').fill('changed during wait');
  expect(await fixtureState<number>(frame, 'calls-length')).toBe(0);
  expect(await fixtureState(frame, 'timer-summary')).toEqual({ delays: [5000], cleared: [] });
  await fixtureState(frame, 'run-timer');
  await expect.poll(() => fixtureState<number>(frame, 'calls-length')).toBe(1);
  const state = await fixtureState<{ calls: any[]; delays: number[] }>(frame, 'summary');
  expect(state.calls[0].content).toBe('delayed original');
  await expect(frame.locator('.request')).toHaveAttribute('data-state', 'published');
});

test('four active requests fill the queue and disable overflow controls', async ({ page }) => {
  const frame = await mount(page);
  await fixtureState(frame, 'set-defer');
  await frame.getByTestId('send').click();
  await frame.getByTestId('send-three').click();
  await expect(frame.getByTestId('pending')).toHaveText('4');
  await expect(frame.locator('.request')).toHaveCount(4);
  await expect(frame.getByTestId('send')).toBeDisabled();
  await expect(frame.getByTestId('send-three')).toBeDisabled();
  await expect(frame.getByTestId('send-delayed')).toBeDisabled();
  const calls = await fixtureState<any[]>(frame, 'calls');
  expect(calls.map((call: any) => call.tags[1])).toEqual([
    ['test-sequence', '1'], ['test-sequence', '2'], ['test-sequence', '3'], ['test-sequence', '4'],
  ]);
  await fixtureState(frame, 'resolve-all');
  await expect(frame.getByTestId('pending')).toHaveText('0');
  await expect(frame.getByTestId('send')).toBeEnabled();
  await frame.getByTestId('clear').click();
  await expect(frame.locator('.request')).toHaveCount(0);
  await expect(frame.getByTestId('requests')).toHaveText('4');
});

test('failure is visible and never retried', async ({ page }) => {
  const frame = await mount(page);
  await fixtureState(frame, 'set-fail');
  await frame.getByTestId('send').click();
  await expect(frame.locator('.request')).toHaveAttribute('data-state', 'failed');
  await expect(frame.locator('.event-id')).toHaveText('relay rejected');
  await expect(frame.getByTestId('status')).toContainText('No automatic retry');
  await page.waitForTimeout(100);
  expect(await fixtureState<number>(frame, 'calls-length')).toBe(1);
});

test('malformed SDK success without a verifiable event ID is a visible failure', async ({ page }) => {
  const frame = await mount(page);
  await fixtureState(frame, 'set-malformed');
  await frame.getByTestId('send').click();
  await expect(frame.locator('.request')).toHaveAttribute('data-state', 'failed');
  await expect(frame.locator('.event-id')).toHaveText('Shell returned no verifiable event ID');
  await expect(frame.getByTestId('status')).toContainText('failed. No automatic retry');
  expect(await fixtureState<number>(frame, 'calls-length')).toBe(1);
});

test('identity push wins over the older startup result', async ({ page }) => {
  const frame = await mount(page, 'delayIdentity');
  await expect(frame.getByTestId('send')).toBeDisabled();
  await fixtureState(frame, 'late-identity');
  await expect(frame.getByTestId('identity')).toHaveText(second);
  await expect(frame.getByTestId('send')).toBeEnabled();
});

test('identity change cancels scheduled work and ignores late issued results', async ({ page }) => {
  const frame = await mount(page);
  await fixtureState(frame, 'set-defer');
  await frame.getByTestId('send').click();
  await frame.getByTestId('send-delayed').click();
  await expect(frame.getByTestId('pending')).toHaveText('2');
  await fixtureState(frame, 'change-and-resolve');
  await expect(frame.getByTestId('identity')).toHaveText(second);
  await expect(frame.locator('[data-sequence="1"]')).toHaveAttribute('data-state', 'ignored');
  await expect(frame.locator('[data-sequence="2"]')).toHaveAttribute('data-state', 'cancelled');
  await expect(frame.getByTestId('pending')).toHaveText('0');
  await page.waitForTimeout(80);
  expect(await fixtureState<number>(frame, 'calls-length')).toBe(1);
});

test('pagehide closes subscriptions, cancels delayed submission and disables controls', async ({ page }) => {
  const frame = await mount(page, 'manualTimers');
  await frame.getByTestId('send-delayed').click();
  await frame.locator('body').evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await fixtureState(frame, 'run-timer');
  expect(await fixtureState<number>(frame, 'calls-length')).toBe(0);
  expect(await fixtureState<number>(frame, 'closed')).toBe(2);
  expect(await fixtureState(frame, 'timer-summary')).toEqual({ delays: [5000], cleared: [77] });
  await expect(frame.getByTestId('send')).toBeDisabled();
  await expect(frame.locator('.request')).toHaveAttribute('data-state', 'cancelled');
});

for (const mode of ['absent', 'signedOut']) {
  test(`${mode} cannot create a request and keeps a readable explanation`, async ({ page }) => {
    const frame = await mount(page, mode);
    await expect(frame.getByTestId('send')).toBeDisabled();
    await expect(frame.getByTestId('identity-status')).toHaveText(
      mode === 'absent' ? 'Open in a shell with identity and relay access' : 'No identity selected',
    );
    await expect(frame.getByTestId('requests')).toHaveText('0');
  });
}

test('host themes paint all surfaces and retain review screenshots', async ({ page }, testInfo) => {
  const frame = await mount(page, 'delayTheme');
  await fixtureState(frame, 'dark-then-light-result');
  for (const selector of ['html', 'body', '#lab']) {
    await expect(frame.locator(selector)).toHaveCSS('background-color', 'rgb(20, 15, 11)');
  }
  await page.screenshot({ path: testInfo.outputPath('approval-lab-dark.png'), fullPage: true });
  await fixtureState(frame, 'light-theme');
  for (const selector of ['html', 'body', '#lab']) {
    await expect(frame.locator(selector)).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  }
  await page.screenshot({ path: testInfo.outputPath('approval-lab-light.png'), fullPage: true });
});

for (const width of [240, 320, 768]) {
  test(`controls and literal results fit at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const frame = await mount(page);
    await frame.getByTestId('content').fill('narrow screen content');
    await frame.getByTestId('send').click();
    expect(await frame.locator('body').evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(frame.getByTestId('send-delayed')).toBeInViewport();
    await expect(frame.locator('.request-content')).toHaveText('narrow screen content');
  });
}

test('relay list captures exact role tags with empty content and a separate development warning', async ({ page }, testInfo) => {
  const frame = await mount(page);
  await frame.getByTestId('content').fill('retained note draft');
  await frame.getByTestId('kind-relay-list').check();
  await expect(frame.getByTestId('relay-list-warning')).toContainText('replaces its advertised relay list');
  await expect(frame.getByTestId('content')).toBeHidden();
  await expect(frame.getByTestId('send-three')).toBeDisabled();
  const tags = [['r', 'wss://relay.damus.io', 'write'], ['r', 'wss://nos.lol', 'read'], ['r', 'wss://purplepag.es']];
  await frame.getByTestId('relay-list-tags').fill(JSON.stringify(tags));
  await frame.getByTestId('send').click();
  await expect(frame.locator('.request')).toHaveAttribute('data-state', 'published');
  const [event] = await fixtureState<any[]>(frame, 'calls');
  expect(event).toEqual({kind: 10002, content: '', tags: [...tags, ['t', 'hypergolic-approval-lab'], ['test-sequence', '1']], created_at: event.created_at});
  expect(await fixtureState(frame, 'frozen')).toEqual([{ event: true, tags: true, entries: true }]);
  await expect(frame.locator('.request-content')).toHaveText(JSON.stringify(event.tags, null, 2));
  await page.screenshot({path: testInfo.outputPath('approval-lab-relay-list.png'), fullPage: true});
  await frame.getByTestId('kind-note').check();
  await expect(frame.getByTestId('content')).toHaveValue('retained note draft');
  await expect(frame.getByTestId('send-three')).toBeEnabled();
});

test('delayed relay list retains captured destinations despite later editor and type changes', async ({ page }) => {
  const frame = await mount(page, 'manualTimers');
  await frame.getByTestId('kind-relay-list').check();
  const tags = [['r', 'wss://nos.lol', 'read']];
  await frame.getByTestId('relay-list-tags').fill(JSON.stringify(tags));
  await frame.getByTestId('send-delayed').click();
  await frame.getByTestId('relay-list-tags').fill('[]');
  await frame.getByTestId('kind-note').check();
  await frame.getByTestId('content').fill('later note');
  expect(await fixtureState(frame, 'calls-length')).toBe(0);
  await fixtureState(frame, 'run-timer');
  await expect(frame.locator('.request')).toHaveAttribute('data-state', 'published');
  const [event] = await fixtureState<any[]>(frame, 'calls');
  expect(event.kind).toBe(10002);
  expect(event.content).toBe('');
  expect(event.tags).toEqual([...tags, ['t', 'hypergolic-approval-lab'], ['test-sequence', '1']]);
});

test('empty relay list is an explicit replaceable publication with no invented destinations', async ({ page }) => {
  const frame = await mount(page);
  await frame.getByTestId('kind-relay-list').check();
  await frame.getByTestId('send').click();
  await expect(frame.locator('.request')).toHaveAttribute('data-state', 'published');
  const [event] = await fixtureState<any[]>(frame, 'calls');
  expect(event.kind).toBe(10002);
  expect(event.content).toBe('');
  expect(event.tags.filter((tag: string[]) => tag[0] === 'r')).toEqual([]);
});

for (const [label, value] of [
  ['malformed JSON', '{'],
  ['wrong root', '{}'],
  ['wrong tag', '[["p", "wss://nos.lol"]]'],
  ['unknown role', '[["r", "wss://nos.lol", "both"]]'],
  ['extra field', '[["r", "wss://nos.lol", "read", "extra"]]'],
  ['insecure URL', '[["r", "ws://nos.lol"]]'],
  ['credential URL', '[["r", "wss://user:password@nos.lol"]]'],
  ['excessive tags', JSON.stringify(Array.from({length:17}, () => ['r', 'wss://nos.lol']))],
]) {
  test(`relay-list ${label} is corrected before any approval request or delayed timer`, async ({ page }) => {
    const frame = await mount(page, 'manualTimers');
    await frame.getByTestId('kind-relay-list').check();
    await frame.getByTestId('relay-list-tags').fill(value);
    await frame.getByTestId('send-delayed').click();
    await expect(frame.getByTestId('relay-list-tags')).toHaveAttribute('aria-invalid', 'true');
    await expect(frame.getByTestId('relay-list-error')).toContainText('Enter a JSON array');
    await expect(frame.getByTestId('relay-list-tags')).toBeFocused();
    expect(await fixtureState(frame, 'calls-length')).toBe(0);
    expect(await fixtureState(frame, 'timer-summary')).toEqual({delays: [], cleared: []});
    await expect(frame.getByTestId('requests')).toHaveText('0');
    await frame.getByTestId('relay-list-tags').fill('[]');
    await expect(frame.getByTestId('relay-list-tags')).not.toHaveAttribute('aria-invalid');
    await frame.getByTestId('send').click();
    await expect(frame.locator('.request')).toHaveAttribute('data-state', 'published');
    const [event] = await fixtureState<any[]>(frame, 'calls');
    expect(event.tags).toContainEqual(['test-sequence', '1']);
  });
}


test('one pending relay list prevents another while ordinary note requests remain available', async ({ page }) => {
  const frame = await mount(page);
  await fixtureState(frame, 'set-defer');
  await frame.getByTestId('kind-relay-list').check();
  await frame.getByTestId('send').click();
  await expect(frame.getByTestId('pending')).toHaveText('1');
  await expect(frame.getByTestId('send')).toBeDisabled();
  await expect(frame.getByTestId('send-delayed')).toBeDisabled();
  await frame.getByTestId('kind-note').check();
  await expect(frame.getByTestId('send')).toBeEnabled();
  await frame.getByTestId('send').click();
  await frame.getByTestId('kind-relay-list').check();
  await expect(frame.getByTestId('send')).toBeDisabled();
  expect((await fixtureState<any[]>(frame, 'calls')).map(event => event.kind)).toEqual([10002, 1]);
  await fixtureState(frame, 'resolve-at', 0);
  await expect(frame.locator('[data-sequence="1"]')).toHaveAttribute('data-state', 'published');
  await expect(frame.getByTestId('send')).toBeEnabled();
  await frame.getByTestId('send').click();
  expect((await fixtureState<any[]>(frame, 'calls')).map(event => event.kind)).toEqual([10002, 1, 10002]);
});
