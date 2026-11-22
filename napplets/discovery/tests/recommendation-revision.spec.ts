import {readFileSync} from 'node:fs';
import {expect, test} from '@playwright/test';
import {finalizeEvent} from 'nostr-tools/pure';
import {clock, manifest} from './fixtures.ts';

declare global {
  interface Window {
    revisionTest: {release?: () => void; opens: string[]};
  }
}

const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
const original = manifest({title: 'Original release', timestamp: clock - 20});
const recent = Array.from({length: 8}, (_, i) =>
  manifest({d: 'recent-' + i, title: 'Recent ' + i, timestamp: clock - i}));
const recommendation = finalizeEvent({
  kind: 30267, created_at: clock, content: '',
  tags: [['d', 'napplets'], ['a', '35129:' + original.pubkey + ':shared']],
}, new Uint8Array(32).fill(3));

for (const change of ['conflicting', 'newer'] as const) {
  test(`a delayed ${change} recommendation revision prevents opening the earlier paged release`, async ({page}) => {
    const replacement = manifest({title: 'Other release', timestamp: original.created_at + (change === 'newer' ? 1 : 0)});
    await page.route('https://fixture.test/', route => route.fulfill({contentType: 'text/html', body: html}));
    await page.addInitScript(({original, replacement, recent, recommendation}) => {
      window.revisionTest = {opens: []};
      Object.assign(window, {napplet: {
        shell: {ready: async () => {}},
        relay: {query: async ([filter]: {kinds: number[]; authors?: string[]; '#d'?: string[]; until?: number; limit?: number}[]) => {
          if (filter?.kinds[0] === 30267) return [{event: recommendation}];
          if (filter?.kinds[0] !== 35129) return [];
          if (filter.authors?.includes(original.pubkey) && filter['#d']?.includes('shared')) {
            await new Promise<void>(resolve => { window.revisionTest.release = resolve; });
            return [{event: original}, {event: replacement}];
          }
          return [...recent, original].filter(event => event.created_at <= (filter.until ?? Infinity))
            .slice(0, filter.limit).map(event => ({event}));
        }},
        link: {open: async (address: string) => {
          window.revisionTest.opens.push(address);
          return {status: 'opened'};
        }},
      }});
    }, {original, replacement, recent, recommendation});
    await page.goto('https://fixture.test/');
    await expect.poll(() => page.evaluate(() => typeof window.revisionTest.release)).toBe('function');
    await page.getByRole('button', {name: 'Load more', exact: true}).click();
    const oldRow = page.getByRole('button', {name: 'Open Original release', exact: true});
    const oldRowButton = await oldRow.evaluateHandle(button => button as HTMLButtonElement);
    await page.getByRole('button', {name: 'Details for Original release', exact: true}).click();
    const open = page.getByRole('button', {name: 'Open Napplet', exact: true});
    const oldDetailButton = await open.evaluateHandle(button => button as HTMLButtonElement);
    await page.evaluate(() => window.revisionTest.release!());

    await expect(page.getByText(change === 'conflicting'
      ? /signed different releases at the same timestamp/ : /newer signed release is available/)).toBeVisible();
    await expect(open).toHaveCount(0);
    // The controls captured before the read finished must also check the current revision on dispatch.
    await oldRowButton.evaluate(button => button.click());
    await oldDetailButton.evaluate(button => button.click());
    expect(await page.evaluate(() => window.revisionTest.opens)).toEqual([]);
    await page.getByRole('button', {name: 'Back to Discover', exact: true}).click();
    await expect(oldRow).toHaveCount(0);
    await expect(page.getByRole('button', {name: 'Details for Original release', exact: true}))
      .toHaveCount(change === 'conflicting' ? 1 : 0);
  });
}
