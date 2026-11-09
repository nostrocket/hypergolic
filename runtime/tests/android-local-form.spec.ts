import {expect, test, type Locator, type Page} from '@playwright/test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';

const androidOrigin = 'https://appassets.androidplatform.net';
const otherOrigin = 'https://appassets.androidplatform.net.example.test';
const files = {
  'index.html': readFileSync(new URL('../dist/index.html', import.meta.url)),
  'host.js': readFileSync(new URL('../dist/host.js', import.meta.url)),
};
const generation = '12345678-1234-1234-1234-123456789abc';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const recorder = `<output id="count">0</output><output id="last"></output><script>
  document.addEventListener('submit', event => {
    const count = document.querySelector('#count');
    count.value = String(Number(count.value) + 1);
    document.querySelector('#last').value = JSON.stringify({
      submitter: event.submitter?.id, trusted: event.isTrusted, bubbles: event.bubbles, cancelable: event.cancelable,
    });
    event.preventDefault();
  });
</script>`;
const localForm = `<form id="draft">
  <input aria-label="Title" required value="A draft">
  <button type="submit" id="save"><span>Save</span></button>
</form>`;

async function open(page: Page, body: string, origin = androidOrigin) {
  const html = `<!doctype html><html lang="en"><head><title>Local form fixture</title></head><body>${body}</body></html>`;
  const egress: string[] = [];
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin && url.pathname === '/assets/runtime/index.html') {
      return route.fulfill({body: files['index.html'], contentType: 'text/html'});
    }
    if (url.origin === origin && url.pathname === '/assets/runtime/host.js') {
      return route.fulfill({body: files['host.js'], contentType: 'text/javascript'});
    }
    egress.push(`${route.request().method()} ${url.origin}${url.pathname}`);
    return route.abort();
  });
  const htmlHash = digest(html);
  await page.addInitScript(({generation, base64, byteLength, htmlHash, version}) => {
    if (window !== top) return;
    const listeners = new Set<(event: {data: string}) => void>();
    const nativeCalls: string[] = [];
    Object.defineProperties(window, {
      nativeCalls: {value: nativeCalls},
      HypergolicHost: {value: {
        addEventListener: (_type: string, listener: (event: {data: string}) => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: (event: {data: string}) => void) => listeners.delete(listener),
        postMessage(raw: string) {
          const request = JSON.parse(raw);
          nativeCalls.push(request.type);
          if (request.type !== 'artifact.read') return;
          const data = JSON.stringify({type: 'artifact.chunk', sessionId: generation,
            sequence: request.sequence, base64, byteLength, totalBytes: byteLength, done: true,
            publisher: '1'.repeat(64), eventId: '2'.repeat(64), appId: 'local-form', htmlHash, version, domains: []});
          for (const listener of listeners) listener({data});
        },
      }},
    });
  }, {generation, base64: Buffer.from(html).toString('base64'), byteLength: Buffer.byteLength(html),
    htmlHash, version: digest(`${htmlHash} /index.html\n`)});
  await page.goto(origin + `/assets/runtime/index.html?sessionId=${generation}&source=published`);
  const frame = page.frameLocator('#napplet');
  await expect(frame.locator('body')).toBeVisible();
  await expect(page.locator('#napplet')).toHaveAttribute('sandbox', 'allow-scripts');
  return {frame, egress};
}

const afterActivation = (locator: Locator) => locator.evaluate(() =>
  new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

function callTrace(page: Page) {
  return page.evaluate(() => (window as Window & {nativeCalls?: string[]}).nativeCalls);
}

test('explicit click and implicit Enter each deliver one local submit with the same submitter', async ({page, browserName}) => {
  const {frame, egress} = await open(page, localForm + recorder);
  const calls = await callTrace(page);
  await frame.getByText('Save', {exact: true}).click();
  await expect(frame.locator('#count')).toHaveText('1');
  await frame.getByLabel('Title').press('Enter');
  await expect(frame.locator('#count')).toHaveText('2');
  await afterActivation(frame.locator('#count'));
  await expect(frame.locator('#count')).toHaveText('2');
  await expect(frame.locator('#last')).toHaveText(JSON.stringify({
    submitter: 'save', trusted: browserName === 'webkit', bubbles: true, cancelable: true,
  }));
  expect(await callTrace(page)).toEqual(calls);
  expect(egress).toEqual([]);
});

test('the helper is absent on other hosts and normal WebKit submits once', async ({page, browserName}) => {
  const {frame, egress} = await open(page, localForm + recorder, otherOrigin);
  await frame.getByRole('button', {name: 'Save'}).click();
  await afterActivation(frame.locator('#count'));
  await expect(frame.locator('#count')).toHaveText(browserName === 'webkit' ? '1' : '0');
  expect(egress).toEqual([]);
});

test('invalid, cancelled, disabled and disconnected forms do not submit', async ({page, browserName}) => {
  test.skip(browserName !== 'chromium', 'Exercises the Chromium submit compatibility branch');
  const {frame, egress} = await open(page, `${localForm}
    <form><button id="disabled" type="submit" disabled>Disabled</button></form>
    <form><button id="disconnect" type="submit">Disconnect</button></form>
    <script>
      window.addEventListener('click', event => {
        if (event.target.closest('#save') && document.body.dataset.cancel) event.preventDefault();
      });
      document.querySelector('#disconnect').addEventListener('click', event => event.target.form.remove());
    </script>${recorder}`);
  const save = frame.getByRole('button', {name: 'Save'});
  const title = frame.getByLabel('Title');
  const count = frame.locator('#count');
  await title.fill('');
  await save.click();
  await afterActivation(count);
  await expect(count).toHaveText('0');
  await title.fill('Ready');
  await title.evaluate(() => { document.body.dataset.cancel = 'true'; });
  await save.click();
  await frame.getByRole('button', {name: 'Disabled'}).click({force: true});
  await frame.getByRole('button', {name: 'Disconnect'}).click();
  await afterActivation(count);
  await expect(count).toHaveText('0');
  expect(egress).toEqual([]);
});

test('author submit and other controls are never given a second submit', async ({page, browserName}) => {
  test.skip(browserName !== 'chromium', 'Exercises the Chromium submit compatibility branch');
  const {frame} = await open(page, `<form id="draft">
    <button type="submit" id="save">Save</button><button type="button" id="other">Other</button>
    <textarea aria-label="Body"></textarea><select aria-label="Category"><option>One</option></select>
    <input aria-label="File" type="file">
  </form>${recorder}`);
  const count = frame.locator('#count');
  const save = frame.getByRole('button', {name: 'Save'});
  await save.evaluate(element => (element as HTMLElement).click());
  await frame.getByRole('button', {name: 'Other'}).click();
  const body = frame.getByLabel('Body');
  await body.fill('line');
  await body.press('Enter');
  await expect(body).toHaveValue('line\n');
  await frame.getByLabel('Category').press('Enter');
  await frame.getByLabel('Category').press('Escape');
  const chooser = page.waitForEvent('filechooser');
  await frame.getByLabel('File').press('Enter');
  expect((await chooser).isMultiple()).toBe(false);
  await afterActivation(count);
  await expect(count).toHaveText('0');
  await save.evaluate(element => {
    const button = element as HTMLButtonElement;
    button.addEventListener('click', () => {
      button.form!.dispatchEvent(new SubmitEvent('submit', {bubbles: true, cancelable: true, submitter: button}));
    });
  });
  await save.click();
  await expect(count).toHaveText('1');
  await afterActivation(count);
  await expect(count).toHaveText('1');
});

test('programmatic and navigation-bearing forms stay sandboxed', async ({page, browserName}) => {
  test.skip(browserName !== 'chromium', 'Exercises Chromium sandbox enforcement');
  const {frame, egress} = await open(page, `${localForm}
    <form id="external" method="post" action="${androidOrigin}/form-egress" target="_top">
      <input name="canary" value="local-only"><button type="submit">External</button>
    </form>${recorder}`);
  const save = frame.getByRole('button', {name: 'Save'});
  await save.evaluate(element => {
    const form = (element as HTMLButtonElement).form!;
    form.requestSubmit();
    form.submit();
  });
  const external = frame.getByRole('button', {name: 'External'});
  await external.click();
  await external.evaluate(element => (element as HTMLButtonElement).form!.submit());
  await afterActivation(frame.locator('#count'));
  await expect(frame.locator('#count')).toHaveText('0');
  await expect(frame.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content', /form-action 'none'/);
  expect(egress).toEqual([]);
});


test('a queued local submit is suppressed when focus leaves the guest', async ({page, browserName}) => {
  test.skip(browserName !== 'chromium', 'Exercises the Chromium submit compatibility branch');
  await page.addInitScript(() => {
    if (window === top) return;
    const timers: (() => void)[] = [];
    const set = window.setTimeout.bind(window);
    const control = {hold: false, timers};
    Object.defineProperty(window, 'formTimerControl', {value: control});
    window.setTimeout = (handler: TimerHandler, delay?: number, ...args: unknown[]): number => {
      if (control.hold && delay === 0 && typeof handler === 'function') {
        timers.push(() => handler(...args));
        return 1;
      }
      return set(handler, delay, ...args);
    };
  });
  type GuestWindow = Window & {formTimerControl: {hold: boolean; timers: (() => void)[]}};
  const {frame, egress} = await open(page, localForm + recorder);
  const count = frame.locator('#count');
  await count.evaluate(() => { (window as GuestWindow).formTimerControl.hold = true; });
  await frame.getByRole('button', {name: 'Save'}).click();
  expect(await count.evaluate(() => ({
    focused: document.hasFocus(), queued: (window as GuestWindow).formTimerControl.timers.length,
  }))).toEqual({focused: true, queued: 1});
  await page.evaluate(() => {
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
  });
  expect(await count.evaluate(() => {
    const {timers} = (window as GuestWindow).formTimerControl;
    timers.shift()!();
    return document.hasFocus();
  })).toBe(false);
  await expect(count).toHaveText('0');
  expect(egress).toEqual([]);
});
