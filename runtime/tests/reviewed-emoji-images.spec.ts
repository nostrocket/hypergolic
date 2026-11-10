import {test, expect, type Page} from '@playwright/test';
import {injectEmojiImages} from '../src/reviewed-emoji-images';

const pin = {published:true, appId:'emoji-browser', aggregateHash:'24b16ab3eb550d50eff01a3c42c6e56c3a81da4cf6914b11dc766d8575767381'};
const document = '<head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; img-src blob:; connect-src blob:"></head><body data-fixture-ready></body>';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

async function open(page: Page) {
  await page.setContent('<iframe sandbox="allow-scripts"></iframe>');
  await page.locator('iframe').evaluate((frame: HTMLIFrameElement, html) => {frame.srcdoc = html;}, injectEmojiImages(document, pin));
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('body[data-fixture-ready]')).toBeAttached();
  return frame;
}

test('retry revocation keeps all pending images usable until their last DOM reference disappears', async ({page}) => {
  const frame = await open(page);
  const urls = await frame.locator('body').evaluate((body, png) => {
    const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));
    return Array.from({length:6}, () => {
      const url = URL.createObjectURL(new Blob([bytes], {type:'image/png'}));
      const img = document.createElement('img');
      img.src = url;
      body.append(img);
      // The publisher refreshes its cache while these images are still loading.
      URL.revokeObjectURL(url);
      return url;
    });
  }, png);
  await expect.poll(() => frame.locator('img').evaluateAll(images => images.filter(image => image.complete && image.naturalWidth > 0).length)).toBe(6);
  // A resolved hidden image becomes a visible card in the same render turn.
  await frame.locator('body').evaluate(body => {
    for (const image of body.querySelectorAll('img')) image.replaceWith(image.cloneNode());
  });
  await expect.poll(() => frame.locator('img').evaluateAll(images => images.filter(image => image.complete && image.naturalWidth > 0).length)).toBe(6);
  const readable = () => frame.locator('body').evaluate(async (_body, urls) => Promise.all(urls.map(url => fetch(url).then(response => response.ok, () => false))), urls);
  expect(await readable()).toEqual(Array(6).fill(true));
  await frame.locator('body').evaluate(body => body.replaceChildren());
  await expect.poll(readable).toEqual(Array(6).fill(false));
});

test('changing an image source releases its deferred URL and unused URLs revoke immediately', async ({page}) => {
  const frame = await open(page);
  const urls = await frame.locator('body').evaluate((body, png) => {
    const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));
    const old = URL.createObjectURL(new Blob([bytes], {type:'image/png'}));
    const next = URL.createObjectURL(new Blob([bytes], {type:'image/png'}));
    const unused = URL.createObjectURL(new Blob([bytes], {type:'image/png'}));
    const img = document.createElement('img');
    img.src = old; body.append(img);
    URL.revokeObjectURL(old); URL.revokeObjectURL(old); URL.revokeObjectURL(unused);
    img.src = next;
    return {old, next, unused};
  }, png);
  await expect.poll(() => frame.locator('body').evaluate(async (_body, urls) => Promise.all([urls.old, urls.next, urls.unused].map(url => fetch(url).then(response => response.ok, () => false))), urls)).toEqual([false, true, false]);
  await expect.poll(() => frame.locator('img').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
});

test('only the exact published Emoji Browser receives image lifetime compatibility', () => {
  for (const metadata of [{...pin, published:false}, {...pin, appId:'other'}, {...pin, aggregateHash:'f'.repeat(64)}]) {
    expect(injectEmojiImages(document, metadata)).toBe(document);
  }
  expect(() => injectEmojiImages('<body></body>', pin)).toThrow('host CSP');
  const injected = injectEmojiImages(document, pin);
  expect(injected).toContain(document.match(/<meta[^>]+>/)![0]);
  expect(injected).toContain('data-hypergolic-emoji-images');
});
