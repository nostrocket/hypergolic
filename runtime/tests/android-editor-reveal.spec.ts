import {expect, test, type Locator, type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';

const androidOrigin = 'https://appassets.androidplatform.net';
const portrait = {width: 390, height: 480};
const landscapeWithKeyboard = {width: 900, height: 78};
const assets = {
  'index.html': readFileSync(new URL('../dist/index.html', import.meta.url)),
  'host.js': readFileSync(new URL('../dist/host.js', import.meta.url)),
};
type ProbeWindow = Window & {nativeCalls?: string[]; editorReveals?: string[]; HypergolicHost?: object};

async function openRoutingLab(page: Page, origin = androidOrigin) {
  await page.setViewportSize(portrait);
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/assets/runtime/index.html') {
      return route.fulfill({body: assets['index.html'], contentType: 'text/html'});
    }
    if (url.pathname === '/assets/runtime/host.js') {
      return route.fulfill({body: assets['host.js'], contentType: 'text/javascript'});
    }
    return route.abort();
  });
  await page.addInitScript(() => {
    const root = window as ProbeWindow;
    if (window !== top) {
      root.editorReveals = [];
      const scroll = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function(options) {
        root.editorReveals!.push(this.id);
        return scroll.call(this, options);
      };
      return;
    }
    const listeners = new Set<(event: {data: string}) => void>();
    root.nativeCalls = [];
    root.HypergolicHost = {
      addEventListener: (_type: string, callback: (event: {data: string}) => void) => listeners.add(callback),
      removeEventListener: (_type: string, callback: (event: {data: string}) => void) => listeners.delete(callback),
      postMessage(raw: string) {
        const envelope = JSON.parse(raw);
        root.nativeCalls!.push(envelope.type);
        if (envelope.type !== 'capability') return;
        const request = JSON.parse(envelope.message);
        const data = JSON.stringify({type: 'capability.result', sessionId: envelope.sessionId, sequence: envelope.sequence,
          response: JSON.stringify({type: 'routing.call.result', id: request.id, response: null})});
        for (const listener of listeners) listener({data});
      },
    };
  });
  await page.goto(origin + '/assets/runtime/index.html?sessionId=ime-browser&fixture=routing-lab');
  const guest = page.frameLocator('#napplet');
  await expect(guest.locator('#lab')).toHaveAttribute('data-ready', 'true');
  return guest.locator('#action');
}

const frames = (field: Locator) => field.evaluate(() =>
  new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const position = (field: Locator) => field.evaluate(element =>
  scrollBy(0, element.getBoundingClientRect().top - 219));
const snapshot = (field: Locator) => field.evaluate(element => {
  const input = element as HTMLInputElement;
  const bounds = input.getBoundingClientRect();
  let parentReadable = true;
  try {void parent.document;} catch {parentReadable = false;}
  return {top: bounds.top, bottom: bounds.bottom, height: innerHeight, value: input.value,
    selection: [input.selectionStart, input.selectionEnd], focused: input === document.activeElement && document.hasFocus(),
    calls: (window as ProbeWindow).editorReveals!, parentReadable};
});

test('the Android guest reveals a focused editor after rotation and preserves focus and selection', async ({page, browserName}) => {
  const action = await openRoutingLab(page);
  await action.fill('open7');
  await action.evaluate(element => (element as HTMLInputElement).setSelectionRange(1, 4));
  await position(action);
  const before = await snapshot(action);
  expect(before).toMatchObject({focused: true, value: 'open7', selection: [1, 4], parentReadable: false, calls: []});
  expect(before.top).toBeGreaterThan(200);
  expect(before.bottom).toBeLessThan(before.height);
  const nativeCalls = await page.evaluate(() => (window as ProbeWindow).nativeCalls);

  await page.setViewportSize(landscapeWithKeyboard);
  await frames(action);
  const shrunk = await snapshot(action);
  expect(shrunk).toMatchObject({focused: true, value: 'open7', selection: [1, 4], parentReadable: false});
  expect(shrunk.top).toBeGreaterThanOrEqual(-1);
  expect(shrunk.bottom).toBeLessThanOrEqual(shrunk.height + 1);
  if (browserName === 'chromium') expect(shrunk.calls).toEqual(['action']);
  else expect(shrunk.calls.length).toBeLessThanOrEqual(1);

  await page.setViewportSize({width: 900, height: 315});
  await frames(action);
  expect((await snapshot(action)).calls).toEqual(shrunk.calls);
  await position(action);
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.style.position = 'absolute';
    button.style.top = '0';
    document.body.append(button);
    button.focus();
  });
  await page.setViewportSize(landscapeWithKeyboard);
  await frames(action);
  expect(await snapshot(action)).toMatchObject({focused: false, calls: shrunk.calls});
  await expect(page.locator('#napplet')).toHaveAttribute('sandbox', 'allow-scripts');
  expect(await page.evaluate(() => ({calls: (window as ProbeWindow).nativeCalls, scrollY})))
    .toEqual({calls: nativeCalls, scrollY: 0});
});

test('the reveal ignores synthetic shrink and an editor replaced before its animation frame', async ({page}) => {
  const action = await openRoutingLab(page);
  await action.fill('open7');
  await position(action);
  await action.evaluate(async () => {
    const original = Object.getOwnPropertyDescriptor(window, 'innerHeight');
    Object.defineProperty(window, 'innerHeight', {value: 78, configurable: true});
    dispatchEvent(new Event('resize'));
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    if (original) Object.defineProperty(window, 'innerHeight', original);
    else Reflect.deleteProperty(window, 'innerHeight');
  });
  expect((await snapshot(action)).calls).toEqual([]);

  await action.evaluate(field => {
    window.addEventListener('resize', () => {
      const replacement = field.cloneNode() as HTMLInputElement;
      field.replaceWith(replacement);
      replacement.focus({preventScroll: true});
    }, {once: true});
  });
  await page.setViewportSize(landscapeWithKeyboard);
  await frames(action);
  expect(await snapshot(action)).toMatchObject({focused: true, value: 'open7', calls: []});
});

test('readonly, file, disabled and hidden inputs do not receive a reveal', async ({page}) => {
  const action = await openRoutingLab(page);
  for (const kind of ['readonly', 'file', 'disabled', 'hidden']) {
    await page.setViewportSize(portrait);
    await action.evaluate((element, mode) => {
      const input = element as HTMLInputElement;
      input.disabled = false;
      input.readOnly = mode === 'readonly';
      input.type = mode === 'file' ? 'file' : 'text';
      input.style.opacity = mode === 'hidden' ? '0' : '1';
      input.focus({preventScroll: true});
      if (mode === 'disabled') input.disabled = true;
    }, kind);
    await position(action);
    await frames(action);
    await page.setViewportSize(landscapeWithKeyboard);
    await frames(action);
    expect((await snapshot(action)).calls).toEqual([]);
  }
});

test('the runtime omits the helper on a different secure origin', async ({page, browserName}) => {
  const action = await openRoutingLab(page, 'https://appassets.androidplatform.net.example.test');
  await action.fill('open7');
  await position(action);
  await page.setViewportSize(landscapeWithKeyboard);
  await frames(action);
  const shrunk = await snapshot(action);
  expect(shrunk.calls).toEqual([]);
  if (browserName === 'chromium') expect(shrunk.top).toBeGreaterThan(shrunk.height);
});
