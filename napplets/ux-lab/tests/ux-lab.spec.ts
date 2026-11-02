import { test, expect, type Page, type FrameLocator } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
const light = { colors: { background: '#ffffff', text: '#17212b', primary: '#b84421' } };
const dark = { colors: { background: '#140f0b', text: '#f3efeb', primary: '#e8805d' } };
// This is a test-only SDK adapter, not a shell implementation or protocol conformance proof.
function themeAdapter(mode: 'light' | 'reject' | 'delayed'): string {
  return `<script>
    let handler = () => {};
    let resolveInitial;
    window.napplet = { theme: {
      get: () => ${mode === 'reject' ? "Promise.reject(new Error('Unavailable'))" : mode === 'delayed' ? 'new Promise(resolve => { resolveInitial = resolve; })' : 'Promise.resolve(' + JSON.stringify(light) + ')'},
      onChanged: callback => { handler = callback; return { close: () => { handler = () => {}; } }; }
    } };
    window.__fixtureTest = { push: value => handler(value), resolve: value => resolveInitial(value) };
  </script>`;
}
const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'">`;

async function mount(page: Page, adapter = '', instances = 1): Promise<FrameLocator> {
  await page.setContent('<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%;position:fixed;inset:0}[hidden]{display:none!important}</style>');
  const source = html.replace('<head>', '<head>' + csp + adapter);
  await page.evaluate(({ source, instances }) => {
    for (let index = 0; index < instances; index += 1) {
      const frame = document.createElement('iframe');
      frame.id = 'instance-' + index;
      frame.title = 'UX Lab instance ' + (index + 1);
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.hidden = index !== 0;
      frame.srcdoc = source;
      document.body.append(frame);
    }
  }, { source, instances });
  for (let index = 0; index < instances; index += 1) {
    await expect(page.frameLocator('#instance-' + index).getByTestId('lab')).toHaveAttribute('data-ready', 'true');
  }
  return page.frameLocator('#instance-0');
}
async function show(page: Page, index: number): Promise<void> {
  await page.evaluate((index) => {
    document.querySelectorAll('iframe').forEach((frame, i) => { frame.hidden = i !== index; });
  }, index);
}
const verticalPosition = (frame: FrameLocator) => frame.locator('body').evaluate(() => window.scrollY);
const horizontalPosition = (frame: FrameLocator) => frame.getByTestId('rail').evaluate((rail) => rail.scrollLeft);

test('built artifact is single-file, unsigned, capability-free and content-addressed', async () => {
  expect(readdirSync(new URL('../dist', import.meta.url)).sort()).toEqual(['.nip5a-manifest.json', 'index.html']);
  const manifest = JSON.parse(readFileSync(new URL('../dist/.nip5a-manifest.json', import.meta.url), 'utf8'));
  const digest = createHash('sha256').update(html).digest('hex');
  expect(manifest.kind).toBe(35129);
  expect(manifest.tags).toContainEqual(['d', 'ux-lab']);
  expect(manifest.tags.filter((tag: string[]) => tag[0] === 'path')).toEqual([['path', '/index.html', digest]]);
  const aggregate = createHash('sha256').update(digest + ' /index.html\n').digest('hex');
  expect(manifest.tags).toContainEqual(['x', aggregate, 'aggregate']);
  expect(manifest.aggregateHash).toBe(aggregate);
  expect(manifest.tags.filter((tag: string[]) => tag[0] === 'requires')).toEqual([]);
  expect(manifest).not.toHaveProperty('sig');
  expect(manifest).not.toHaveProperty('pubkey');
  expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=|@import|https?:\/\//i);
  expect(html).not.toMatch(/\b(?:fetch|WebSocket|localStorage|sessionStorage|indexedDB)\b|window\.nostr|document\.cookie/);
});

test('controls work without a host and input stays plain text', async ({ page }) => {
  const requests: string[] = [];
  const errors: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  page.on('pageerror', (error) => errors.push(error.message));
  const frame = await mount(page);
  await expect(frame.getByTestId('theme-status')).toHaveText('Local palette · host theme unavailable');
  await frame.getByRole('button', { name: 'Add one' }).click();
  await expect(frame.getByTestId('counter')).toHaveText('1');
  const text = '<img src=x onerror="window.attack=true">\nStill plain text';
  await frame.getByLabel('Your temporary note').fill(text);
  await expect(frame.getByTestId('draft-mirror')).toHaveText(text);
  await expect(frame.locator('img')).toHaveCount(0);
  expect(requests).toEqual([]);
  expect(errors).toEqual([]);
  expect(await frame.locator('body').evaluate(() => {
    try { return window.parent.document.body ? 'accessible' : 'empty'; } catch { return 'denied'; }
  })).toBe('denied');
});

test('three loaded instances retain independent input, selection and scroll when hidden', async ({ page }) => {
  const first = await mount(page, '', 3);
  await first.getByTestId('draft').fill('Instance A keeps this text');
  await first.getByTestId('increment').click();
  await first.getByTestId('marker-7').click();
  const x = await horizontalPosition(first);
  expect(x).toBeGreaterThan(0);
  await first.getByTestId('edge-right-4').click();
  const y = await verticalPosition(first);
  expect(y).toBeGreaterThan(800);
  await show(page, 1);
  const second = page.frameLocator('#instance-1');
  await expect(second.getByTestId('draft')).toHaveValue('');
  await second.getByTestId('draft').fill('B has different text');
  await second.getByTestId('increment').click();
  await second.getByTestId('increment').click();
  await show(page, 2);
  await expect(page.frameLocator('#instance-2').getByTestId('counter')).toHaveText('0');
  await show(page, 0);
  expect(await verticalPosition(first)).toBe(y);
  expect(await horizontalPosition(first)).toBe(x);
  await expect(first.getByTestId('counter')).toHaveText('1');
  await expect(first.getByTestId('draft')).toHaveValue('Instance A keeps this text');
  await expect(first.getByTestId('selected')).toHaveText('07');
  await expect(first.getByTestId('edge')).toHaveText('Right / 04');
  await show(page, 1);
  await expect(second.getByTestId('counter')).toHaveText('2');
  await expect(second.getByTestId('draft')).toHaveValue('B has different text');
});

test('removing and recreating an instance resets its temporary state', async ({ page }) => {
  const frame = await mount(page);
  await frame.getByTestId('draft').fill('Close this draft');
  await frame.getByTestId('increment').click();
  await frame.getByTestId('marker-9').click();
  await page.evaluate(() => {
    const previous = document.querySelector('iframe')!;
    const fresh = previous.cloneNode() as HTMLIFrameElement;
    previous.replaceWith(fresh);
  });
  await expect(frame.getByTestId('lab')).toHaveAttribute('data-ready', 'true');
  await expect(frame.getByTestId('counter')).toHaveText('0');
  await expect(frame.getByTestId('draft')).toHaveValue('');
  await expect(frame.getByTestId('selected')).toHaveText('None');
  expect(await verticalPosition(frame)).toBe(0);
  expect(await horizontalPosition(frame)).toBe(0);
});

test('explicit reset clears controls and both scroll axes without recreating the frame', async ({ page }) => {
  const frame = await mount(page);
  await frame.getByTestId('increment').click();
  await frame.getByTestId('draft').fill('Reset me');
  await frame.getByTestId('marker-8').click();
  await frame.getByTestId('edge-left-3').click();
  await frame.getByTestId('reset').click();
  await expect(frame.getByTestId('ready')).toHaveText('Ready · instance reset');
  await expect(frame.getByTestId('draft')).toHaveValue('');
  await expect(frame.getByTestId('counter')).toHaveText('0');
  await expect(frame.getByTestId('edge')).toHaveText('None');
  await expect(frame.getByTestId('selected')).toHaveText('None');
  expect(await verticalPosition(frame)).toBe(0);
  expect(await horizontalPosition(frame)).toBe(0);
  await expect(frame.getByTestId('increment')).toBeFocused();
});

test('real wheel input scrolls each axis and keyboard controls remain operable', async ({ page }) => {
  const frame = await mount(page);
  await frame.getByTestId('increment').focus();
  await page.keyboard.press('Enter');
  await expect(frame.getByTestId('counter')).toHaveText('1');
  await page.keyboard.press('Tab');
  await expect(frame.getByTestId('draft')).toBeFocused();
  await page.keyboard.type('Keyboard input');
  await expect(frame.getByTestId('draft')).toHaveValue('Keyboard input');
  await frame.getByTestId('rail').scrollIntoViewIfNeeded();
  const rail = await frame.getByTestId('rail').boundingBox();
  await page.mouse.move(rail!.x + rail!.width / 2, rail!.y + rail!.height / 2);
  await page.mouse.wheel(300, 0);
  await expect.poll(() => horizontalPosition(frame)).toBeGreaterThan(100);
  const before = await verticalPosition(frame);
  await page.mouse.move(10, 400);
  await page.mouse.wheel(0, 500);
  await expect.poll(() => verticalPosition(frame)).toBeGreaterThan(before + 100);
});

test('theme colors cover the page and controls, then update without losing input', async ({ page }, info) => {
  const frame = await mount(page, themeAdapter('light'));
  await expect(frame.getByTestId('theme-status')).toHaveText('Host colors');
  await expect(frame.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(frame.getByTestId('draft')).toHaveCSS('color', 'rgb(23, 33, 43)');
  await frame.getByTestId('draft').fill('Retained across themes');
  await page.screenshot({ path: info.outputPath('ux-lab-light.png') });
  await frame.locator('body').evaluate((_, value) => (window as any).__fixtureTest.push(value), dark);
  await expect(frame.locator('body')).toHaveCSS('background-color', 'rgb(20, 15, 11)');
  await expect(frame.getByTestId('draft')).toHaveCSS('color', 'rgb(243, 239, 235)');
  await expect(frame.getByTestId('draft')).toHaveValue('Retained across themes');
  await page.screenshot({ path: info.outputPath('ux-lab-dark.png') });
});

test('unavailable or malformed theme falls back without breaking controls', async ({ page }) => {
  const frame = await mount(page, themeAdapter('reject'));
  await expect(frame.getByTestId('theme-status')).toContainText('unavailable');
  await frame.locator('body').evaluate(() => (window as any).__fixtureTest.push({ colors: { background: 'url(https://invalid.test)', text: '#000', primary: '#fff' } }));
  await expect(frame.getByTestId('theme-status')).toContainText('invalid host colors');
  await expect(frame.locator('body')).toHaveCSS('background-color', 'rgb(20, 15, 11)');
  await frame.getByTestId('increment').click();
  await expect(frame.getByTestId('counter')).toHaveText('1');
});

test('a delayed initial theme cannot overwrite a newer pushed theme', async ({ page }) => {
  const frame = await mount(page, themeAdapter('delayed'));
  await frame.locator('body').evaluate((_, value) => {
    (window as any).__fixtureTest.push(value);
    (window as any).__fixtureTest.resolve({ colors: { background: '#ffffff', text: '#000000', primary: '#112233' } });
  }, dark);
  await expect(frame.locator('body')).toHaveCSS('background-color', 'rgb(20, 15, 11)');
  await expect(frame.getByTestId('theme-status')).toHaveText('Host colors');
});

for (const width of [240, 320, 768]) {
  test('layout stays contained at width ' + width + ' with reduced motion', async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const frame = await mount(page);
    expect(await frame.locator('body').evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await frame.getByTestId('draft').fill('x'.repeat(500));
    expect(await frame.locator('body').evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    for (const id of ['increment', 'draft', 'marker-1', 'edge-left-1', 'reset']) {
      const size = await frame.getByTestId(id).boundingBox();
      expect(size!.height).toBeGreaterThanOrEqual(48);
      expect(size!.width).toBeGreaterThanOrEqual(48);
    }
  });
}
