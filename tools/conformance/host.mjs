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
      const messages = [];
      window.conformanceMessages = messages;
      window.HypergolicHost = {postMessage() {}};
      window.addEventListener('message', event => {
        if (event.source === document.querySelector('#napplet')?.contentWindow) {
          messages.push({type: event.data?.type, ports: event.ports.length});
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
      messages: window.conformanceMessages,
    }), exposesTheme);
  });
}

export function observeIdentity() {
  return withHost('chromium', async (page, url) => {
    await page.addInitScript(() => {
      if (window !== window.top) return;
      const listeners = new Set();
      window.identityAvailable = true;
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
    return await read() === account;
  });
}
