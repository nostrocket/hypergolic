import {test, expect, type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const generation = '12345678-1234-4234-8234-123456789abc';
const html = readFileSync('fixtures/close-lab.html');
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
async function open(page: Page, published = false, fixture = 'close-lab') {
  await page.addInitScript(({html, generation, hash, version}) => {
    if (window !== window.top) return;
    const state = window as any; state.__closeResults = []; state.__ready = false;
    const listeners = new Set<(event: {data: string}) => void>();
    Object.defineProperty(window, 'HypergolicHost', {value: {
      addEventListener: (_: string, listener: (event: {data: string}) => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: (event: {data: string}) => void) => listeners.delete(listener),
      postMessage: (raw: string) => {
        const message = JSON.parse(raw);
        if (message.type === 'ready') state.__ready = true;
        if (message.type === 'close-check.result') state.__closeResults.push(message);
        if (message.type === 'artifact.read') {
          const envelope = {type: 'artifact.chunk', sessionId: generation, sequence: message.sequence, base64: html,
            byteLength: atob(html).length, totalBytes: atob(html).length, publisher: '1'.repeat(64), appId: 'close-test', eventId: '2'.repeat(64),
            version, htmlHash: hash, domains: ['theme'], done: true};
          for (const listener of listeners) listener({data: JSON.stringify(envelope)});
        }
      }
    }});
  }, {html: html.toString('base64'), generation, hash: digest(html), version: digest(`${digest(html)} /index.html\n`)});
  await page.goto(`/assets/runtime/index.html?sessionId=${generation}${published ? '&source=published' : `&fixture=${fixture}`}`);
  await expect.poll(() => page.evaluate(() => (window as any).__ready)).toBe(true);
  return page.locator('#napplet').contentFrame();
}
async function request(page: Page, id: string) { await page.evaluate(id => window.postMessage({type: 'hypergolic.close-check.request', id}, '*'), id); }
const results = (page: Page) => page.evaluate(() => (window as any).__closeResults);
for (const published of [false, true]) test(`${published ? 'verified artifact' : 'bundled'} Close Lab reports real draft state and unknown`, async ({page}) => {
  const frame = await open(page, published);
  await request(page, 'clean'); await expect.poll(() => results(page)).toContainEqual({type: 'close-check.result', sessionId: generation, id: 'clean', state: 'clean'});
  await frame.locator('#draft').fill('retain my work');
  await request(page, 'dirty'); await expect.poll(() => results(page)).toContainEqual({type: 'close-check.result', sessionId: generation, id: 'dirty', state: 'dirty'});
  await frame.locator('#mode').selectOption('unknown'); await request(page, 'unknown'); await expect.poll(() => results(page)).toContainEqual({type: 'close-check.result', sessionId: generation, id: 'unknown', state: 'unknown'});
  await expect(frame.locator('#draft')).toHaveValue('retain my work');
});
test('silent and unsupported guests time out to unknown', async ({page}) => {
  const frame = await open(page); await frame.locator('#mode').selectOption('silent'); await request(page, 'silent');
  await expect.poll(() => results(page)).toContainEqual({type: 'close-check.result', sessionId: generation, id: 'silent', state: 'unknown'});
  await open(page, false, 'ux-lab'); await request(page, 'unsupported');
  await expect.poll(() => results(page)).toContainEqual({type: 'close-check.result', sessionId: generation, id: 'unsupported', state: 'unknown'});
});
test('guest cannot forge a trusted control and sibling cannot report clean', async ({page}) => {
  const frame = await open(page); await frame.locator('#mode').selectOption('silent');
  await frame.locator('body').evaluate(() => window.parent.postMessage({type: 'hypergolic.close-check.request', id: 'forged'}, '*'));
  await page.waitForTimeout(550); expect(await results(page)).toEqual([]);
  await request(page, 'sibling');
  await page.evaluate(() => { const sibling = document.createElement('iframe'); sibling.srcdoc = `<script>parent.postMessage({type:'hypergolic.closeCheck.result',id:'sibling',state:'clean'},'*')<\/script>`; document.body.append(sibling); });
  await expect.poll(() => results(page)).toContainEqual({type: 'close-check.result', sessionId: generation, id: 'sibling', state: 'unknown'});
});
test('malformed reply cannot report clean and replay cannot resolve a new check', async ({page}) => {
  const frame = await open(page); await frame.locator('#mode').selectOption('silent'); await request(page, 'malformed');
  await frame.locator('body').evaluate(() => window.parent.postMessage({type: 'hypergolic.closeCheck.result', id: 'malformed', state: 'clean', epoch: 1}, '*'));
  await expect.poll(() => results(page)).toContainEqual({type: 'close-check.result', sessionId: generation, id: 'malformed', state: 'unknown'});
  await request(page, 'next'); await frame.locator('body').evaluate(() => window.parent.postMessage({type: 'hypergolic.closeCheck.result', id: 'malformed', state: 'clean'}, '*'));
  await expect.poll(() => results(page)).toContainEqual({type: 'close-check.result', sessionId: generation, id: 'next', state: 'unknown'});
});
