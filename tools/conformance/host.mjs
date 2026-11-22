import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const runtime = new URL('../../runtime/', import.meta.url);
const browsers = createRequire(new URL('package.json', runtime))('@playwright/test');

// Serve only the local build. The guest runs in the real iframe and host bridge.
export async function observeHost(engine) {
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
    await page.goto(origin + '/assets/runtime/index.html?sessionId=conformance&fixture=ux-lab');
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
  } finally {
    await browser.close();
  }
}
