import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import {finalizeEvent} from 'nostr-tools/pure';
import { naddrEncode, npubEncode } from 'nostr-tools/nip19';
import { digest, KIND } from '../src/catalog.ts';
import { clock, manifest, profile } from './fixtures.ts';

const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAJYAAAAwCAIAAAB8JhRGAAABHElEQVR4nO3bMQ7CQAxE0dyBnoYzhGPQc0yuRxVKhCIrWXl3xuyXTDVYbPxkREAs1/VBla7l87jc7rtFVCKCsHwEYfkIwvLRUcL36/ldQdfPM7t2mUTaS4YQQrPrmZSwoeKXN6+2w4/sOlWNH2dYGp93FwghhBBCCCGEEEIIIdQTmlc8BYcubRX4mvvPliY9ghBCCNWDghBCCNWDghBCCNWDyr8vjKfg0GVSWYfP30KWpuug9rfQ4WQQQgih+mQQQgih+mQQQjg34bB7mrYukxp5yaeeP/RX+wmXJrEr2kLz6zGJIIQQQnUEIYQQqiMIIexJ2HBXdLBLWPHsHLqyKv9fviaRfGmGDQpCCCGsQkhkG0FYPoKwfARh+WgDbPyP24XigaYAAAAASUVORK5CYII=';
const imageHash = digest(new Uint8Array(Buffer.from(png, 'base64')));
const grid = manifest({ title: 'Grid Game', extra: [
  ['t', 'game'], ['R', 'relay'], ['O', 'unknown-feature'],
  ['server', 'https://media.example.org'], ['icon', imageHash, 'image/png'], ['screenshot', `x ${imageHash}`, 'alt Amber cells on a grid', 'm image/png'],
] });
const gridAddress = naddrEncode({ kind: KIND, identifier: 'shared', pubkey: grid.pubkey });
const tool = manifest({ publisher: 2, d: 'tools', format: 'legacy', title: 'Relay Tool', description: 'Inspect public events',
  timestamp: clock - 5, extra: [['t', 'tool']] });
const spoof = { ...manifest({ title: 'Fake signature' }), sig: '1'.repeat(128) };
const communityList = finalizeEvent({kind: 30267, created_at: clock, content: '', tags: [['d', 'napplets'],
  ['a', `35129:${grid.pubkey}:shared`], ['a', `35129:${tool.pubkey}:tools`]]}, new Uint8Array(32).fill(3));
const profiles = [
  profile(3, clock - 1, '{"display_name":"River Studio"}'),
  profile(1, clock - 2, '{"display_name":"Delta Studio","about":"<script>Publisher text</script>"}'),
  { ...profile(2, clock - 1, '{"display_name":"Spoof Studio"}'), sig: '0'.repeat(128) },
];

async function boot(page: Page, options: { relay?: boolean; direct?: boolean; pending?: boolean; legacyBrowser?: boolean; pendingProfiles?: boolean; fullHost?: boolean; partialOutbox?: boolean; rejectOutbox?: boolean; embedded?: boolean; community?: 'populated' | 'held' | 'invalid'; holdRecommenderProfile?: boolean; holdArtwork?: boolean; failArtwork?: boolean } = {},
  feed?: ReturnType<typeof manifest>[], exactOnly: ReturnType<typeof manifest>[] = []) {
  const external: string[] = [];
  await page.route(/^https?:/, route => {
    if (route.request().url() === 'https://parent.fixture.test/') return route.fulfill({contentType: 'text/html',
      body: '<!doctype html><button id=outside>Host focus</button><iframe title=Discover sandbox=allow-scripts src=https://fixture.test/ style="width:100%;height:950px;border:0"></iframe>'});
    if (route.request().url() === 'https://fixture.test/') return route.fulfill({ contentType: 'text/html', body: html });
    external.push(route.request().url());
    return route.abort();
  });
  await page.addInitScript(({ input, exactOnly, profiles, options, png, imageHash, paginated, communityList }) => {
    if (options.embedded && window === window.top) return;
    if (options.legacyBrowser) Reflect.deleteProperty(Object, 'hasOwn');
    const shell = window as Window & Record<string, unknown>;
    const fixture = {
      manifests: input,
      fail: false,
      holdRefresh: false,
      releaseRefresh: undefined as (() => void) | undefined,
      releaseProfiles: undefined as (() => void) | undefined,
      opens: [] as string[],
      listCalls: [] as unknown[],
      outboxCalls: [] as unknown[],
      publicationLookups: [] as unknown[],
      privateReads: [] as string[],
      listResult: {ok: true, added: 1},
      communityProfileReads: 0,
      releaseCommunity: undefined as (() => void) | undefined,
      releaseRecommenderProfile: undefined as (() => void) | undefined,
      resourceUrls: [] as string[],
      releaseArtwork: undefined as (() => void) | undefined,
      status: 'denied',
      error: 'user-denied' as string | undefined,
      resolve: undefined as ((result: { status: string }) => void) | undefined,
      theme: undefined as ((value: unknown) => void) | undefined,
    };
    shell.fixture = fixture;
    for (const key of ['hypergolic', 'hypergolicSupportReport']) {
      Object.defineProperty(shell, key, {get() {fixture.privateReads.push(key); throw Error('Private API accessed');}});
    }
    shell.napplet = {
      shell: { ready: async () => {} },
      relay: options.relay === false ? undefined : { query: async (filters: { kinds: number[]; authors?: string[]; '#d'?: string[]; until?: number; limit?: number }[]) => {
        if (filters[0]?.kinds[0] === 30267) {
          const records = options.community ? [{event: options.community === 'invalid' ? {...communityList, sig: '0'.repeat(128)} : communityList}] : [];
          if (options.community === 'held') return new Promise(resolve => {fixture.releaseCommunity = () => resolve(records);});
          return records;
        }
        if (filters[0]?.kinds[0] === 0) {
          const authors = new Set(filters.flatMap(filter => filter.authors ?? []));
          const result = profiles.filter(event => authors.has(event.pubkey)).map(event => ({ event }));
          if (authors.has(communityList.pubkey)) {
            fixture.communityProfileReads++;
            if (options.holdRecommenderProfile) return new Promise(resolve => {fixture.releaseRecommenderProfile = () => resolve(result);});
          }
          if (options.pendingProfiles) return new Promise<typeof result>(resolve => {
            fixture.releaseProfiles = () => resolve(result);
          });
          return result;
        }
        if (fixture.holdRefresh) await new Promise<void>(resolve => {
          fixture.releaseRefresh = () => { fixture.holdRefresh = false; resolve(); };
        });
        if (fixture.fail) throw new Error('Network unavailable');
        if (filters.some(filter => filter.authors || filter['#d'])) {
          fixture.publicationLookups.push(filters);
          const available = [...fixture.manifests, ...exactOnly];
          const matches = filters.flatMap(filter => available.filter(event =>
            filter.kinds.includes(event.kind) && filter.authors?.includes(event.pubkey) &&
            event.tags.some(tag => tag[0] === 'd' && filter['#d']?.includes(tag[1]!)) &&
            event.created_at <= (filter.until ?? Infinity)
          ).slice(0, filter.limit));
          return matches.map(event => ({event}));
        }
        const filter = filters[0];
        const manifests = paginated && filter
          ? fixture.manifests.filter(event => event.created_at <= (filter.until ?? Infinity)).slice(0, filter.limit)
          : fixture.manifests;
        return manifests.map(event => ({ event }));
      } },
      outbox: options.partialOutbox || options.rejectOutbox ? {query: async (filters: unknown, queryOptions: unknown) => {
        fixture.outboxCalls.push([filters, queryOptions]);
        if (options.rejectOutbox) throw Error('Authorless queries unavailable');
        const incomplete = fixture.outboxCalls.length === 1;
        const records = incomplete ? input.slice(0, 1) : input;
        return {events: records.map(event => ({event})), incomplete};
      }} : undefined,
      link: options.direct === false ? undefined : {
        open: (url: string) => {
          fixture.opens.push(url);
          if (options.pending && fixture.opens.length === 1) return new Promise(resolve => {fixture.resolve = resolve;});
          return Promise.resolve({status: fixture.status, error: fixture.error});
        },
      },
      lists: options.fullHost ? {
        supported: async () => [{kind: 30267, type: 'app collections', addressable: true, supportedItemTypes: ['address']}],
        add: async (...args: unknown[]) => {fixture.listCalls.push(args); return fixture.listResult;},
      } : undefined,
      theme: {
        get: async () => ({ colors: { background: '#ffffff' } }),
        onChanged: (listener: (theme: unknown) => void) => {
          fixture.theme = listener;
          return { close() {} };
        },
      },
      resource: {
        bytes: async (url: string) => {
          fixture.resourceUrls.push(url);
          if (url !== `https://media.example.org/${imageHash}`) throw new Error('Unavailable');
          if (options.failArtwork) throw Error('Owned unavailable artwork');
          const blob = new Blob([Uint8Array.from(atob(png), char => char.charCodeAt(0))], {type: 'image/png'});
          if (options.holdArtwork) return new Promise(resolve => {fixture.releaseArtwork = () => resolve(blob);});
          return blob;
        },
      },
    };
  }, { input: feed ?? [grid, tool, spoof], exactOnly, profiles, options, png, imageHash, paginated: Boolean(feed), communityList });
  await page.goto(options.embedded ? 'https://parent.fixture.test/' : 'https://fixture.test/');
  return external;
}

test('browse, search signed metadata, inspect details and restore keyboard position in both themes', async ({ page }, info) => {
  const external = await boot(page);
  await expect(page.getByRole('heading', { name: 'Discover', exact: true })).toBeVisible();
  const first = page.getByRole('button', { name: 'Details for Relay Tool' });
  const second = page.getByRole('button', { name: 'Details for Grid Game' });
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();
  await expect(page.getByRole('listitem').first()).toContainText('Relay Tool');
  await expect(page.getByText('Fake signature')).toHaveCount(0);
  await expect(page.locator('#results img').first()).toBeVisible();
  await page.screenshot({ path: info.outputPath('home-light.png') });
  await page.evaluate(() => (window as any).fixture.theme({ colors: { background: '#0b141d' } }));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: info.outputPath('home-dark.png') });
  await page.evaluate(() => (window as any).fixture.theme({ colors: { background: '#fdfdfd' } }));

  const search = page.getByRole('searchbox', { name: 'Search Napplets' });
  await search.fill('Delta Studio');
  await expect(page.getByRole('heading', { name: 'Search results', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Results for “Delta Studio”' })).toBeVisible();
  await expect(second).toBeVisible();
  await expect(first).toHaveCount(0);
  await page.getByRole('button', { name: 'Games', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Games', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.screenshot({ path: info.outputPath('search-light.png') });

  await page.evaluate(() => (window as any).fixture.theme({ colors: { background: '#0b141d' } }));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(search).toHaveValue('Delta Studio');
  await page.screenshot({ path: info.outputPath('search-dark.png') });
  await second.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#detail-heading')).toBeFocused();
  await expect(page.locator('.detail-publisher')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Access', exact: true })).toBeVisible();
  await expect(page.locator('.access-details')).not.toHaveAttribute('open', '');
  await expect(page.getByRole('img', { name: 'Amber cells on a grid' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('details-dark.png') });
  await page.evaluate(() => (window as any).fixture.theme({ colors: { background: '#fdfdfd' } }));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.screenshot({ path: info.outputPath('details-light.png') });
  await page.getByText('Delta Studio', { exact: true }).click();
  await expect(page.getByText(npubEncode(grid.pubkey))).toBeVisible();
  await expect(page.getByText('<script>Publisher text</script>', { exact: true })).toBeVisible();
  await page.getByText('Publication details', { exact: true }).click();
  await expect(page.getByText(gridAddress)).toBeVisible();
  await page.screenshot({ path: info.outputPath('publication-light.png') });

  await page.getByRole('button', { name: 'Back to search results' }).click();
  await expect(second).toBeFocused();
  await expect(search).toHaveValue('Delta Studio');
  await expect(page.getByRole('button', { name: 'Games', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('');
  await page.getByRole('button', { name: 'Discover', exact: true }).click();
  await expect(page.getByRole('button', { name: 'All', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(external).toEqual([]);
});

test('a shell without Link still exposes the signed publication address', async ({page}) => {
  await boot(page, {direct: false});
  await page.getByRole('button', {name: 'Details for Grid Game'}).click();
  await expect(page.getByRole('button', {name: 'Open Napplet'})).toHaveCount(0);
  await expect(page.getByText(/does not offer link opening/)).toBeVisible();
  await page.getByText('Publication details', {exact: true}).click();
  await expect(page.getByText(gridAddress, {exact: true})).toBeVisible();
});

test('sends the canonical publication link once while pending, and restores focus on cancel', async ({ page }) => {
  await boot(page, { pending: true });
  const open = page.getByRole('button', { name: 'Open Grid Game' });
  await open.click();
  const opening = page.getByRole('button', { name: 'Opening Grid Game…' });
  await expect(opening).toHaveText('Opening…');
  await expect(opening).toHaveAttribute('aria-disabled', 'true');
  await expect(opening.locator('.open-spinner')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Relay Tool' })).toBeDisabled();
  await opening.evaluate((button: HTMLButtonElement) => button.click());
  expect(await page.evaluate(() => (window as any).fixture.opens)).toEqual(['nostr:' + gridAddress]);
  await page.evaluate(() => (window as any).fixture.resolve({ status: 'denied', error: 'user-denied' }));
  await expect(page.locator('.row').filter({has: open}).getByText('Opening cancelled.')).toBeVisible();
  await expect(open).toBeEnabled();
  await expect(open).toBeFocused();

  await page.getByRole('button', { name: 'Details for Grid Game' }).click();
  await page.evaluate(() => { (window as any).fixture.status = 'opened'; });
  await page.getByRole('button', { name: 'Open Napplet' }).click();
  await expect(page.getByText('Link accepted by your shell.')).toBeVisible();
  expect(await page.evaluate(() => (window as any).fixture.opens.at(-1))).toEqual('nostr:' + gridAddress);
});

test('keeps the search spinner through a redraw and clears it when the shell declines the link', async ({ page }) => {
  await boot(page, { pending: true, pendingProfiles: true });
  const search = page.getByRole('searchbox');
  await search.fill('Grid');
  const open = page.getByRole('button', { name: 'Open Grid Game' });
  await open.click();
  const opening = page.getByRole('button', { name: 'Opening Grid Game…' });
  const original = await opening.elementHandle();
  await page.evaluate(() => (window as any).fixture.releaseProfiles());
  await expect.poll(() => original!.evaluate(element => element.isConnected)).toBe(false);
  await expect(opening.locator('.open-spinner')).toBeVisible();
  await expect(opening).toBeFocused();
  await page.evaluate(() => (window as any).fixture.resolve({status: 'denied'}));
  await expect(page.locator('.row').filter({has: open}).getByText(/declined this link/)).toBeVisible();
  await expect(open).toBeEnabled();
  await expect(search).toHaveValue('Grid');
  await expect(open).toBeFocused();
});

test('handles unsupported links, policy denial and legacy bare denial without promising launch', async ({page}) => {
  await boot(page);
  await page.getByRole('button', {name: 'Details for Grid Game'}).click();
  for (const [error, text] of [
    ['unsupported-scheme', 'does not handle napplet links'],
    ['blocked-by-policy', 'declined this link'],
    [undefined, 'declined this link'],
  ] as const) {
    await page.evaluate(error => {(window as any).fixture.error = error;}, error);
    await page.getByRole('button', {name: 'Open Napplet'}).click();
    await expect(page.getByText(text, {exact: false})).toBeVisible();
  }
});

test('keeps saved rows with a stale label when refresh fails', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Details for Grid Game' })).toBeVisible();
  await page.evaluate(() => { (window as any).fixture.fail = true; });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText(/Showing saved results from this session/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Grid Game' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Details for Grid Game' })).toBeVisible();
  await page.evaluate(() => { (window as any).fixture.fail = false; });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Grid Game' })).toBeVisible();
});

test('missing relay grant is distinct from an empty directory', async ({ page }) => {
  await boot(page, { relay: false });
  await expect(page.getByText(/Directory access is unavailable/)).toBeVisible();
  await expect(page.getByText(/No eligible/)).toHaveCount(0);
});

test('starts and verifies signed relay data in a guest realm without Object.hasOwn', async ({ page }) => {
  await boot(page, { legacyBrowser: true });
  await expect(page.getByRole('button', { name: 'Details for Grid Game' })).toBeVisible();
  await expect(page.getByText('Fake signature')).toHaveCount(0);
});


test('search and filters stay reachable after seven pages on a phone', async ({ page }, info) => {
  const feed = Array.from({ length: 56 }, (_, index) => manifest({
    d: `catalog-game-${index}`,
    title: `Catalog game ${String(index + 1).padStart(2, '0')}`,
    timestamp: clock - index,
    extra: [['t', 'game'], ...(index % 2 ? [['R', 'unknown-feature']] : [])],
  }));
  const external = await boot(page, {}, feed);
  const rows = page.getByRole('listitem');
  await expect(rows).toHaveCount(8);
  const more = page.getByRole('button', { name: 'Load more' });
  for (let count = 15; count <= 50; count += 7) {
    await more.click();
    await expect(rows).toHaveCount(count);
  }
  const bottom = await page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    return window.scrollY;
  });
  expect(bottom).toBeGreaterThan(1_000);
  const controls = page.locator('#browse-controls');
  await expect.poll(async () => (await controls.boundingBox())?.y).toBe(0);
  await expect(page.locator('#coverage')).toContainText('50 verified publications');
  await page.screenshot({ path: info.outputPath('sticky-browse-light.png') });
  await page.evaluate(() => (window as any).fixture.theme({ colors: { background: '#0b141d' } }));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: info.outputPath('sticky-browse-dark.png') });

  const last = page.getByRole('button', { name: 'Details for Catalog game 50' });
  await last.click();
  await expect(controls).toBeHidden();
  await page.getByRole('button', { name: 'Back to Discover' }).click();
  await expect(last).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(bottom);

  const search = page.getByRole('searchbox', { name: 'Search Napplets' });
  await search.click();
  expect(await page.evaluate(() => window.scrollY)).toBe(bottom);
  await search.fill('Catalog game');
  await expect(search).toBeFocused();
  await expect(rows).toHaveCount(50);
  const heading = page.getByRole('heading', { name: 'Results for “Catalog game”' });
  await expect(heading).toBeInViewport();
  expect((await heading.boundingBox())!.y + 1)
    .toBeGreaterThanOrEqual((await controls.boundingBox())!.height);
  await search.press('Enter');
  await expect(heading).toBeFocused();

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  expect(external).toEqual([]);
});


test('clears completed row feedback when the user changes the list context', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { (window as any).fixture.status = 'opened'; });
  const feedback = page.locator('#row-open-status');
  const search = page.getByRole('searchbox', {name: 'Search Napplets'});
  const open = page.getByRole('button', {name: 'Open Grid Game', exact: true});
  const opened = async () => { await open.click(); await expect(feedback).toHaveText('Link accepted by your shell.'); };
  const cleared = async () => { await expect(feedback).toBeHidden(); await expect(feedback).toBeEmpty(); };

  await opened();
  await search.fill('No matching body');
  await expect(page.getByText('No matches in the loaded results.')).toBeVisible();
  await cleared();
  await page.getByRole('button', {name: 'Clear search'}).click();
  await opened();
  await page.getByRole('button', {name: 'Tools', exact: true}).click();
  await cleared();
  await page.getByRole('button', {name: 'All', exact: true}).click();
  await opened();
  await search.fill('Grid');
  await opened();
  await page.getByRole('button', {name: 'Discover', exact: true}).click();
  await cleared();
  await opened();
  await page.getByRole('button', {name: 'Details for Grid Game'}).click();
  await page.getByRole('button', {name: 'Back to Discover'}).click();
  await cleared();
});

test('keeps row feedback through publisher enrichment of the same search', async ({ page }) => {
  await boot(page, {pendingProfiles: true});
  await page.getByRole('searchbox').fill('Grid');
  await page.evaluate(() => { (window as any).fixture.status = 'opened'; });
  await page.getByRole('button', {name: 'Open Grid Game', exact: true}).click();
  const feedback = page.locator('#row-open-status');
  await expect(feedback).toHaveText('Link accepted by your shell.');
  const originalRow = await page.getByRole('button', {name: 'Details for Grid Game'}).elementHandle();
  await page.evaluate(() => (window as any).fixture.releaseProfiles());
  await expect.poll(() => originalRow!.evaluate(element => element.isConnected)).toBe(false);
  await expect(feedback).toBeVisible();
  await expect(feedback).toHaveText('Link accepted by your shell.');
});

for (const status of ['opened', 'denied'] as const) {
  test(`keeps row feedback scoped after a late ${status} response`, async ({ page }) => {
    await boot(page, {pending: true});
    await page.getByRole('button', {name: 'Open Grid Game', exact: true}).click();
    const search = page.getByRole('searchbox');
    await search.fill('Relay Tool');
    const toolOpen = page.getByRole('button', {name: 'Open Relay Tool', exact: true});
    await expect(toolOpen).toBeDisabled();
    await toolOpen.evaluate((button: HTMLButtonElement) => button.click());
    expect(await page.evaluate(() => (window as any).fixture.opens)).toHaveLength(1);
    await search.focus();
    await page.evaluate(status => (window as any).fixture.resolve({status}), status);
    await expect(page.locator('#row-open-status')).toBeHidden();
    await expect(page.locator('#row-open-status')).toBeEmpty();
    await expect(search).toBeFocused();

    await expect(toolOpen).toBeEnabled();
    await toolOpen.click();
    await expect(page.locator('#row-open-status')).toHaveText('Opening cancelled.');
    expect(await page.evaluate(() => (window as any).fixture.opens)).toHaveLength(2);
  });
}

test('detail uses signed metadata and keeps opening reachable at narrow widths', async ({ page }) => {
  await boot(page, { direct: true });
  await page.getByRole('button', { name: 'Details for Grid Game', exact: true }).click();
  await expect(page.locator('#detail-heading')).toHaveText('Grid Game');
  await expect(page.locator('.publication-date')).toHaveAttribute('datetime', new Date(grid.created_at * 1000).toISOString());
  await expect(page.locator('.access-summary')).toHaveText('Uses Nostr relays.');
  await expect(page.getByRole('heading', { name: 'Required', exact: true })).toBeHidden();
  await page.getByText('Access details', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Required', exact: true })).toBeVisible();
  await page.getByText('Access details', { exact: true }).click();
  await page.setViewportSize({ width: 320, height: 568 });
  await page.getByText('Publication details', { exact: true }).click();
  await expect(page.getByText(gridAddress, { exact: true })).toBeVisible();
  await page.locator('#detail .publication').scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Open Napplet', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('detail keeps the theme’s launch cover separate from missing publisher media', async ({ page }) => {
  await boot(page, { direct: true }, [tool]);
  await page.getByRole('button', { name: 'Details for Relay Tool', exact: true }).click();
  await expect(page.locator('#detail .detail-art')).toBeHidden();
  await expect(page.locator('#detail .detail-art img')).toHaveCount(0);
  await expect(page.locator('#publisher-name')).toContainText('npub');
  await page.setViewportSize({width: 350, height: 720});
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const cover = page.locator('.launch-cover img:visible');
    await expect(cover).toHaveCount(1);
    await expect(cover).toHaveClass(theme === 'dark' ? 'launch-night' : 'launch-morning');
    await expect.poll(() => cover.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(676);
  }
  const plate = (await page.locator('.launch-cover').boundingBox())!;
  const title = (await page.locator('#detail-heading').boundingBox())!;
  expect(plate.width).toBeGreaterThan(300);
  expect(title.y).toBeGreaterThanOrEqual(plate.y + plate.height);
});

test('access rows describe publisher declarations without assuming a host policy', async ({page}) => {
  const app=manifest({title:'Access meanings',extra:[['R','inc'],['R','cvm'],['O','dm']]});
  await boot(page,{},[app]);
  await page.getByRole('button',{name:'Details for Access meanings',exact:true}).click();
  await expect(page.locator('#detail')).toContainText('Messages between napplets');
  await expect(page.locator('#detail')).toContainText('External tools');
  await expect(page.locator('#detail')).toContainText('Your shell decides which access is available.');
});


test('the public recommendation uses a standard list mutation only after a click', async ({page}) => {
  await boot(page, {fullHost: true});
  await page.getByRole('button', {name: 'Details for Grid Game'}).click();
  const recommend = page.getByRole('button', {name: 'Recommend publicly'});
  await expect(recommend).toBeVisible();
  expect(await page.evaluate(() => (window as any).fixture.listCalls)).toEqual([]);
  await recommend.click();
  await expect(page.getByText('Added to your public recommendations.')).toBeVisible();
  expect(await page.evaluate(() => (window as any).fixture.listCalls)).toEqual([[
    {kind: 30267, identifier: 'napplets'}, [{itemType: 'address', value: `35129:${grid.pubkey}:shared`, visibility: 'public'}], {create: true},
  ]]);
});

test('access details render distinct decorative icons for the declared domains', async ({ page }) => {
  const app = manifest({ title: 'Access icons', d: 'access-icons',
    extra: [['R', 'identity'], ['R', 'relay'], ['R', 'cvm'], ['O', 'dm'], ['O', 'future']] });
  await boot(page, {}, [app]);
  await page.getByRole('button', { name: 'Details for Access icons', exact: true }).click();
  await page.getByText('Access details', { exact: true }).click();
  const icons = page.locator('.cap-row svg[aria-hidden="true"] path');
  await expect(icons).toHaveCount(5);
  const paths = await icons.evaluateAll(nodes => nodes.map(node => node.getAttribute('d')));
  expect(new Set(paths).size).toBe(5);
});

test('embedded detail and Open controls act on their first click after host focus', async ({page}) => {
  await boot(page, {fullHost: true, embedded: true});
  const frame = page.frames().find(frame => frame.parentFrame() === page.mainFrame());
  if (!frame) throw Error('Missing embedded Discover');
  await page.getByRole('button', {name: 'Host focus'}).click();
  await frame.getByRole('button', {name: 'Details for Grid Game', exact: true}).click();
  await expect(frame.getByRole('heading', {name: 'Grid Game', exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Host focus'}).click();
  await frame.getByRole('button', {name: 'Open Napplet', exact: true}).click();
  expect(await frame.evaluate(() => (window as any).fixture.opens)).toEqual(['nostr:' + gridAddress]);
});


test('compact phone feed keeps search, publisher, age and touch actions visible in both themes', async ({page}, info) => {
  await boot(page, {fullHost: true, community: 'populated'});
  const card = page.locator('#community-recommendation');
  await expect(card.locator('.community-attribution')).toHaveText('Recommended by River Studio');
  await expect(card.locator('img')).toHaveCount(1);
  await expect(card.locator('img')).toHaveJSProperty('naturalWidth', 150);
  const first = page.locator('#results .row').first();
  await expect(first.locator('.row-publisher')).toContainText('by ');
  await expect(first.locator('time')).toHaveAttribute('datetime', /T/);
  for (const width of [320, 390]) {
    await page.setViewportSize({width, height: 844});
    await expect(page.getByRole('heading', {name: 'Discover', exact: true})).toBeInViewport();
    await expect(page.getByRole('searchbox', {name: 'Search Napplets'})).toBeInViewport();
    expect(await page.locator('#browse-controls').evaluate(el => el.getBoundingClientRect().height)).toBeLessThan(65);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await page.screenshot({path: info.outputPath(`feed-community-${width}-${theme}.png`)});
    }
  }
});

for (const emptyRecent of [false, true]) {
  test(`off-page recommendation opens from ${emptyRecent ? 'empty' : 'populated'} Recent and returns to its card`, async ({page}) => {
    const recent = emptyRecent ? [] : [manifest({d: 'recent', title: 'Recent publication'})];
    const external = await boot(page, {community: 'populated'}, recent, [grid]);
    const rows = page.locator('#results .row');
    const card = page.locator('#community-recommendation .community-app');
    await expect(card).toHaveText(/Grid Game/);
    await expect(rows).toHaveCount(recent.length);
    await expect(rows.filter({hasText: 'Grid Game'})).toHaveCount(0);

    const filters = await page.evaluate(() => (window as any).fixture.publicationLookups.flat());
    expect(filters).toContainEqual(expect.objectContaining({kinds: [KIND], authors: [grid.pubkey], '#d': ['shared']}));
    await card.click();
    await expect(page.getByRole('heading', {name: 'Grid Game', exact: true})).toBeVisible();
    await page.evaluate(() => { (window as any).fixture.status = 'opened'; });
    await page.getByRole('button', {name: 'Open Napplet', exact: true}).click();
    await expect(page.getByText('Link accepted by your shell.')).toBeVisible();
    expect(await page.evaluate(() => (window as any).fixture.opens)).toEqual(['nostr:' + gridAddress]);

    await page.getByRole('button', {name: 'Back to Discover', exact: true}).click();
    await expect(card).toBeFocused();
    await expect(rows).toHaveCount(recent.length);
    if (!emptyRecent) await expect(rows.first()).toContainText('Recent publication');
    expect(external).toEqual([]);
  });
}

test('community navigation below the page top opens direct details and keeps selection on Back', async ({page}) => {
  await page.setViewportSize({width: 390, height: 500});
  await boot(page, {fullHost: true, community: 'populated'});
  const card = page.locator('#community-recommendation');
  await expect(card.locator('.community-attribution')).toHaveText('Recommended by River Studio');
  await expect(card.locator('.community-position')).toHaveText('1 / 2');
  await expect(page.getByRole('button', {name: 'Previous recommendation'})).toBeDisabled();
  await page.evaluate(() => window.scrollTo(0, 80));
  await page.getByRole('button', {name: 'Next recommendation'}).click();
  await expect(card.locator('.community-position')).toHaveText('2 / 2');
  await expect(page.getByRole('button', {name: 'Next recommendation'})).toBeDisabled();
  const target = card.getByRole('button', {name: 'Details for Relay Tool recommended by River Studio'});
  await target.click();
  await expect(page.locator('#detail-heading')).toHaveText('Relay Tool');
  await page.getByRole('button', {name: 'Back to Discover', exact: true}).click();
  await expect(card.locator('.community-position')).toHaveText('2 / 2');
  await expect(target).toBeFocused();
  await page.getByRole('button', {name: 'Previous recommendation'}).click();
  await expect(card.locator('.community-title')).toHaveText('Grid Game');
  expect(await page.evaluate(() => (window as any).fixture.opens)).toEqual([]);
});

test('a late recommendation stays deferred during search and returns without stealing focus', async ({page}) => {
  await boot(page, {community: 'held'});
  const search = page.getByRole('searchbox', {name: 'Search Napplets'});
  await search.fill('Grid');
  await page.evaluate(() => (window as any).fixture.releaseCommunity());
  await expect.poll(() => page.evaluate(() => (window as any).fixture.communityProfileReads)).toBe(1);
  await expect(page.locator('#community-recommendation')).toBeHidden();
  await expect(search).toBeFocused();
  await page.getByRole('button', {name: 'Discover', exact: true}).click();
  await expect(page.locator('#community-recommendation')).toBeVisible();
  await expect(search).toBeFocused();
});

test('late recommendations leave scrolled rows in place until the user returns to the top', async ({page}) => {
  await page.setViewportSize({width: 390, height: 500});
  const feed = [grid, tool, ...Array.from({length: 6}, (_, index) => manifest({d: `more-${index}`, title: `More app ${index}`, timestamp: clock - 20 - index}))];
  await boot(page, {community: 'held'}, feed);
  await page.getByRole('button', {name: 'Details for More app 3', exact: true}).scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => scrollY);
  await page.evaluate(() => (window as any).fixture.releaseCommunity());
  await expect.poll(() => page.evaluate(() => (window as any).fixture.communityProfileReads)).toBe(1);
  await expect(page.locator('#community-recommendation')).toBeHidden();
  expect(await page.evaluate(() => scrollY)).toBe(before);
  await page.evaluate(() => scrollTo(0, 0));
  await expect(page.locator('#community-recommendation')).toBeVisible();
});

test('zero or invalid recommendations add no empty feed section', async ({page}) => {
  await boot(page, {community: 'invalid'});
  await expect(page.locator('#results .row')).toHaveCount(2);
  await expect(page.locator('#community-recommendation')).toBeHidden();
  await expect(page.locator('.community-app')).toHaveCount(0);
});

test('late verified recommendation names upgrade quietly while preserving the selected app', async ({page}) => {
  await boot(page, {community: 'populated', holdRecommenderProfile: true});
  const card = page.locator('#community-recommendation');
  await expect(card).toBeVisible();
  const before = await card.locator('.community-app').getAttribute('data-community-app');
  await expect(card.locator('.community-attribution')).not.toHaveText('Recommended by River Studio');
  await page.evaluate(() => (window as any).fixture.releaseRecommenderProfile());
  await expect(card.locator('.community-attribution')).toHaveText('Recommended by River Studio');
  expect(await card.locator('.community-app').getAttribute('data-community-app')).toBe(before);
  await expect(card.locator('.community-position')).toHaveText('1 / 2');
});


test('recommendations arriving during detail preserve the active view and the returning row position', async ({page}) => {
  await boot(page, {community: 'held'});
  const row = page.getByRole('button', {name: 'Details for Grid Game', exact: true});
  const before = await row.boundingBox();
  await row.click();
  await expect(page.locator('#detail-heading')).toBeFocused();
  await page.evaluate(() => (window as any).fixture.releaseCommunity());
  await expect.poll(() => page.evaluate(() => (window as any).fixture.communityProfileReads)).toBe(1);
  await expect(page.locator('.community-app')).toHaveCount(0);
  await expect(page.locator('#detail-heading')).toBeFocused();
  await page.getByRole('button', {name: 'Back to Discover', exact: true}).click();
  await expect(row).toBeFocused();
  expect(await row.boundingBox()).toEqual(before);
  await expect(page.locator('#community-recommendation')).toBeHidden();
});


test('same-publisher apps have legible title initials and stable distinct colours in both themes', async ({page}, info) => {
  const faultline = manifest({d: 'faultline', title: 'Faultline'});
  const duck = manifest({d: 'duck-duck-duel', title: 'Duck Duck Duel', timestamp: clock - 11});
  await boot(page, {}, [faultline, duck]);
  const first = page.locator('.row').filter({has: page.getByRole('button', {name: 'Details for Faultline', exact: true})}).locator('.app-initials');
  const second = page.locator('.row').filter({has: page.getByRole('button', {name: 'Details for Duck Duck Duel', exact: true})}).locator('.app-initials');
  await expect(first).toHaveText('F'); await expect(second).toHaveText('DD');
  const colours = async () => Promise.all([first, second].map(locator => locator.evaluate(el => {
    const style = getComputedStyle(el); return {background: style.backgroundColor, ink: style.color};
  })));
  const initial = await colours();
  expect(initial[0]!.background).not.toBe(initial[1]!.background);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    expect(await colours()).toEqual(initial);
    await page.screenshot({path: info.outputPath(`initials-${theme}.png`)});
    for (const colour of initial) {
      const luminance = (rgb: string) => rgb.match(/\d+/g)!.slice(0, 3).map(Number).map(value => {
        const channel = value / 255; return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
      }).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index]!, 0);
      expect((luminance(colour.background) + .05) / (luminance(colour.ink) + .05)).toBeGreaterThan(4.5);
    }
  }
  await page.getByRole('button', {name: 'Details for Faultline', exact: true}).click();
  await expect(page.locator('.app-icon-large')).toBeHidden();
  await expect(page.locator('.launch-cover img:visible')).toHaveCount(1);
});

test('title initials remain during artwork loading and verified art replaces them cleanly', async ({page}) => {
  await boot(page, {holdArtwork: true});
  const icon = page.locator('.row').filter({has: page.getByRole('button', {name: 'Details for Grid Game', exact: true})}).locator('.app-icon');
  await expect(icon.locator('.app-initials')).toHaveText('GG');
  await expect(icon.locator('img')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => typeof (window as any).fixture.releaseArtwork)).toBe('function');
  await page.evaluate(() => (window as any).fixture.releaseArtwork());
  await expect(icon.locator('img')).toHaveJSProperty('naturalWidth', 150);
  await expect(icon.locator('.app-initials')).toHaveCount(0);
});

test('failed signed artwork leaves the same readable fallback in a row and its recommendation', async ({page}) => {
  await boot(page, {community: 'populated', failArtwork: true});
  const card = page.locator('#community-recommendation');
  await expect(card.getByRole('heading', {name: 'Recommended', exact: true})).toBeVisible();
  await expect(card.locator('.app-initials')).toHaveText('GG');
  const row = page.locator('.row').filter({has: page.getByRole('button', {name: 'Details for Grid Game', exact: true})});
  await expect(row.locator('.app-initials')).toHaveText('GG');
  expect(await card.locator('.app-initials').evaluate(el => getComputedStyle(el).backgroundColor))
    .toBe(await row.locator('.app-initials').evaluate(el => getComputedStyle(el).backgroundColor));
  await expect(card.locator('img')).toHaveCount(0);
  await expect(row.locator('img')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).fixture.resourceUrls.length)).toBeGreaterThan(0);
});

test('standard Outbox can recover partial pages on a shell with no vendor interfaces', async ({page}) => {
  await boot(page, {partialOutbox: true}, [tool, grid]);
  await expect(page.getByRole('button', {name: 'Details for Relay Tool'})).toBeVisible();
  await expect(page.getByText(/Some relay results were unavailable/)).toBeVisible();
  await expect(page.getByRole('button', {name: 'Details for Grid Game'})).toHaveCount(0);
  await page.getByRole('button', {name: 'Load more', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Details for Grid Game'})).toBeVisible();
  const open = page.getByRole('button', {name: 'Open Grid Game', exact: true});
  await open.click();
  await expect(page.getByText('Opening cancelled.')).toBeVisible();
  const result = await page.evaluate(() => (window as any).fixture);
  expect(result.outboxCalls).toHaveLength(2);
  expect(result.outboxCalls[0][0]).toEqual(result.outboxCalls[1][0]);
  for (const [, options] of result.outboxCalls) expect(options.timeoutMs).toBeLessThanOrEqual(5500);
  expect(result.privateReads).toEqual([]);
  expect(result.opens).toEqual(['nostr:' + gridAddress]);
});

test('an unavailable optional Outbox query preserves browsing over the granted Relay domain', async ({page}) => {
  await boot(page, {rejectOutbox: true}, [tool, grid]);
  await expect(page.getByRole('button', {name: 'Details for Grid Game'})).toBeVisible();
  expect(await page.evaluate(() => (window as any).fixture.outboxCalls.length)).toBe(1);
});

for (const outcome of ['publication-result-unknown', 'disconnected'] as const) {
  test(`an unconfirmed recommendation stays disabled after ${outcome}`, async ({page}) => {
    await boot(page, {fullHost: true});
    await page.evaluate(outcome => {
      const host = window as any;
      host.napplet.lists.add = async () => {
        host.fixture.listCalls.push(true);
        if (outcome === 'disconnected') throw Error('Transport disconnected');
        return {ok: false, error: outcome};
      };
    }, outcome);
    await page.getByRole('button', {name: 'Details for Grid Game'}).click();
    const control = page.getByRole('button', {name: 'Recommend publicly'});
    await control.click();
    await expect(page.getByText('Could not confirm the public recommendation. Check your list before trying again.')).toBeVisible();
    await expect(control).toBeDisabled();
    await control.evaluate((button: HTMLButtonElement) => button.click());
    expect(await page.evaluate(() => (window as any).fixture.listCalls.length)).toBe(1);
  });
}

for (const [theme, width] of [['light', 320], ['dark', 390]] as const) {
  test(`listed app keeps its ${theme} Open target and centered spinner at ${width}px`, async ({page}) => {
    await page.setViewportSize({width, height: 620});
    await page.emulateMedia({reducedMotion: 'reduce'});
    await boot(page, {pending: true});
    await page.evaluate(theme => {document.documentElement.dataset.theme = theme;}, theme);
    const open = page.getByRole('button', {name: 'Open Grid Game', exact: true});
    await expect(open).toBeVisible();
    await expect(open.locator('.open-label')).toBeVisible();
    await expect(open.locator('.open-spinner')).toBeHidden();
    const before = (await open.boundingBox())!;
    expect([before.width, before.height]).toEqual([64, 44]);
    await open.click();
    const busy = page.getByRole('button', {name: 'Opening Grid Game…', exact: true});
    await expect(busy).toHaveAttribute('aria-busy', 'true');
    await expect(busy.locator('.open-label')).toBeHidden();
    const spinner = busy.locator('.open-spinner');
    await expect(spinner).toBeVisible();
    await expect(spinner).toHaveCSS('animation-name', 'none');
    const target = (await busy.boundingBox())!;
    expect(target).toEqual(before);
    const ring = (await spinner.boundingBox())!;
    expect([ring.width, ring.height]).toEqual([16, 16]);
    expect(Math.abs(ring.x + ring.width / 2 - target.x - target.width / 2)).toBeLessThan(1);
    expect(Math.abs(ring.y + ring.height / 2 - target.y - target.height / 2)).toBeLessThan(1);
    await page.evaluate(() => (window as any).fixture.resolve({status: 'opened'}));
    await expect(open.locator('.open-label')).toBeVisible();
    await expect(open.locator('.open-spinner')).toBeHidden();
    await expect(open).toBeFocused();
  });
}

test('details finds the first usable signed screenshot after unavailable, mismatched and undecodable entries', async ({page}) => {
  const app = manifest({title: 'Screenshot gallery', extra: [
    ['server', 'https://media.example.org'],
    ...Array.from({length: 20}, (_, i) => ['screenshot', 'x ' + i.toString(16).padStart(64, '0')]),
    ['screenshot', 'x ' + imageHash, 'm video/mp4', 'alt Incorrect declaration'],
    ['screenshot', 'x ' + imageHash, 'alt Decode fails'],
    ['screenshot', 'x ' + imageHash, 'm image/png', 'alt First usable screenshot'],
    ['screenshot', 'x ' + imageHash, 'alt Later screenshot'],
  ]});
  await boot(page, {direct: true}, [app]);
  await page.evaluate(() => {
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = function () {
      HTMLImageElement.prototype.decode = decode;
      return Promise.reject(new Error('Undecodable screenshot'));
    };
  });
  await page.getByRole('button', {name: 'Details for Screenshot gallery'}).click();
  await expect(page.getByRole('img', {name: 'First usable screenshot'})).toBeVisible();
  await expect(page.locator('.detail-art img')).toHaveCount(1);
  await expect(page.locator('.launch-cover')).toBeHidden();
  await expect(page.getByRole('button', {name: 'Open Napplet', exact: true})).toBeVisible();
});

test('Details anchors Open while a large-text disclosure scrolls and releases its press state', async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await boot(page);
  await page.getByRole('button', {name: 'Details for Grid Game'}).click();
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await page.locator('#publication-reference summary').click();
  const scroll = page.locator('.detail-body');
  await scroll.evaluate(element => { element.scrollTop = 0; });
  const open = page.getByRole('button', {name: 'Open Napplet'});
  const before = (await open.boundingBox())!;
  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
  expect(await scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  expect(await open.boundingBox()).toEqual(before);
  expect(before.y).toBeGreaterThanOrEqual(844 * .65);
  expect(before.y + before.height).toBeLessThanOrEqual(844);
  await page.mouse.move(before.x + 10, before.y + 20);
  await page.mouse.down();
  await expect(open).toHaveAttribute('data-pressing', '');
  const start = await open.evaluate(element => element.style.getPropertyValue('--label-shift'));
  await page.mouse.move(before.x + before.width - 10, before.y + 20);
  expect(await open.evaluate(element => element.style.getPropertyValue('--label-shift'))).not.toEqual(start);
  await page.mouse.move(0, 0);
  await page.mouse.up();
  await expect(open).not.toHaveAttribute('data-pressing', '');
  expect(await page.evaluate(() => (window as any).fixture.opens)).toEqual([]);
});

test('a short publication without preview keeps the final row beside its Open action', async ({page}) => {
  await boot(page, {fullHost: true});
  await page.getByRole('button', {name: 'Details for Relay Tool'}).click();
  await expect(page.locator('.detail-art')).toBeEmpty();
  const row = (await page.getByRole('button', {name: 'Recommend publicly'}).boundingBox())!;
  const open = (await page.getByRole('button', {name: 'Open Napplet'}).boundingBox())!;
  expect(open.y - (row.y + row.height)).toBeLessThanOrEqual(24);
  expect(open.y).toBeGreaterThanOrEqual(844 * .65);
});

test('a publication without a preview lists its signed required access once', async ({page}) => {
  const app = manifest({title: 'Declared access', extra: [['R', 'inc'], ['R', 'gamepad'], ['R', 'future'], ['O', 'dm']]});
  await boot(page, {}, [app]);
  await page.getByRole('button', {name: 'Details for Declared access'}).click();
  const tiles = page.getByRole('list', {name: 'Required access requested by the publisher'});
  await expect(tiles).toBeVisible();
  await expect(tiles.getByRole('listitem')).toHaveText(['future', 'Gamepad', 'Napplet messages']);
  await expect(page.locator('.access-summary')).toBeHidden();
  await page.getByText('Access details', {exact: true}).click();
  await expect(page.locator('.cap-row[data-requirement="optional"]')).toContainText('Direct messages');
});
