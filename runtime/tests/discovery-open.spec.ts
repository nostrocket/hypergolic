import { expect, test, type Page } from '@playwright/test';
import { naddrEncode } from 'nostr-tools/nip19';

const type = 'hypergolic.publishedOpen';
const address = naddrEncode({kind: 35129, pubkey: 'a'.repeat(64), identifier: 'discovery-open-test'});
const expectedEventId = 'b'.repeat(64);
const target = {address, expectedEventId};
type Request = {type: string; id: string; address: string; expectedEventId: string};
type State = { ready: boolean; calls: Request[]; finish?: (status: string) => void };
type TestWindow = Window & { discoveryOpenTest: State; HypergolicHost: object };
type GuestWindow = Window & { hypergolic?: { publishedOpen?: {
  version: number; open(address: string, expectedEventId: string): Promise<{status: string}>;
} }; receivedOpenStatus?: string };

async function openRuntime(page: Page, fixture: string) {
  await page.addInitScript(() => {
    if (window !== window.top) return;
    const root = window as unknown as TestWindow;
    const state: State = { ready: false, calls: [] };
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
