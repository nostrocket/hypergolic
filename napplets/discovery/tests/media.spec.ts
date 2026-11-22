import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
const event = JSON.parse(readFileSync(new URL('./media-fixtures/battleship.json', import.meta.url), 'utf8'));
const png = readFileSync(new URL('./media-fixtures/battleship.png', import.meta.url)).toString('base64');
const hash = event.tags.find((tag: string[]) => tag[0] === 'icon')[1];

test('real Battleship artwork appears in feed and detail through the safe Resource proxy', async ({ page }) => {
  const external: string[] = [];
  await page.route(/^https?:/, route => {
    if (route.request().url() === 'https://fixture.test/') return route.fulfill({ contentType: 'text/html', body: html });
    external.push(route.request().url());
    return route.abort();
  });
  await page.addInitScript(({ event, png, hash }) => {
    const shell = window as Window & Record<string, unknown>;
    const urls: string[] = [];
    shell.mediaFixture = { urls };
    shell.napplet = {
      shell: { ready: async () => {} },
      relay: { query: async (filters: { kinds: number[] }[]) => filters[0]?.kinds[0] === 35129 ? [{ event }] : [] },
      resource: { bytes: async (url: string) => {
        urls.push(url);
        // Exactly the live publisher mirror works; all configured Blossom defaults lack this icon.
        if (url !== `https://cdn.hzrd149.com/${hash}`) throw new Error('Not found');
        return new Blob([Uint8Array.from(atob(png), char => char.charCodeAt(0))], { type: 'image/png' });
      } },
    };
  }, { event, png, hash });
  await page.goto('https://fixture.test/');
  const rowImage = page.locator('#results .app-icon img');
  await expect(rowImage).toBeVisible();
  await expect(rowImage).toHaveAttribute('src', /^blob:/);
  await expect(rowImage).toHaveJSProperty('naturalWidth', 512);
  await page.getByRole('button', { name: 'Details for Battleship', exact: true }).click();
  const detailImage = page.locator('.app-icon-large img');
  await expect(detailImage).toBeVisible();
  await expect(detailImage).toHaveAttribute('src', /^blob:/);
  await expect(detailImage).toHaveJSProperty('naturalWidth', 512);
  const calls = await page.evaluate(() => (window as any).mediaFixture.urls as string[]);
  expect(calls.filter(url => url.endsWith(hash))).toEqual([
    `https://cdn.hzrd149.com/${hash}`, `https://cdn.hzrd149.com/${hash}`,
  ]);
  expect(external).toEqual([]);
});
