import { test, expect, type Page } from '@playwright/test';
import { finalizeEvent } from 'nostr-tools/pure';
import { readFileSync } from 'node:fs';
const event=JSON.parse(readFileSync(new URL('../../tests/native/feed-query/events.json',import.meta.url),'utf8'))[0];
// Native-port double: genuine SDK/Kehto, signed validation and captured recipient only.
async function open(page:Page, initialLimit = 2) {
  await page.clock.install();
  await page.addInitScript(()=> {
    if(window!==window.top)return;
    const listeners=new Set<(event:{data:string})=>void>();
    const deliveries=new Map<string,number>();let controlRevision=0;
    const root=window as any;
    root.streamTest={requests:[],guestClose:null,pushControl(envelope:any,active:boolean){
      const data=JSON.stringify({type:'capability.stream-control',sessionId:envelope.sessionId,sequence:envelope.sequence,active,revision:++controlRevision});
      for(const listener of listeners)listener({data});
    },push(envelope:any,response:any){
      const key=envelope.sessionId+':'+envelope.sequence;const delivery=(deliveries.get(key)??0)+1;deliveries.set(key,delivery);
      const data=JSON.stringify({type:'capability.stream',sessionId:envelope.sessionId,sequence:envelope.sequence,delivery,response:JSON.stringify(response)});
      for(const listener of listeners)listener({data});
    }};
    window.addEventListener('message',event=>{if(event.data?.type==='relay.close')root.streamTest.guestClose=event.data;});
    root.HypergolicHost={addEventListener:(_:string,listener:any)=>listeners.add(listener),removeEventListener:(_:string,listener:any)=>listeners.delete(listener),
      postMessage(raw:string){const envelope=JSON.parse(raw);root.streamTest.requests.push(envelope);
        if(envelope.type==='capability'&&JSON.parse(envelope.message).type==='relay.query')for(const listener of listeners)listener({data:JSON.stringify({type:'capability.result',sessionId:envelope.sessionId,sequence:envelope.sequence,response:JSON.stringify({type:'relay.query.result',id:JSON.parse(envelope.message).id,events:[]})})});
      }};
  });
  await page.goto('/assets/runtime/index.html?sessionId=stream-test&fixture=feed-lab');
  await expect(page.frameLocator('#napplet').getByTestId('lab')).toHaveAttribute('data-ready','true');
  const frame=page.frames().find(frame=>frame.parentFrame()===page.mainFrame())!;
  await frame.evaluate(async limit=>{const root=window as any;await root.napplet.theme.get();root.events=[];root.eose=0;
    root.handle=root.napplet.relay.subscribe({kinds:[1],limit},(result:any)=>root.events.push(result.event.id),()=>root.eose++);}, initialLimit);
  await expect.poll(()=>page.evaluate(()=>(window as any).streamTest.requests.filter((e:any)=>e.type==='relay-stream').length)).toBe(1);
  const envelope=await page.evaluate(()=>(window as any).streamTest.requests.find((e:any)=>e.type==='relay-stream'));
  return {frame,envelope,subId:JSON.parse(envelope.message).subId};
}
test('canonical stream survives EOSE and ordinary lease duration, shares native sequence and honors original close',async({page})=> {
  const h=await open(page);
  await page.evaluate(({envelope,subId,event})=>(window as any).streamTest.push(envelope,{type:'relay.event',subId,result:{event}}),{envelope:h.envelope,subId:h.subId,event});
  await page.evaluate(({envelope,subId})=>(window as any).streamTest.push(envelope,{type:'relay.eose',subId}),{envelope:h.envelope,subId:h.subId});
  await expect.poll(()=>h.frame.evaluate(()=>(window as any).eose)).toBe(1);
  await page.clock.fastForward(28_000);
  await h.frame.evaluate(async()=>await (window as any).napplet.relay.query({kinds:[1],limit:0}));
  await page.evaluate(({envelope,subId,event})=>(window as any).streamTest.push(envelope,{type:'relay.event',subId,result:{event}}),{envelope:h.envelope,subId:h.subId,event});
  await expect.poll(()=>h.frame.evaluate(()=>(window as any).events)).toEqual([event.id,event.id]);
  await h.frame.evaluate(()=>(window as any).handle.close());
  await expect.poll(()=>page.evaluate(()=>(window as any).streamTest.guestClose!==null)).toBe(true);
  const captured=await page.evaluate(()=>(window as any).streamTest.requests.filter((e:any)=>['relay-stream','capability'].includes(e.type)));
  expect(captured.map((e:any)=>e.sequence)).toEqual([1,4,6]);
  expect(JSON.parse(captured[2].message)).toEqual(await page.evaluate(()=>(window as any).streamTest.guestClose));
  await page.evaluate(({envelope,subId,event})=>(window as any).streamTest.push(envelope,{type:'relay.event',subId,result:{event}}),{envelope:h.envelope,subId:h.subId,event});
  await h.frame.evaluate(async()=>await (window as any).napplet.theme.get());
  expect(await h.frame.evaluate(()=>(window as any).events)).toEqual([event.id,event.id]);
});
test('SDK subscriptions requesting more initial history reach the native owner with a capped filter', async ({page}) => {
  const {frame, envelope, subId} = await open(page, 200);
  expect(JSON.parse(envelope.message).filters).toEqual([{kinds: [1], limit: 32}]);
  await page.evaluate(({envelope, subId}) => (window as any).streamTest.push(envelope, {type: 'relay.eose', subId}), {envelope, subId});
  await expect.poll(() => frame.evaluate(() => (window as any).eose)).toBe(1);
});
test('runtime independently verifies and delivers a signed event with long tags', async ({page}) => {
  const {frame,envelope,subId} = await open(page);
  const secret = new Uint8Array(32); secret[31] = 1;
  const event = finalizeEvent({kind:1,created_at:100,content:'generic fixture',
    tags:[['proofmode','p'.repeat(10_959)],['alt','é'.repeat(1539)]]},secret);
  await page.evaluate(({envelope,subId,event}) => (window as any).streamTest.push(envelope, {
    type:'relay.event',subId,result:{event},
  }), {envelope,subId,event});
  await expect.poll(() => frame.evaluate(() => (window as any).events)).toEqual([event.id]);
});

test('trusted peer-live delivery works before aggregate EOSE and keeps private metadata out of the guest', async ({page}) => {
  const {frame, envelope, subId} = await open(page, 0);
  const response = {type: 'relay.event', subId, live: true, result: {event}};
  await frame.evaluate(({envelope, response}) => {
    const root = window as any;
    root.relayMessages = [];
    window.addEventListener('message', event => {
      if (event.source === parent && event.data?.type === 'relay.event') root.relayMessages.push(event.data);
    });
    parent.postMessage({type: 'hypergolic.native-response', message: JSON.stringify({
      type: 'capability.stream', sessionId: envelope.sessionId, sequence: envelope.sequence, delivery: 1,
      response: JSON.stringify(response),
    })}, '*');
  }, {envelope, response});
  await frame.evaluate(async () => await (window as any).napplet.theme.get());
  expect(await frame.evaluate(() => (window as any).events)).toEqual([]);
  await page.evaluate(({envelope, response}) => (window as any).streamTest.push(envelope, response), {envelope, response});
  await expect.poll(() => frame.evaluate(() => (window as any).events)).toEqual([event.id]);
  expect(await frame.evaluate(() => (window as any).relayMessages)).toEqual([{type: 'relay.event', subId, result: {event}}]);
  expect(await frame.evaluate(() => (window as any).eose)).toBe(0);
});

test('aggregate EOSE cannot authorize a zero-only event without its peer-live marker', async ({page}) => {
  const {frame, envelope, subId} = await open(page, 0);
  await page.evaluate(({envelope, subId}) => (window as any).streamTest.push(envelope, {type: 'relay.eose', subId}), {envelope, subId});
  await expect.poll(() => frame.evaluate(() => (window as any).eose)).toBe(1);
  await page.evaluate(({envelope, subId, event}) => (window as any).streamTest.push(envelope, {
    type: 'relay.event', subId, result: {event},
  }), {envelope, subId, event});
  await expect.poll(() => page.evaluate(() => (window as any).streamTest.requests.some((item: any) =>
    item.type === 'capability' && JSON.parse(item.message).type === 'relay.close'))).toBe(true);
  expect(await frame.evaluate(() => (window as any).events)).toEqual([]);
});

async function observeQuotaDenials(frame: Awaited<ReturnType<typeof open>>['frame']) {
  await frame.evaluate(() => {
    const root = window as any;
    root.quotaDenials = 0;
    window.addEventListener('message', event => {
      if (event.source === parent && event.data?.type === 'relay.closed') root.quotaDenials++;
    });
  });
}
function admittedTypes(page: Page) {
  return page.evaluate(() => (window as any).streamTest.requests
    .filter((entry: any) => entry.type === 'relay-stream')
    .map((entry: any) => JSON.parse(entry.message).type));
}

test('three raw SDK streams reach native, the fourth closes, and an explicit close restores capacity', async ({page}) => {
  const {frame} = await open(page);
  await observeQuotaDenials(frame);
  await frame.evaluate(() => {
    const root = window as any;
    for (let index = 0; index < 3; index++) root.napplet.relay.subscribe({kinds: [1], limit: 2}, () => {}, () => {});
  });
  await expect.poll(() => admittedTypes(page)).toEqual(['relay.subscribe', 'relay.subscribe', 'relay.subscribe']);
  await expect.poll(() => frame.evaluate(() => (window as any).quotaDenials)).toBe(1);
  await frame.evaluate(() => {
    const root = window as any;
    root.handle.close();
    root.napplet.relay.subscribe({kinds: [1], limit: 2}, () => {}, () => {});
  });
  await expect.poll(async () => (await admittedTypes(page)).length).toBe(4);
});

for (const outboxFirst of [false, true]) {
  test(`mixed SDK streams stay at two when ${outboxFirst ? 'Outbox' : 'raw Relay'} arrives first`, async ({page}) => {
    const {frame} = await open(page);
    await observeQuotaDenials(frame);
    await frame.evaluate(outboxFirst => {
      const root = window as any;
      if (outboxFirst) root.handle.close();
      root.napplet.outbox.subscribe({kinds: [1], limit: 2}, {limit: 2});
      if (outboxFirst) root.napplet.relay.subscribe({kinds: [1], limit: 2}, () => {}, () => {});
      root.napplet.relay.subscribe({kinds: [1], limit: 2}, () => {}, () => {});
    }, outboxFirst);
    await expect.poll(() => frame.evaluate(() => (window as any).quotaDenials)).toBe(1);
    const expected = outboxFirst ? ['outbox.subscribe', 'relay.subscribe'] : ['relay.subscribe', 'outbox.subscribe'];
    expect((await admittedTypes(page)).slice(outboxFirst ? 1 : 0)).toEqual(expected);
  });
}
test('guest native-channel forgery and wrong generation cannot redirect signed stream replies',async({page})=> {
  const h=await open(page);
  const response={type:'relay.event',subId:h.subId,result:{event}};
  await h.frame.evaluate(({envelope,response})=>parent.postMessage({type:'hypergolic.native-response',message:JSON.stringify({type:'capability.stream',sessionId:envelope.sessionId,sequence:envelope.sequence,response:JSON.stringify(response)})},'*'),{envelope:h.envelope,response});
  await page.evaluate(({envelope,response})=>(window as any).streamTest.push({...envelope,sessionId:'foreign'},response),{envelope:h.envelope,response});
  await h.frame.evaluate(async()=>await (window as any).napplet.theme.get());expect(await h.frame.evaluate(()=>(window as any).events)).toEqual([]);
  await page.evaluate(({envelope,response})=>(window as any).streamTest.push(envelope,response),{envelope:h.envelope,response});
  await expect.poll(()=>h.frame.evaluate(()=>(window as any).events)).toEqual([event.id]);
});
for(const mode of ['signature','subId'])test(`invalid ${mode} is terminal without unverified SDK events`,async({page})=> {
  const h=await open(page);
  await page.evaluate(({envelope,subId,event,mode})=>(window as any).streamTest.push(envelope,{type:'relay.event',subId:mode==='subId'?'foreign':subId,result:{event:mode==='signature'?{...event,sig:'0'.repeat(128)}:event}}),{envelope:h.envelope,subId:h.subId,event,mode});
  await expect.poll(()=>page.evaluate(()=>(window as any).streamTest.requests.filter((e:any)=>e.type==='capability'&&JSON.parse(e.message).type==='relay.close').length)).toBe(1);
  await page.evaluate(({envelope,subId,event})=>(window as any).streamTest.push(envelope,{type:'relay.event',subId,result:{event}}),{envelope:h.envelope,subId:h.subId,event});
  await h.frame.evaluate(async()=>await (window as any).napplet.theme.get());expect(await h.frame.evaluate(()=>(window as any).events)).toEqual([]);
});

test('native suspension preserves initial subscription timeout and foreground resumes its deadline',async({page})=> {
  const h=await open(page);
  await h.frame.evaluate(()=>{(window as any).closedCount=0;window.addEventListener('message',event=>{if(event.source===parent&&event.data?.type==='relay.closed')(window as any).closedCount++;});});
  await page.evaluate(({envelope})=>(window as any).streamTest.pushControl(envelope,false),{envelope:h.envelope});
  await page.clock.fastForward(60_000);
  expect(await page.evaluate(()=>(window as any).streamTest.requests.filter((e:any)=>e.type==='capability').length)).toBe(0);
  await page.evaluate(({envelope})=>(window as any).streamTest.pushControl(envelope,true),{envelope:h.envelope});
  await page.clock.fastForward(27_000);
  await expect.poll(()=>h.frame.evaluate(()=>(window as any).closedCount)).toBe(1);
  expect(await page.evaluate(()=>(window as any).streamTest.requests.filter((e:any)=>e.type==='capability'&&JSON.parse(e.message).type==='relay.close').length)).toBe(1);
});
test('unsupported encrypted SDK subscription is explicitly closed before native admission',async({page})=> {
  const h=await open(page);
  await h.frame.evaluate(()=>{(window as any).closedCount=0;window.addEventListener('message',event=>{if(event.source===parent&&event.data?.type==='relay.closed')(window as any).closedCount++;});(window as any).napplet.relay.subscribe({kinds:[4]},()=>{},()=>{});});
  await expect.poll(()=>h.frame.evaluate(()=>(window as any).closedCount)).toBe(1);
  expect(await page.evaluate(()=>(window as any).streamTest.requests.filter((e:any)=>e.type==='relay-stream').length)).toBe(1);
});

function scopedStarts(page: Page) {
  return page.evaluate(() => (window as any).streamTest.requests
    .filter((envelope: any) => envelope.type === 'relay-stream' && JSON.parse(envelope.message).relay));
}
function finishScoped(page: Page, envelope: {message: string}, sessionId?: string) {
  return page.evaluate(({envelope, sessionId}) => {
    const target = sessionId === undefined ? envelope : {...envelope, sessionId};
    (window as any).streamTest.push(target, {type:'relay.closed', subId:JSON.parse(envelope.message).subId});
  }, {envelope, sessionId});
}
async function scopedBurst(page: Page, count: number) {
  const {frame} = await open(page);
  await observeQuotaDenials(frame);
  await frame.evaluate(count => {
    const root = window as any;
    root.handle.close();
    root.scopedHandles = Array.from({length:count}, (_, index) => root.napplet.relay.subscribe(
      {kinds:[1], limit:2}, () => {}, () => {}, {relay:`wss://peer-${index}.nostr.net`},
    ));
  }, count);
  await expect.poll(async () => (await scopedStarts(page)).length).toBe(3);
  return frame;
}

test('scoped burst reserves at most three starts and drains only after the exact terminal ACK', async ({page}) => {
  const frame = await scopedBurst(page,7);
  await expect.poll(() => frame.evaluate(() => (window as any).quotaDenials)).toBe(1);
  const [first] = await scopedStarts(page);
  await frame.evaluate(envelope => parent.postMessage({type:'hypergolic.native-response',message:JSON.stringify({
    type:'capability.stream', sessionId:envelope.sessionId, sequence:envelope.sequence, delivery:1,
    response:JSON.stringify({type:'relay.closed',subId:JSON.parse(envelope.message).subId}),
  })}, '*'), first);
  await finishScoped(page,first,'foreign-generation');
  await frame.evaluate(() => (window as any).napplet.theme.get());
  expect(await scopedStarts(page)).toHaveLength(3);

  await finishScoped(page,first);
  await expect.poll(async () => (await scopedStarts(page)).length).toBe(4);
  const tail = await page.evaluate(() => (window as any).streamTest.requests.slice(-2));
  expect(tail[0]).toMatchObject({type:'relay-stream-ack',streamSequence:first.sequence,delivery:1});
  expect(tail[1].type).toBe('relay-stream');
  expect(JSON.parse(tail[1].message).relay).toBe('wss://peer-3.nostr.net');
  expect(tail[1].sequence).toBeGreaterThan(tail[0].sequence);
  await finishScoped(page,first);
  expect(await scopedStarts(page)).toHaveLength(4);
});

test('queued publisher close, active close, and expired starts cannot dispatch stale intents', async ({page}) => {
  const frame = await scopedBurst(page,6);
  const [first,second,third] = await scopedStarts(page);
  await frame.evaluate(() => {
    (window as any).scopedHandles[3].close();
    (window as any).scopedHandles[0].close();
  });
  await expect.poll(() => page.evaluate(() => (window as any).streamTest.requests
    .filter((request: any) => request.type === 'capability' && JSON.parse(request.message).type === 'relay.close').length)).toBe(2);
  await finishScoped(page,first);
  expect(await scopedStarts(page)).toHaveLength(3);
  await page.clock.fastForward(3000);
  await finishScoped(page,second);
  await expect.poll(async () => (await scopedStarts(page)).length).toBe(4);
  expect(JSON.parse((await scopedStarts(page)).at(-1).message).relay).toBe('wss://peer-4.nostr.net');
  await page.clock.fastForward(1001);
  await expect.poll(() => frame.evaluate(() => (window as any).quotaDenials)).toBe(2);
  await finishScoped(page,third);
  expect(await scopedStarts(page)).toHaveLength(4);
});

test('destroyed renderer discards pending starts before any late native terminal', async ({page}) => {
  await scopedBurst(page,6);
  const [first] = await scopedStarts(page);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await expect(page.locator('#napplet')).toHaveCount(0);
  await finishScoped(page,first);
  await page.clock.fastForward(4500);
  expect(await scopedStarts(page)).toHaveLength(3);
});
