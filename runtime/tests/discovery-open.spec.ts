import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { finalizeEvent, type NostrEvent } from 'nostr-tools/pure';
import { naddrEncode } from 'nostr-tools/nip19';

type State = {ready: boolean; calls: object[]; finish?: (status: string) => void};
type TestWindow = Window & {discoveryOpenTest: State; HypergolicHost: object};
type QueryFilter = {kinds: number[]; authors?: string[]; '#d'?: string[]; until?: number; since?: number; limit?: number};

async function openRuntime(page: Page, fixture: string, catalogEvents: {event: NostrEvent}[] = [], feedEvents: NostrEvent[] = []) {
  await page.addInitScript(({catalogEvents, feedEvents}) => {
    if (window !== window.top) return;
    const root = window as unknown as TestWindow;
    const state: State = {ready: false, calls: []};
    const listeners = new Set<(event: {data: string}) => void>();
    root.discoveryOpenTest = state;
    root.HypergolicHost = {
      addEventListener: (_: string, listener: (event: {data: string}) => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: (event: {data: string}) => void) => listeners.delete(listener),
      postMessage(raw: string) {
        const envelope = JSON.parse(raw);
        if (envelope.type === 'ready') { state.ready = true; return; }
        if (envelope.type !== 'capability') return;
        const request = JSON.parse(envelope.message);
        const respond = (response: object) => {
          const data = JSON.stringify({type: 'capability.result', sessionId: envelope.sessionId,
            sequence: envelope.sequence, response: JSON.stringify(response)});
          listeners.forEach(listener => listener({data}));
        };
        if (request.type === 'routing.call' && request.message.type === 'link.open') {
          state.calls.push(request.message);
          state.finish = status => respond({type: 'routing.call.result', id: request.id,
            response: {type: 'link.open.result', id: request.message.id, status}});
        }
        if (request.type === 'relay.query' || request.type === 'outbox.query') {
          const available = [...catalogEvents.map(row => row.event), ...feedEvents].sort((a, b) => b.created_at - a.created_at);
          const matches = new Map<string, NostrEvent>();
          for (const filter of request.filters as QueryFilter[]) {
            const events = available.filter(event => filter.kinds.includes(event.kind) &&
              (!filter.authors || filter.authors.includes(event.pubkey)) &&
              (!filter['#d'] || event.tags.some(([key, value]) => key === 'd' && filter['#d']?.includes(value))) &&
              event.created_at >= (filter.since ?? 0) && event.created_at <= (filter.until ?? Infinity));
            for (const event of events.slice(0, filter.limit ?? events.length)) matches.set(event.id, event);
          }
          respond({type: request.type + '.result', id: request.id, events: [...matches.values()].map(event => ({event}))});
        }
      },
    };
  }, {catalogEvents, feedEvents});
  await page.goto('/assets/runtime/index.html?sessionId=discovery-browser&fixture=' + fixture);
  await expect.poll(() => page.evaluate(() => (window as unknown as TestWindow).discoveryOpenTest.ready)).toBe(true);
  return page.frames().find(frame => frame.parentFrame() === page.mainFrame())!;
}

test('packaged Discover scopes late and completed row feedback to its search', async ({page}) => {
  const artifact = 'c'.repeat(64);
  const aggregate = createHash('sha256').update(`${artifact} /index.html\n`).digest('hex');
  const event = finalizeEvent({kind: 35129, created_at: Math.floor(Date.now() / 1000) - 10,
    content: 'A local signed catalog control.', tags: [['d', 'feedback-control'],
      ['title', 'Feedback control'], ['path', '/index.html', artifact], ['x', aggregate, 'aggregate']]},
    new Uint8Array(32).fill(1));
  const guest = await openRuntime(page, 'napplet-discovery', [{event}]);
  const open = guest.getByRole('button', {name: 'Open Feedback control', exact: true});
  const search = guest.getByRole('searchbox', {name: 'Search Napplets'});
  const feedback = guest.locator('#row-open-status');
  await open.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as TestWindow).discoveryOpenTest.calls.length)).toBe(1);
  const calls = await page.evaluate(() => (window as unknown as TestWindow).discoveryOpenTest.calls);
  expect(calls[0]).toEqual({type: 'link.open', id: expect.any(String),
    url: 'nostr:' + naddrEncode({kind: 35129, pubkey: event.pubkey, identifier: 'feedback-control'})});
  await search.fill('A different search');
  await expect(guest.getByText('No matches in the loaded results.')).toBeVisible();
  await page.evaluate(() => (window as unknown as TestWindow).discoveryOpenTest.finish?.('opened'));
  await expect(feedback).toBeHidden();
  await expect(feedback).toBeEmpty();
  await expect(search).toBeFocused();

  await guest.getByRole('button', {name: 'Clear search'}).click();
  await open.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as TestWindow).discoveryOpenTest.calls.length)).toBe(2);
  await page.evaluate(() => (window as unknown as TestWindow).discoveryOpenTest.finish?.('opened'));
  await expect(feedback).toHaveText('Link accepted by your shell.');
  await search.fill('Another different search');
  await expect(feedback).toBeHidden();
  await expect(feedback).toBeEmpty();
  await expect(search).toBeFocused();
});

for (const declaration of ['R', 'O']) {
  test(`packaged Discover displays publisher-declared Outbox access for ${declaration}`, async ({page}) => {
    const event = finalizeEvent({kind: 35129, created_at: Math.floor(Date.now() / 1000) - 10,
      content: 'Independent Outbox catalog control.', tags: [['d', 'outbox-control'],
        ['title', 'Independent Outbox'], ['x', 'c'.repeat(64)], [declaration, 'outbox']]},
      new Uint8Array(32).fill(1));
    const guest = await openRuntime(page, 'napplet-discovery', [{event}]);
    await guest.getByRole('button', {name: 'Details for Independent Outbox', exact: true}).click();
    const required = guest.getByRole('list', {name: 'Required access requested by the publisher', exact: true});
    if (declaration === 'R') {
      await expect(required).toBeVisible();
      await expect(required.getByRole('listitem')).toHaveText(['Outbox routing']);
    } else {
      await expect(required).toHaveCount(0);
      await expect(guest.getByText('No required access declared.', {exact: true})).toBeVisible();
    }
    await expect(guest.locator('.access-consequence')).toHaveCount(0);
    await guest.getByLabel('Access details', {exact: true}).click();
    await expect(guest.getByRole('heading', {name: declaration === 'R' ? 'Required' : 'Optional', exact: true})).toBeVisible();
    const capability = guest.locator('.access-details .cap-row');
    await expect(capability).toHaveCount(1);
    await expect(capability.getByText('Outbox routing', {exact: true})).toBeVisible();
    await expect(capability.getByText('Read Nostr events or ask to publish using the relays associated with the accounts involved.', {exact: true})).toBeVisible();
    await expect(guest.getByText('These are publisher requests. Your shell decides which access is available.', {exact: true})).toBeVisible();
    await expect(capability).not.toContainText('unavailable');
    await guest.getByRole('button', {name: 'Open Napplet', exact: true}).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as TestWindow).discoveryOpenTest.calls.length)).toBe(1);
    const calls = await page.evaluate(() => (window as unknown as TestWindow).discoveryOpenTest.calls);
    expect(calls[0]).toEqual({type: 'link.open', id: expect.any(String),
      url: 'nostr:' + naddrEncode({kind: 35129, pubkey: event.pubkey, identifier: 'outbox-control'})});
    await page.evaluate(() => (window as unknown as TestWindow).discoveryOpenTest.finish?.('opened'));
    await expect(guest.locator('.detail-actions .feedback')).toHaveText('Link accepted by your shell.');
  });
}

test('packaged Discover leaves Home shortcuts to the shell and receives no proprietary interfaces', async ({page}) => {
  const event = finalizeEvent({kind: 35129, created_at: Math.floor(Date.now() / 1000) - 10,
    content: 'Pin test', tags: [['d', 'pin-control'], ['title', 'Pin control'], ['x', 'c'.repeat(64)]]}, new Uint8Array(32).fill(1));
  const guest = await openRuntime(page, 'napplet-discovery', [{event}]);
  await guest.getByRole('button', {name: 'Details for Pin control', exact: true}).click();
  await expect(guest.getByRole('button', {name: /pin.+home/i})).toHaveCount(0);
  expect(await guest.evaluate(() => ['hypergolic', 'hypergolicSupportReport'].filter(key => key in window))).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as TestWindow).discoveryOpenTest.calls)).toEqual([]);
});

test('an attributed community pick opens the signed listing and returns to the feed', async ({page}) => {
  const creator = new Uint8Array(32).fill(1), reader = new Uint8Array(32).fill(2);
  const created_at = Math.floor(Date.now() / 1000) - 15;
  const app = finalizeEvent({kind: 35129, created_at, content: 'Play a round against a friend.',
    tags: [['d', 'catalog-game'], ['title', 'Catalog game'], ['x', 'c'.repeat(64)]]}, creator);
  const list = finalizeEvent({kind: 30267, created_at, content: '',
    tags: [['d', 'napplets'], ['a', '35129:' + app.pubkey + ':catalog-game']]}, reader);
  const profile = finalizeEvent({kind: 0, created_at, tags: [], content: JSON.stringify({name: 'River'})}, reader);
  const guest = await openRuntime(page, 'napplet-discovery', [{event: app}], [list, profile]);
  const card = guest.locator('#community-recommendation');
  await expect(card).toContainText('River');
  await card.locator('[data-community-app]').click();
  await expect(guest.locator('#detail-heading')).toHaveText('Catalog game');
  await guest.getByRole('button', {name:'Back to Discover', exact:true}).click();
  await expect(card).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as TestWindow).discoveryOpenTest.calls)).toEqual([]);
});

test('packaged Discover opens an off-page community pick through NAP-LINK', async ({page}) => {
  const author = new Uint8Array(32).fill(1), recommender = new Uint8Array(32).fill(2);
  const now = Math.floor(Date.now() / 1000);
  const publication = (identifier: string, title: string, age: number) => finalizeEvent({
    kind: 35129, created_at: now - age, content: title + ' description.',
    tags: [['d', identifier], ['title', title], ['x', 'c'.repeat(64)]],
  }, author);
  const recent = Array.from({length: 8}, (_, index) => publication('recent-' + index, 'Recent ' + index, index + 1));
  const target = publication('older-game', 'Older game', 1000);
  const list = finalizeEvent({kind: 30267, created_at: now - 1, content: '',
    tags: [['d', 'napplets'], ['a', '35129:' + target.pubkey + ':older-game']]}, recommender);
  const guest = await openRuntime(page, 'napplet-discovery', [...recent, target].map(event => ({event})), [list]);
  await expect(guest.getByRole('button', {name: 'Details for Recent 7', exact: true})).toBeVisible();
  await expect(guest.getByRole('button', {name: 'Details for Older game', exact: true})).toHaveCount(0);
  const card = guest.locator('#community-recommendation');
  await card.getByRole('button', {name: /^Details for Older game recommended by /}).click();
  await expect(guest.locator('#detail-heading')).toHaveText('Older game');
  await guest.getByRole('button', {name: 'Open Napplet', exact: true}).click();
  const url = 'nostr:' + naddrEncode({kind: 35129, pubkey: target.pubkey, identifier: 'older-game'});
  await expect.poll(() => page.evaluate(() => (window as unknown as TestWindow).discoveryOpenTest.calls))
    .toEqual([{type: 'link.open', id: expect.any(String), url}]);
  await page.evaluate(() => (window as unknown as TestWindow).discoveryOpenTest.finish?.('opened'));
  await expect(guest.locator('.detail-actions .feedback')).toHaveText('Link accepted by your shell.');
});
