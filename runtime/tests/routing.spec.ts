import {test,expect,type Page} from '@playwright/test';
// Browser transport doubles verify shipped SDK/adapters; they are not native workflow proof.
async function open(page: Page) {
  await page.addInitScript(() => {
    if (window !== window.top) return;
    const root = window as any, listeners = new Set<(event: {data: string}) => void>();
    const state = {calls: [] as any[], sequences: [] as number[], acks: [] as any[], delivery: 0, mode: 'normal'};
    root.routingNative = state;
    root.routingPush = (message: any, generation = 'routing-browser') => {
      const raw = JSON.stringify({type: 'routing.event', sessionId: generation, delivery: ++state.delivery, response: JSON.stringify(message)});
      listeners.forEach(listener => listener({data: raw}));
    };
    root.HypergolicHost = {
      addEventListener: (_: string, listener: any) => listeners.add(listener), removeEventListener: (_: string, listener: any) => listeners.delete(listener),
      postMessage(raw: string) {
        const envelope = JSON.parse(raw);
        if (envelope.type === 'routing-ack') {state.acks.push(envelope); state.sequences.push(envelope.sequence); return;}
        if (envelope.type !== 'capability') return;
        state.sequences.push(envelope.sequence);
        const wrapper = JSON.parse(envelope.message); if (wrapper.type !== 'routing.call') throw Error('Unexpected transport');
        const message = wrapper.message; state.calls.push(message);
        const available = {archetype: 'note', available: true, candidates: [{dTag: 'native-bound-handler', title: 'Handler', actions: ['open'], conventions: ['napplet:note/open'], isDefault: false}], hasDefault: false};
        let response: any = null;
        if (message.type === 'intent.available') response = {type: message.type + '.result', id: message.id, availability: available};
        if (message.type === 'intent.handlers') response = {type: message.type + '.result', id: message.id, handlers: [available]};
        if (message.type === 'intent.invoke') response = {type: message.type + '.result', id: message.id, result: {ok: true, handled: true, archetype: message.request.archetype, action: message.request.action, handler: 'native-bound-handler', windowId: 'actual-native-target', convention: message.request.convention}};
        if (message.type === 'inc.subscribe') response = {type: message.type + '.result', id: message.id, ...(state.mode === 'deny' ? {error: 'user denied'} : {})};
        if (message.type === 'inc.channel.open') response = {type: 'inc.channel.open.result', id: message.id, channelId: 'native-channel', peer: message.target};
        const result = {type: 'routing.call.result', id: wrapper.id, response};
        if (state.mode === 'wrong-id') result.id = 'forged-wrapper';
        const data = JSON.stringify({type: 'capability.result', sessionId: envelope.sessionId, sequence: envelope.sequence, response: state.mode === 'revoked' ? null : JSON.stringify(result)});
        listeners.forEach(listener => listener({data}));
      },
    };
  });
  await page.goto('/assets/runtime/index.html?sessionId=routing-browser&fixture=routing-lab');
  const guest = page.frameLocator('#napplet'); await expect(guest.locator('#lab')).toHaveAttribute('data-ready', 'true');
  await expect.poll(() => page.evaluate(() => (window as any).routingNative.calls.some((value: any) => value.type === 'routing.__register'))).toBe(true);
  return guest;
}
test('genuine SDK catalog availability and dispatch use the whole native routing operation', async ({page}) => {
  const guest = await open(page); await guest.locator('#available').click(); await expect(guest.locator('#availability')).toContainText('native-bound-handler');
  await guest.locator('#invoke').click(); await expect(guest.locator('#intent-status')).toHaveText('Dispatch accepted.');
  const calls = await page.evaluate(() => (window as any).routingNative.calls);
  const invoke = calls.find((value: any) => value.type === 'intent.invoke');
  expect(invoke.request.payload).toEqual({text: 'routing tracer + ⚡', nested: [null, false, 3]});
  expect(invoke.request.behavior).toEqual({focus: true, newWindow: false});
  expect(Object.keys(invoke).sort()).toEqual(['id', 'request', 'type']);
});
test('genuine SDK topic subscription receives canonical native-attested events and acknowledges privately', async ({page}) => {
  const guest = await open(page); await guest.locator('#subscribe').click();
  await expect.poll(() => page.evaluate(() => (window as any).routingNative.calls.some((value: any) => value.type === 'inc.subscribe'))).toBe(true);
  await page.evaluate(() => (window as any).routingPush({type: 'inc.event', topic: 'napplet:note/open', sender: 'actual-peer', payload: {literal: '+', nested: [null, false, 7]}}));
  await expect(guest.locator('#topic-events')).toContainText('actual-peer');
  await expect(guest.locator('#topic-events')).toContainText('"nested":[null,false,7]');
  await expect.poll(() => page.evaluate(() => (window as any).routingNative.acks.length)).toBe(1);
  const sequences = await page.evaluate(() => (window as any).routingNative.sequences); expect(sequences).toEqual(sequences.map((_: number, index: number) => index + 1));
});
test('INC emissions stay fire-and-forget in the guest wire despite internal native correlation', async ({page}) => {
  const guest = await open(page); await guest.locator('#emit').click();
  await expect.poll(() => page.evaluate(() => (window as any).routingNative.calls.filter((value: any) => value.type === 'inc.emit').length)).toBe(1);
  const emit = await page.evaluate(() => (window as any).routingNative.calls.find((value: any) => value.type === 'inc.emit'));
  expect(Object.keys(emit).sort()).toEqual(['payload','topic','type']); expect(emit).not.toHaveProperty('id'); expect(emit).not.toHaveProperty('sender');
  await expect(guest.locator('#topic-events')).toBeEmpty();
});
test('a guest cannot forge native pushes and wrong-generation pushes have no SDK recipient', async ({page}) => {
  const guest = await open(page); await guest.locator('#subscribe').click();
  const frame = page.frames().find(value => value.parentFrame() === page.mainFrame())!;
  await frame.evaluate(() => parent.postMessage({type: 'hypergolic.native-response', message: JSON.stringify({type: 'routing.event', sessionId: 'routing-browser', delivery: 1, response: JSON.stringify({type: 'inc.event', topic: 'napplet:note/open', sender: 'forged', payload: 'must not arrive'})})}, '*'));
  await page.evaluate(() => (window as any).routingPush({type: 'inc.event', topic: 'napplet:note/open', sender: 'wrong-generation', payload: 'must not arrive'}, 'other-native-generation'));
  await expect(guest.locator('#topic-events')).toBeEmpty(); expect(await page.evaluate(() => (window as any).routingNative.acks.length)).toBe(0);
  await page.evaluate(() => (window as any).routingPush({type: 'inc.event', topic: 'napplet:note/open', sender: 'real-peer', payload: 'valid'}));
  await expect(guest.locator('#topic-events')).toContainText('real-peer'); await expect(guest.locator('#topic-events')).not.toContainText('forged');
});
test('wrong native correlation rejects dispatch without a fabricated success', async ({page}) => {
  const guest = await open(page); await page.evaluate(() => {(window as any).routingNative.mode = 'wrong-id';}); await guest.locator('#invoke').click();
  await expect(guest.locator('#intent-status')).toHaveText('Request failed: routing unavailable'); await expect(guest.locator('#intent-result')).toBeEmpty();
});
test('invalid push fields and duplicated delivery counters never reach SDK topic handlers', async ({page}) => {
  const guest = await open(page); await guest.locator('#subscribe').click();
  await page.evaluate(() => (window as any).routingPush({type: 'inc.event', topic: 'napplet:note/open', sender: 'peer', recipient: 'forged', payload: 'must not arrive'}));
  await expect(guest.locator('#topic-events')).toBeEmpty();
  await page.evaluate(() => {(window as any).routingNative.delivery = 0; (window as any).routingPush({type: 'inc.event', topic: 'napplet:note/open', sender: 'peer', payload: 'first'});});
  await expect(guest.locator('#topic-events')).toContainText('first');
  await page.evaluate(() => {(window as any).routingNative.delivery = 0; (window as any).routingPush({type: 'inc.event', topic: 'napplet:note/open', sender: 'peer', payload: 'duplicate'});});
  await expect(guest.locator('#topic-events')).not.toContainText('duplicate');
});

test('genuine SDK channel handles preserve symmetric ids, payloads and retained terminal closure', async ({page}) => {
 const guest=await open(page);await guest.locator('#open-channel').click();await expect(guest.locator('#channel-info')).toHaveText('{"id":"native-channel","peer":"signed-routing-peer-lab"}');
 await guest.locator('#channel-emit').click();await expect.poll(()=>page.evaluate(()=>(window as any).routingNative.calls.some((value:any)=>value.type==='inc.channel.emit'))).toBe(true);const sent=await page.evaluate(()=>(window as any).routingNative.calls.find((value:any)=>value.type==='inc.channel.emit'));
 expect(Object.keys(sent).sort()).toEqual(['channelId','payload','type']);expect(sent.channelId).toBe('native-channel');
 await page.evaluate(()=>(window as any).routingPush({type:'inc.channel.event',channelId:'native-channel',sender:'real-peer',payload:{nested:[null,false,3],literal:'+'}}));
 await expect(guest.locator('#channel-events')).toContainText('real-peer');
 await page.evaluate(()=>(window as any).routingPush({type:'inc.channel.closed',channelId:'native-channel',reason:'closed'}));await expect(guest.locator('#channel-status')).toHaveText('Channel closed.');
 await guest.locator('#late-closed').click();await expect(guest.locator('#late-close-result')).toHaveText('{"channelId":"native-channel","reason":"closed"}');
});
test('inbound canonical channel handle exists before subsequent native channel events', async ({page}) => {
 const guest=await open(page);
 await page.evaluate(()=>{const push=(window as any).routingPush;push({type:'inc.channel.opened',channelId:'inbound-channel',peer:'attested-opener'});push({type:'inc.channel.event',channelId:'inbound-channel',sender:'attested-opener',payload:null});});
 await expect(guest.locator('#channel-info')).toHaveText('{"id":"inbound-channel","peer":"attested-opener"}');await expect(guest.locator('#channel-events')).toContainText('"payload":null');
});
