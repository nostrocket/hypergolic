import {expect, test, type Page} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {finalizeEvent} from 'nostr-tools/pure';
import {createNativeRelayQuery} from '../../src/network/native-relay-query.ts';
import {parseRelayQuery} from '../../src/network/relay-query-contract.ts';
import {createRelaySubscriptions} from '../../src/network/relay-subscriptions.ts';
import {DISCOVERY_BUNDLE} from '../../src/runtime/discovery-bundle.ts';

const peers = ['wss://fast.example.org', 'wss://silent.example.org', 'wss://tail.example.org'];
const publication = finalizeEvent({kind:35129, created_at:1, content:'Independent signed listing.',
  tags:[['d','fast'],['title','Fast directory listing'],['x','c'.repeat(64)]]}, new Uint8Array(32).fill(1));
type Scenario = 'fast' | 'silent' | 'empty';
type Envelope = {type: string; sessionId: string; sequence: number; message?: string};
type BrowserHost = Window & {nativeSend(raw: string): Promise<void>; receive(raw: string): void; HypergolicHost: object};

// Exercise the shipped guest, SDK, runtime bridge and both production relay
// transports. Only the native socket frames and envelope delivery are controlled.
async function start(page: Page, mode: Scenario) {
  const generation = 'directory-first-page';
  const attempts: string[] = [], limits: number[] = [];
  const held = new Map<string, () => void>();
  let stopped = 0, reads = 0, closed = false, slowReleased = false;
  let firstRequest: number | undefined;
  const manager = createRelaySubscriptions({newInstanceId:randomUUID,open(_id,url,_wire,sub,frame) {
    if (mode === 'fast' && url === peers[0]) queueMicrotask(() => {
      frame(JSON.stringify(['EVENT',sub,publication]));
      frame(JSON.stringify(['EOSE',sub]));
    });
    return () => {stopped++;};
  }}, () => peers);
  const streams = manager.session({registration:{sessionId:generation,generation,epoch:0,user:'1'.repeat(64),
    publisher:'2'.repeat(64),appId:DISCOVERY_BUNDLE.appId,version:DISCOVERY_BUNDLE.aggregateHash,
    instanceId:'catalog',fixture:'napplet-discovery',domains:DISCOVERY_BUNDLE.domains},assertActive() {}});
  const transport = createNativeRelayQuery({newInstanceId:randomUUID,cancelPublishedRelay(id) {held.get(id)?.();},
    async queryPublishedRelay(id,url,wire,sub) {
      const filter = JSON.parse(wire)[2];
      if (!filter.kinds?.includes(35129)) return [JSON.stringify(['EOSE',sub])];
      attempts.push(url);
      if (mode === 'silent' || url === peers[1] && !slowReleased) {
        await new Promise<void>((_,reject) => held.set(id,() => {held.delete(id);reject(Error('offline'));}));
      }
      return [...(mode === 'fast' && url === peers[0] ? [JSON.stringify(['EVENT',sub,publication])] : []),
        JSON.stringify(['EOSE',sub])];
    }}, () => peers);
  const controller = new AbortController();
  async function push(envelope: object) {
    if (!closed) await page.evaluate(raw => (window as BrowserHost).receive(raw), JSON.stringify(envelope));
  }
  await page.exposeBinding('nativeSend', async ({frame}, raw: string) => {
    if (frame !== page.mainFrame() || closed) return;
    const envelope: Envelope = JSON.parse(raw);
    if (!envelope.message) return;
    const request = JSON.parse(envelope.message);
    const base = {sessionId:envelope.sessionId,sequence:envelope.sequence};
    if (envelope.type === 'relay-stream' && request.type === 'relay.subscribe') {
      firstRequest ??= performance.now();
      let delivery = 0;
      streams.subscribe(request, response => {
        void push({...base,type:'capability.stream',delivery:++delivery,response:JSON.stringify(response)}).catch(() => {});
        return true;
      });
    }
    if (envelope.type !== 'capability') return;
    if (request.type === 'relay.close') {streams.close(request); return;}
    if (request.type !== 'relay.query') return;
    const parsed = parseRelayQuery(request);
    if (parsed.filters[0]?.kinds?.includes(35129)) {
      firstRequest ??= performance.now();
      reads++; limits.push(parsed.filters[0].limit as number);
    }
    const result = await transport.query(parsed.filters,controller.signal,() => {}).then(events => ({events}),() => ({error:'relay query failed'}));
    await push({...base,type:'capability.result',response:JSON.stringify({type:'relay.query.result',id:request.id,...result})});
  });
  await page.addInitScript(() => {
    if (window !== window.top) return;
    const root = window as BrowserHost, listeners = new Set<(event: {data:string}) => void>();
    root.receive = data => {for (const listener of listeners) listener({data});};
    root.HypergolicHost = {addEventListener:(_: string, fn: (event: {data:string}) => void) => listeners.add(fn),
      removeEventListener:(_: string, fn: (event: {data:string}) => void) => listeners.delete(fn),
      postMessage(raw: string) {void root.nativeSend(raw);}};
  });
  await page.goto('/assets/runtime/index.html?sessionId=' + generation + '&fixture=napplet-discovery');
  return {guest:page.frameLocator('#napplet'), attempts, limits, reads:() => reads, stopped:() => stopped,
    recordTiming() {
      return test.info().attach('first-page-timing.json', {contentType:'application/json',body:JSON.stringify({
        browser:test.info().project.name, scenario:mode, observedWithinMs:Math.round(performance.now() - firstRequest!),
        measurement:'First native directory request to Playwright observing the visible UI', queries:reads, limits, peersStarted:attempts,
      })});
    },
    release() {slowReleased = true; for (const stop of [...held.values()]) stop();},
    close() {closed = true; controller.abort(); manager.revokeAll();}};
}

test('signed first row is usable while the selected silent peer still holds the ordinary query', async ({page}) => {
  const run = await start(page, 'fast');
  try {
    await expect(run.guest.getByRole('button',{name:'Open Fast directory listing'})).toBeVisible({timeout:3000});
    await run.recordTiming();
    await expect(run.guest.getByText('Checking the relays…')).toBeVisible();
    expect(run.attempts).toContain(peers[1]);
    expect(run.reads()).toBe(1);
    run.release();
    await expect(run.guest.locator('#coverage')).toContainText('1 page checked');
    await expect.poll(run.stopped).toBe(2);
    expect(run.attempts).toEqual(peers);
  } finally {run.close();}
});

test('three silent peers yield a first-visit Retry under one deadline without shrinking the request', async ({page}) => {
  const run = await start(page,'silent');
  try {
    await expect(run.guest.getByRole('button',{name:'Retry',exact:true})).toBeVisible({timeout:7000});
    await run.recordTiming();
    await expect(run.guest.locator('#notice')).toContainText('Check your connection or relay settings');
    expect(run.limits).toEqual([8]);
    await expect.poll(run.stopped).toBe(2);
    expect(new Set(run.attempts).size).toBe(run.attempts.length);
    await expect(run.guest.locator('#empty')).toBeHidden();
  } finally {run.close();}
});

test('an empty page with a failed peer names reachable relays and offers a refresh', async ({page}) => {
  const run = await start(page,'empty');
  try {
    await expect.poll(() => run.attempts.length).toBe(3);
    run.release();
    await expect(run.guest.locator('#empty')).toContainText('Reachable relays returned no eligible');
    await expect(run.guest.getByRole('button',{name:'Refresh',exact:true})).toBeVisible();
    expect(run.limits).toEqual([8]);
  } finally {run.close();}
});
