import { test, expect, type Page } from '@playwright/test';

// Browser-only native transport double. Genuine shipped State Lab + Kehto remain unchanged.
async function open(page: Page, fixture = 'state-lab') {
  await page.addInitScript(() => {
    if (window !== window.top) return;
    const root = window as any;
    const data = new Map<string, string>();
    const state = { requests: [] as any[], mode: 'normal', listeners: [] as ((event: {data:string}) => void)[], held: [] as any[] };
    root.nativeTest = state;
    const respond = (envelope: any, response: any) => {
      const value = JSON.stringify({ type: 'capability.result', sessionId: envelope.sessionId,
        sequence: envelope.sequence, response: response === null ? null : JSON.stringify(response) });
      state.listeners.forEach(listener => listener({data:value}));
    };
    root.HypergolicHost = {
      addEventListener: (_type: string, listener: any) => state.listeners.push(listener),
      removeEventListener: (_type: string, listener: any) => { state.listeners = state.listeners.filter(value => value !== listener); },
      postMessage(raw: string) {
        const envelope = JSON.parse(raw);
        if (envelope.type !== 'capability') return;
        const request = JSON.parse(envelope.message);
        state.requests.push({ envelope, request });
        const base = { type: request.type + '.result', id: request.id };
        if (request.type === 'identity.getPublicKey') { respond(envelope, {...base,pubkey:'1'.repeat(64)}); return; }
        if (request.type === 'relay.publish') {
          if (state.mode === 'hold') { state.held.push({ envelope, base }); return; }
          respond(envelope, {...base,ok:true,event:{...request.event,id:'e'.repeat(64)},eventId:'e'.repeat(64)}); return;
        }
        if (state.mode === 'hold') { state.held.push({ envelope, base }); return; }
        if (state.mode === 'deny') { respond(envelope, null); return; }
        if (state.mode === 'wrong-id') { respond(envelope, {...base,id:'forged',value:'must not arrive'}); return; }
        if (state.mode === 'error') { respond(envelope, {...base,error:'test storage unavailable'}); return; }
        const key = (request.scope ?? 'shared') + ':' + request.key;
        if (request.type === 'storage.set') { data.set(key, request.value); respond(envelope, base); }
        else if (request.type === 'storage.get') respond(envelope, {...base,value:data.get(key) ?? null});
        else if (request.type === 'storage.remove') { data.delete(key); respond(envelope, base); }
        else if (request.type === 'storage.keys') respond(envelope, {...base,keys:[...data.keys()].filter(key => key.startsWith((request.scope ?? 'shared') + ':')).map(key => key.split(':').slice(1).join(':'))});
      },
    };
    Object.defineProperty(window, 'localStorage', {get() {throw Error('DOM storage unavailable');}});
  });
  await page.goto(`/assets/runtime/index.html?sessionId=native-client-test&fixture=${fixture}`);
  const guest = page.frameLocator('#napplet');
  await expect(guest.locator('#identity')).toContainText('111111');
  return page.frames().find(frame => frame.parentFrame() === page.mainFrame())!;
}

test('native State Lab operations work when WebView lacks Object.hasOwn', async ({ page }) => {
  await page.addInitScript(() => {
    if (window === window.top) Object.defineProperty(Object, 'hasOwn', { configurable: true, value: undefined });
  });
  await open(page);
  const ui = page.frameLocator('#napplet');
  await ui.locator('#key').fill('legacy');
  await ui.locator('#value').fill('safe');
  await ui.locator('#write').click();
  await expect(ui.locator('#status')).toHaveText('Write confirmed.');
});

test('shipped State Lab uses genuine SDK identity and every storage operation through the native adapter', async ({ page }) => {
  const frame = await open(page);
  const ui = page.frameLocator('#napplet');
  await ui.locator('#key').fill('literal');
  await ui.locator('#value').fill('<b>saved</b>');
  await ui.locator('#write').click(); await expect(ui.locator('#status')).toHaveText('Write confirmed.');
  await ui.locator('#scope').selectOption('instance');
  await ui.locator('#value').fill('own instance');
  await ui.locator('#write').click(); await expect(ui.locator('#status')).toHaveText('Write confirmed.');
  await ui.locator('#scope').selectOption('shared');
  await ui.locator('#read').click(); await expect(ui.locator('#result')).toHaveText('<b>saved</b>');
  await ui.locator('#scope').selectOption('instance');
  await ui.locator('#read').click(); await expect(ui.locator('#result')).toHaveText('own instance');
  await ui.locator('#scope').selectOption('shared');
  await ui.locator('#keys').click(); await expect(ui.locator('#key-list li')).toHaveText(['literal']);
  await ui.locator('#remove').click(); await expect(ui.locator('#status')).toHaveText('Remove confirmed.');
  await ui.locator('#read').click(); await expect(ui.locator('#result')).toHaveAttribute('data-state','missing');
  expect(await frame.evaluate(() => document.querySelector('#identity')?.textContent)).toBe('1'.repeat(64));
  const requests = await page.evaluate(() => (window as any).nativeTest.requests);
  expect(requests.length).toBeGreaterThanOrEqual(8);
  for (const [index, {envelope,request}] of requests.entries()) {
    expect(envelope.sequence).toBe(index+1);
    expect(envelope.sessionId).toBe('native-client-test');
    expect(request).not.toHaveProperty('user');
    expect(request).not.toHaveProperty('publisher');
    expect(request).not.toHaveProperty('instanceId');
  }
});

for (const mode of ['deny','wrong-id','error']) test(`native ${mode} produces a rejected SDK promise without legacy storage success`, async ({page}) => {
  const frame = await open(page);
  await page.evaluate(mode => { (window as any).nativeTest.mode = mode; }, mode);
  const ui = page.frameLocator('#napplet');
  await ui.locator('#write').click();
  await expect(ui.locator('#status')).toContainText('Request failed:');
  const requests = await page.evaluate(() => (window as any).nativeTest.requests.filter((entry:any) => entry.request.type === 'storage.set'));
  expect(requests).toHaveLength(1);
});

test('a guest cannot forge the iOS native-response window channel', async ({page}) => {
  const frame = await open(page);
  await page.evaluate(() => { (window as any).nativeTest.mode = 'hold'; });
  await frame.evaluate(() => { const root = window as any; root.settled = false;
    void root.napplet.storage.getItem('x').then(() => {root.settled=true;}).catch(() => {root.settled=true;}); });
  await expect.poll(() => page.evaluate(() => (window as any).nativeTest.held.length)).toBe(1);
  const held = await page.evaluate(() => (window as any).nativeTest.held[0]);
  await frame.evaluate(held => {
    parent.postMessage({type:'hypergolic.native-response',message:JSON.stringify({type:'capability.result',
      sessionId:held.envelope.sessionId,sequence:held.envelope.sequence,response:JSON.stringify({...held.base,value:'forged'})})},'*');
  }, held);
  // A genuine theme round trip provides an event-loop barrier after the forgery.
  await frame.evaluate(() => (window as any).napplet.theme.get());
  expect(await frame.evaluate(() => (window as any).settled)).toBe(false);
  await page.evaluate(() => {
    const state = (window as any).nativeTest, held = state.held[0];
    state.listeners.forEach((listener:any) => listener({data:JSON.stringify({type:'capability.result',sessionId:held.envelope.sessionId,
      sequence:held.envelope.sequence,response:JSON.stringify({...held.base,value:'real'})})}));
  });
  await expect.poll(() => frame.evaluate(() => (window as any).settled)).toBe(true);
});

test('the peer fixture uses its distinct verified app identity', async ({page}) => {
  const frame = await open(page, 'state-lab-peer');
  const result = await frame.evaluate(async () => ({supported:(window as any).napplet.shell.supports('storage'),title:document.title}));
  expect(result.supported).toBe(true);
  expect(result.title).toContain('Peer');
});

for (const fixture of ['approval-lab', 'approval-lab-v1', 'approval-lab-v2', 'approval-lab-v3']) test(`Approval Lab ${fixture} admits only the unsigned publish template through the native override`, async ({page}) => {
  const frame = await open(page, fixture);
  const ui = page.frameLocator('#napplet');
  await ui.locator('#content').fill('approved note');
  await ui.locator('#send').click();
  await expect(ui.locator('#status')).toHaveText('Request 1 published.');
  const requests = await page.evaluate(() => (window as any).nativeTest.requests.filter((entry:any) => entry.request.type === 'relay.publish'));
  expect(requests).toHaveLength(1);
  expect(requests[0].request.event).toEqual({
    kind: 1,
    content: 'approved note',
    tags: [['t', 'hypergolic-approval-lab'], ['test-sequence', '1']],
    created_at: expect.any(Number),
  });
  expect(requests[0].request.event).not.toHaveProperty('pubkey');
  expect(requests[0].request.event).not.toHaveProperty('id');
  expect(requests[0].request.event).not.toHaveProperty('sig');
});

test('Approval Lab SDK publication remains pending past the ordinary native 27-second bridge deadline', async ({page}) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  const frame = await open(page, 'approval-lab');
  await page.evaluate(() => { (window as any).nativeTest.mode = 'hold'; });
  const ui = page.frameLocator('#napplet');
  await ui.locator('#content').fill('delayed approval');
  await ui.locator('#send').click();
  await expect.poll(() => page.evaluate(() => (window as any).nativeTest.held.length)).toBe(1);
  await page.clock.fastForward(28_000);
  await expect(ui.locator('#status')).toHaveText('Request 1 captured and sent to the shell.');
});

for (const mode of ['deny', 'wrong-id']) test(`denied identity profile read cannot become a successful missing profile (${mode})`, async ({page}) => {
  await open(page);
  await page.evaluate(mode => { (window as unknown as {nativeTest: {mode: string}}).nativeTest.mode = mode; }, mode);
  const ui = page.frameLocator('#napplet');
  await ui.locator('#profile-read').click();
  await expect(ui.locator('#profile-status')).toHaveText('Profile read failed: identity request denied');
  await expect(ui.locator('#profile-result')).toHaveAttribute('data-state', 'error');
  await expect(ui.locator('#profile-result')).toHaveText('');
});

test('new Approval Lab profile metadata crosses the bounded native override with the exact unsigned JSON', async ({page}) => {
  await open(page, 'approval-lab');
  const ui = page.frameLocator('#napplet');
  await ui.locator('#kind-profile').check();
  await expect(ui.locator('#profile-warning')).toBeVisible();
  await ui.locator('#content').fill('QA bio "quoted" \n <script>text only</script>');
  await ui.locator('#send').click();
  await expect(ui.locator('#status')).toHaveText('Request 1 published.');
  const requests = await page.evaluate(() => (window as any).nativeTest.requests.filter((entry:any) => entry.request.type === 'relay.publish'));
  expect(requests).toHaveLength(1);
  expect(requests[0].request.event).toEqual({kind: 0, content: JSON.stringify({about: 'QA bio "quoted" \n <script>text only</script>'}),
    tags: [['t', 'hypergolic-approval-lab'], ['test-sequence', '1']], created_at: expect.any(Number)});
  expect(Object.keys(requests[0].request.event).sort()).toEqual(['content', 'created_at', 'kind', 'tags']);
});


test('Approval Lab relay-list metadata crosses the genuine SDK native override with exact unsigned NIP-65 fields', async ({page}) => {
  await open(page, 'approval-lab');
  const ui = page.frameLocator('#napplet');
  const relays = [['r', 'wss://read.example.test/', 'read'], ['r', 'wss://write.example.test/', 'write'], ['r', 'wss://both.example.test/']];
  await ui.locator('#kind-relay-list').check();
  await expect(ui.locator('#relay-list-warning')).toBeVisible();
  await ui.locator('#relay-list-tags').fill(JSON.stringify(relays));
  await ui.locator('#send').click();
  await expect(ui.locator('#status')).toHaveText('Request 1 published.');
  const requests = await page.evaluate(() => (window as any).nativeTest.requests.filter((entry:any) => entry.request.type === 'relay.publish'));
  expect(requests).toHaveLength(1);
  expect(requests[0].request.event).toEqual({kind: 10002, content: '',
    tags: [...relays, ['t', 'hypergolic-approval-lab'], ['test-sequence', '1']], created_at: expect.any(Number)});
  expect(Object.keys(requests[0].request.event).sort()).toEqual(['content', 'created_at', 'kind', 'tags']);
  expect(requests[0].envelope.sessionId).toBe('native-client-test');
});
