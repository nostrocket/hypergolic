import { expect, test, type Page } from '@playwright/test';
import { naddrEncode } from 'nostr-tools/nip19';

const type = 'hypergolic.publishedOpen';
const address = naddrEncode({kind: 35129, pubkey: 'a'.repeat(64), identifier: 'discovery-open-test'});
const expectedEventId = 'b'.repeat(64);
const target = {address, expectedEventId};
type Request = {type: string; id: string; address: string; expectedEventId: string};
type State = { ready: boolean; calls: Request[]; catalogCalls: object[]; finish?: (status: string) => void };
type TestWindow = Window & { discoveryOpenTest: State; HypergolicHost: object };
type GuestWindow = Window & { hypergolic?: { publishedOpen?: {
  version: number; open(address: string, expectedEventId: string): Promise<{status: string; reason?: string}>;
}; catalogPage?: {
  version: number; read(reset: boolean, round: string, after: number): Promise<unknown>;
} }; receivedOpenStatus?: string; receivedOpenResult?: {status: string; reason?: string} };

async function openRuntime(page: Page, fixture: string) {
  await page.addInitScript(() => {
    if (window !== window.top) return;
    const root = window as unknown as TestWindow;
    const state: State = { ready: false, calls: [], catalogCalls: [] };
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
        if (request.type === 'routing.call' && request.message.type === 'hypergolic.publishedOpen') {
          state.calls.push(request.message);
          state.finish = status => respond({type: 'routing.call.result', id: request.id, response: status});
        }
        if (request.type === 'relay.catalogPage') {
          state.catalogCalls.push(request);
          respond({type: 'relay.catalogPage.result', id: request.id, result: {
            page: request.after + 1, until: Math.floor(Date.now() / 1000), events: [],
            more: false, partial: false, gap: false, bounded: false,
          }});
        }
        if (request.type === 'relay.query') respond({type: 'relay.query.result', id: request.id, events: []});
      },
    };
  });
  await page.goto('/assets/runtime/index.html?sessionId=discovery-browser&fixture=' + fixture);
  await expect.poll(() => page.evaluate(() => (window as unknown as TestWindow).discoveryOpenTest.ready)).toBe(true);
  return page.frames().find(frame => frame.parentFrame() === page.mainFrame())!;
}

test('authorized discovery exposes one exact request and only the captured native receipt', async ({page}) => {
  const guest = await openRuntime(page, 'napplet-discovery');
  const second = await guest.evaluate(async ({address, expectedEventId, type}) => {
    const root = window as GuestWindow;
    parent.postMessage({type, id: 'forged', address, expectedEventId, token: 'wrong-document'}, '*');
    const api = root.hypergolic?.publishedOpen;
    if (api?.version !== 1) throw new Error('Discovery open unavailable');
    void api.open(address, expectedEventId).then(result => { root.receivedOpenStatus = result.status; });
    return (await api.open(address, expectedEventId)).status;
  }, {...target, type});
  expect(second).toBe('busy');
  const calls = () => page.evaluate(() => (window as unknown as TestWindow).discoveryOpenTest.calls);
  await expect.poll(async () => (await calls()).length).toBe(1);
  expect((await calls())[0]).toEqual({type, id: expect.any(String), ...target});
  expect(await guest.evaluate(() => (window as GuestWindow).receivedOpenStatus)).toBeUndefined();
  await page.evaluate(() => (window as unknown as TestWindow).discoveryOpenTest.finish?.('opened'));
  await expect.poll(() => guest.evaluate(() => (window as GuestWindow).receivedOpenStatus)).toBe('opened');
});

test('ordinary bundled guests cannot acquire the discovery launch transport', async ({page}) => {
  const guest = await openRuntime(page, 'nap-support');
  expect(await guest.evaluate(({address, expectedEventId, type}) => {
    parent.postMessage({type, id: 'forged', address, expectedEventId, token: 'fake'}, '*');
    return Boolean((window as GuestWindow).hypergolic?.publishedOpen);
  }, {...target, type})).toBe(false);
  expect(await page.evaluate(() => (window as unknown as TestWindow).discoveryOpenTest.calls)).toEqual([]);
});


test('keeps the version-one result status and attaches only allowed load reasons', async ({page}) => {
  const guest = await openRuntime(page, 'napplet-discovery');
  for (const [reason, expected] of [
    ['lookup-unavailable', {status: 'failed', reason: 'lookup-unavailable'}],
    ['download-unavailable', {status: 'failed', reason: 'download-unavailable'}],
    ['hash-mismatch', {status: 'failed', reason: 'hash-mismatch'}],
    ['invalid-html', {status: 'failed', reason: 'invalid-html'}],
    ['stage-unavailable', {status: 'failed', reason: 'stage-unavailable'}],
    ['workspace-full', {status: 'unavailable', reason: 'workspace-full'}],
    ['opaque native detail', {status: 'unavailable'}],
  ] as const) {
    const previous = await page.evaluate(() => (window as unknown as TestWindow).discoveryOpenTest.calls.length);
    await guest.evaluate(({address, expectedEventId}) => {
      const root = window as GuestWindow;
      delete root.receivedOpenResult;
      void root.hypergolic!.publishedOpen!.open(address, expectedEventId)
        .then(result => {root.receivedOpenResult = result;});
    }, target);
    await expect.poll(() => page.evaluate(() => (window as unknown as TestWindow).discoveryOpenTest.calls.length)).toBe(previous + 1);
    await page.evaluate(reason => (window as unknown as TestWindow).discoveryOpenTest.finish?.(reason), reason);
    await expect.poll(() => guest.evaluate(() => (window as GuestWindow).receivedOpenResult)).toEqual(expected);
  }
});


test('catalog paging is exact-Discover-only and carries no destinations or filter authority', async ({page}) => {
  const guest = await openRuntime(page, 'napplet-discovery');
  const round = 'a'.repeat(32);
  const result = await guest.evaluate(async round => {
    const api = (window as GuestWindow).hypergolic?.catalogPage;
    if (api?.version !== 1) throw Error('Catalog paging unavailable');
    parent.postMessage({type: 'relay.catalogPage', id: 'forged', reset: true, round, after: 0, token: 'wrong-document'}, '*');
    return api.read(true, round, 0);
  }, round);
  expect(result).toEqual({page: 1, until: expect.any(Number), events: [], more: false,
    partial: false, gap: false, bounded: false});
  const calls = await page.evaluate(() => (window as unknown as TestWindow).discoveryOpenTest.catalogCalls);
  expect(calls).toContainEqual({type: 'relay.catalogPage', id: expect.any(String), reset: true, round, after: 0});
  expect(calls).not.toContainEqual(expect.objectContaining({id: 'forged'}));
  const ordinary = await openRuntime(page, 'nap-support');
  expect(await ordinary.evaluate(() => Boolean((window as GuestWindow).hypergolic?.catalogPage))).toBe(false);
});
