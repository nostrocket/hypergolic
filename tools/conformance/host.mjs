import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const runtime = new URL('../../runtime/', import.meta.url);
const browsers = createRequire(new URL('package.json', runtime))('@playwright/test');

// Serve only the local build. The guest runs in the real iframe and host bridge.
async function withHost(engine, observe) {
  const browser = await browsers[engine].launch();
  try {
    const page = await browser.newPage();
    const origin = 'https://example.org';
    const assets = new Map();
    for (const [file, contentType] of [['index.html', 'text/html'], ['host.js', 'text/javascript']]) {
      assets.set('/assets/runtime/' + file, {contentType, body: await readFile(new URL('dist/' + file, runtime))});
    }
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      const asset = url.origin === origin && assets.get(url.pathname);
      return asset ? route.fulfill(asset) : route.abort();
    });
    return await observe(page, origin + '/assets/runtime/index.html?sessionId=conformance&fixture=');
  } finally {
    await browser.close();
  }
}

export function observeHost(engine) {
  return withHost(engine, async (page, url) => {
    await page.addInitScript(() => {
      if (window !== window.top) return;
      const messages = [], requests = new Set();
      window.conformanceMessages = messages;
      window.portThemeReply = false;
      window.HypergolicHost = {postMessage() {}};
      window.addEventListener('message', event => {
        if (event.source === document.querySelector('#napplet')?.contentWindow) {
          messages.push({type: event.data?.type, ports: event.ports.length});
          if (event.data?.type !== 'napplet.hello' || event.ports.length !== 1) return;
          const port = event.ports[0];
          port.addEventListener('message', request => {
            if (request.data?.type === 'theme.get') requests.add(request.data.id);
          });
          const send = port.postMessage.bind(port);
          port.postMessage = value => {
            if (value?.type === 'theme.get.result' && value.theme?.colors && requests.has(value.id)) window.portThemeReply = true;
            send(value);
          };
        }
      });
    });
    await page.goto(url + 'ux-lab');
    const iframe = page.locator('#napplet');
    await iframe.contentFrame().getByTestId('lab').waitFor();
    // The fixture asks for its theme on startup. Its successful reply is our observation barrier.
    await browsers.expect(iframe.contentFrame().getByTestId('theme-status')).toHaveText('Host colors');
    const exposesTheme = await iframe.contentFrame().getByTestId('lab').evaluate(() =>
      window.napplet?.shell?.supports('theme') === true && window.napplet?.shell?.supports('relay') === false);
    return await page.evaluate(exposesTheme => ({
      exposesTheme,
      sandbox: document.querySelector('#napplet').getAttribute('sandbox'),
      srcdoc: document.querySelector('#napplet').hasAttribute('srcdoc'),
      messages: window.conformanceMessages, portThemeReply: window.portThemeReply,
    }), exposesTheme);
  });
}

// Hold the optional environment exchange while the guest uses its public API.
export function observeFirstThemeRequest(engine) {
  return withHost(engine, async (page, url) => {
    await page.addInitScript(() => {
      if (window !== window.top) return;
      window.HypergolicHost = {postMessage() {}};
      window.addEventListener('message', event => {
        if (event.source !== document.querySelector('#napplet')?.contentWindow) return;
        if (event.data?.type !== 'napplet.hello' || event.ports.length !== 1) return;
        event.ports[0].addEventListener('message', request => {
          if (request.data?.type === 'shell.ready') {
            request.stopImmediatePropagation();
            window.heldReadiness = true;
          }
        });
      });
    });
    await page.goto(url + 'ux-lab');
    await page.waitForFunction(() => window.heldReadiness === true, undefined, {timeout:5000});
    return page.frameLocator('#napplet').locator('body').evaluate(async () => {
      const api = window.napplet;
      const beforeShellInit = Boolean(api.theme) && api.shell.supports('theme') &&
        !api.shell.supports('relay') && !api.shell.supports('unknown') && api.shell.services.length === 0;
      const theme = await api.theme.get();
      return {beforeShellInit, first: Boolean(theme?.colors) && api.shell.services.length === 0};
    }, undefined, {timeout:5000});
  });
}

export function observeIdentity() {
  return withHost('chromium', async (page, url) => {
    await page.addInitScript(() => {
      if (window !== window.top) return;
      const listeners = new Set();
      window.identityAvailable = true;
      window.reportAccount = (sessionId, pubkey) => {
        const data = JSON.stringify({type:'identity.snapshot', sessionId, pubkey});
        for (const notify of listeners) notify({data});
      };
      window.HypergolicHost = {
        addEventListener: (_type, listener) => listeners.add(listener),
        removeEventListener: (_type, listener) => listeners.delete(listener),
        postMessage(raw) {
          const envelope = JSON.parse(raw);
          if (envelope.type !== 'capability') return;
          const request = JSON.parse(envelope.message);
          const reply = request.type === 'identity.getPublicKey' && window.identityAvailable
            ? {type:'identity.getPublicKey.result', id:request.id, pubkey:'1'.repeat(64)} : null;
          const data = JSON.stringify({type:'capability.result', sessionId:envelope.sessionId,
            sequence:envelope.sequence, response:reply && JSON.stringify(reply)});
          for (const notify of listeners) notify({data});
        },
      };
    });
    await page.goto(url + 'state-lab');
    const identity = page.frameLocator('#napplet').locator('#identity');
    await browsers.expect(identity).toContainText('111111');
    const read = () => identity.evaluate(() => window.napplet.identity.getPublicKey(), undefined, {timeout:5000});
    const account = await read();
    if (account !== '1'.repeat(64)) throw new Error('Connected account control failed');
    await page.evaluate(() => { window.identityAvailable = false; });
    if (await read() !== account) return false;
    await identity.evaluate(() => {
      window.accountChanges = [];
      window.napplet.identity.onChanged(key => window.accountChanges.push(key));
    });
    await page.evaluate(() => {
      window.reportAccount('stale-generation', '');
      window.reportAccount('conformance', 'invalid');
      window.reportAccount('conformance', '');
      window.reportAccount('conformance', '');
    });
    await browsers.expect.poll(() => identity.evaluate(() => window.accountChanges)).toEqual(['']);
    return await read() === '';
  });
}
