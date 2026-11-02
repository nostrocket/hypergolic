import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const event=JSON.parse(readFileSync(new URL('../../tests/native/feed-query/events.json',import.meta.url),'utf8'))[0];
// Native-port double: genuine SDK/Kehto, signed validation and captured recipient only.
async function open(page:Page) {
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
  await frame.evaluate(async()=>{const root=window as any;await root.napplet.theme.get();root.events=[];root.eose=0;
    root.handle=root.napplet.relay.subscribe({kinds:[1],limit:2},(result:any)=>root.events.push(result.event.id),()=>root.eose++);});
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
