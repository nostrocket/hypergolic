import {test,expect,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
const event=JSON.parse(readFileSync(new URL('../../tests/native/feed-query/events.json',import.meta.url),'utf8'))[0];
// Native-port double: SDK/Kehto/native-client conformance is separate from native WSS evidence.
async function open(page:Page) {
  await page.clock.install();
  await page.addInitScript(()=> {
    if(window!==window.top)return;
    const listeners=new Set<(event:{data:string})=>void>(),deliveries=new Map<number,number>();
    const root=window as any;root.outboxTest={requests:[],revision:0,reply(envelope:any){const data=JSON.stringify(envelope);for(const listener of listeners)listener({data});},push(envelope:any,response:any){
      const delivery=(deliveries.get(envelope.sequence)??0)+1;deliveries.set(envelope.sequence,delivery);
      const data=JSON.stringify({type:'capability.stream',sessionId:envelope.sessionId,sequence:envelope.sequence,delivery,response:JSON.stringify(response)});
      for(const listener of listeners)listener({data});
    },control(envelope:any,active:boolean){const data=JSON.stringify({type:'capability.stream-control',sessionId:envelope.sessionId,sequence:envelope.sequence,active,revision:++root.outboxTest.revision});for(const listener of listeners)listener({data});}};
    root.HypergolicHost={addEventListener:(_:string,listener:any)=>listeners.add(listener),removeEventListener:(_:string,listener:any)=>listeners.delete(listener),postMessage(raw:string){
      const envelope=JSON.parse(raw);root.outboxTest.requests.push(envelope);
      if(envelope.type==='capability'){
        const request=JSON.parse(envelope.message);if(!['outbox.getEvent','outbox.resolveRelays'].includes(request.type))return;
        const response=request.type==='outbox.getEvent'?{type:request.type+'.result',id:request.id,error:'not found',incomplete:true}:{type:request.type+'.result',id:request.id,plan:{relays:['wss://nos.lol'],source:'cache'}};
        const data=JSON.stringify({type:'capability.result',sessionId:envelope.sessionId,sequence:envelope.sequence,response:JSON.stringify(response)});for(const listener of listeners)listener({data});
      }
    }};
  });
  await page.goto('/assets/runtime/index.html?sessionId=outbox-stream-test&fixture=feed-lab&domains=identity,outbox,relay,theme');
  await expect(page.frameLocator('#napplet').getByTestId('lab')).toHaveAttribute('data-ready','true');
  return page.frames().find(frame=>frame.parentFrame()===page.mainFrame())!;
}
async function subscribe(page:Page,options:any={limit:0}) {
  const frame=await open(page);
  await frame.evaluate(options=>{const root=window as any;root.events=[];root.closedResponses=[];root.guestTypes=[];window.addEventListener('message',event=>{if(event.source===parent)root.guestTypes.push(event.data.type);});root.handle=root.napplet.outbox.subscribe({kinds:[1],limit:0},options);root.handle.on('event',(result:any)=>root.events.push(result));root.handle.on('closed',(reason:any)=>root.closedResponses.push(reason));},options);
  await expect.poll(()=>page.evaluate(()=>(window as any).outboxTest.requests.filter((e:any)=>e.type==='relay-stream').length)).toBe(1);
  const envelope=await page.evaluate(()=>(window as any).outboxTest.requests.find((e:any)=>e.type==='relay-stream'));
  return {frame,envelope,subId:JSON.parse(envelope.message).subId};
}
test('original getEvent and resolveRelays use their native overrides and original request correlations',async({page})=> {
  const frame=await open(page);
  expect(await frame.evaluate(async()=>(window as any).napplet.outbox.getEvent('a'.repeat(64),{author:'b'.repeat(64)}))).toMatchObject({error:'not found',incomplete:true});
  expect(await frame.evaluate(async()=>(window as any).napplet.outbox.resolveRelays({pubkey:'b'.repeat(64),direction:'write'}))).toMatchObject({relays:['wss://nos.lol'],source:'cache'});
  const requests=await page.evaluate(()=>(window as any).outboxTest.requests.filter((e:any)=>e.type==='capability').map((e:any)=>JSON.parse(e.message)));
  expect(requests.map((r:any)=>r.type)).toEqual(['outbox.getEvent','outbox.resolveRelays']);expect(requests[0]).toMatchObject({eventId:'a'.repeat(64),options:{author:'b'.repeat(64)}});expect(requests[1]).toMatchObject({target:{pubkey:'b'.repeat(64),direction:'write'}});
});
test('Outbox stream validates signed live events, consumes private EOSE and sends original Outbox close',async({page})=> {
  const h=await subscribe(page);
  const push=async(response:any)=>page.evaluate(({envelope,response})=>(window as any).outboxTest.push(envelope,response),{envelope:h.envelope,response});
  await push({type:'relay.eose',subId:h.subId});await push({type:'outbox.event',subId:h.subId,result:{event,sidecar:{relayHints:['wss://nos.lol']}}});
  await expect.poll(()=>h.frame.evaluate(()=>(window as any).events.length)).toBe(1);
  expect(await h.frame.evaluate(()=>(window as any).events[0])).toEqual({event,sidecar:{relayHints:['wss://nos.lol']}});
  await page.clock.fastForward(60_000);expect(await h.frame.evaluate(()=>(window as any).closedResponses)).toEqual([]);
  expect(await h.frame.evaluate(()=>(window as any).guestTypes.filter((t:string)=>t==='relay.eose'||t==='outbox.eose'))).toEqual([]);
  await h.frame.evaluate(()=>(window as any).handle.close());
  await expect.poll(()=>page.evaluate(()=>(window as any).outboxTest.requests.filter((e:any)=>e.type==='capability'&&JSON.parse(e.message).type==='outbox.close').length)).toBe(1);
});
for(const mode of ['wrong-dialect','bad-signature','private-hint','invented-eose'])test(`Outbox rejects ${mode} and closes only the captured native stream`,async({page})=> {
  const h=await subscribe(page);
  const response=mode==='invented-eose'?{type:'outbox.eose',subId:h.subId}:{type:mode==='wrong-dialect'?'relay.event':'outbox.event',subId:h.subId,result:{event:mode==='bad-signature'?{...event,sig:'0'.repeat(128)}:event,...(mode==='private-hint'?{sidecar:{relayHints:['wss://127.0.0.1']}}:{})}};
  await page.evaluate(({envelope,response})=>(window as any).outboxTest.push(envelope,response),{envelope:h.envelope,response});
  await expect.poll(()=>h.frame.evaluate(()=>(window as any).closedResponses.length)).toBe(1);expect(await h.frame.evaluate(()=>(window as any).events)).toEqual([]);
});
test('native pause freezes initial timeout and canonical Outbox closed settles the original handle',async({page})=> {
  const h=await subscribe(page);
  await page.evaluate(envelope=>(window as any).outboxTest.control(envelope,false),h.envelope);await page.clock.fastForward(60_000);expect(await h.frame.evaluate(()=>(window as any).closedResponses)).toEqual([]);
  await page.evaluate(envelope=>(window as any).outboxTest.control(envelope,true),h.envelope);
  await page.evaluate(({envelope,subId})=>(window as any).outboxTest.push(envelope,{type:'outbox.closed',subId,reason:'relay timeout'}),{envelope:h.envelope,subId:h.subId});
  await expect.poll(()=>h.frame.evaluate(()=>(window as any).closedResponses)).toEqual(['relay timeout']);
});

test('original Outbox SDK publication waits for trusted review beyond ordinary timeout and keeps exact native request/result correlation',async({page})=> {
  const frame=await open(page);
  await frame.evaluate(()=>{const root=window as any;root.publication='pending';root.napplet.outbox.publish({kind:1,content:'reviewed original SDK',tags:[],created_at:1791158400},{toOutbox:false,relays:['wss://nos.lol']}).then((value:any)=>{root.publication=value;},(error:Error)=>{root.publication=error.message;});});
  await expect.poll(()=>page.evaluate(()=>(window as any).outboxTest.requests.filter((e:any)=>e.type==='capability'&&JSON.parse(e.message).type==='outbox.publish').length)).toBe(1);
  await page.clock.fastForward(31_000);expect(await frame.evaluate(()=>(window as any).publication)).toBe('pending');
  const envelope=await page.evaluate(()=>(window as any).outboxTest.requests.find((e:any)=>e.type==='capability'&&JSON.parse(e.message).type==='outbox.publish'));
  const request=JSON.parse(envelope.message);expect(request).toMatchObject({type:'outbox.publish',event:{kind:1,content:'reviewed original SDK'},options:{toOutbox:false,relays:['wss://nos.lol']}});
  await page.evaluate(({envelope,event})=>{const root=window as any;root.outboxTest.reply({type:'capability.result',sessionId:envelope.sessionId,sequence:envelope.sequence,response:JSON.stringify({type:'outbox.publish.result',id:JSON.parse(envelope.message).id,ok:true,event,eventId:event.id,relays:{'wss://nos.lol/':true}})});},{envelope,event});
  await expect.poll(()=>frame.evaluate(()=>(window as any).publication)).toMatchObject({ok:true,eventId:event.id,relays:{'wss://nos.lol/':true}});
  expect(await page.evaluate(()=>(window as any).outboxTest.requests.filter((e:any)=>e.type==='capability'&&JSON.parse(e.message).type==='relay.publish'))).toEqual([]);
});

test('original Outbox SDK publication receives canonical required-inbox failure without inventing event success',async({page})=> {
  const frame=await open(page);
  await frame.evaluate(()=>{const root=window as any;root.publication='pending';root.napplet.outbox.publish({kind:1,content:'required-inbox sample',tags:[],created_at:1791158400},{toInboxes:['a'.repeat(64)]}).then((value:any)=>{root.publication=value;},(error:Error)=>{root.publication=error.message;});});
  await expect.poll(()=>page.evaluate(()=>(window as any).outboxTest.requests.filter((e:any)=>e.type==='capability'&&JSON.parse(e.message).type==='outbox.publish').length)).toBe(1);
  await page.evaluate(()=>{const root=window as any,envelope=root.outboxTest.requests.find((e:any)=>e.type==='capability'&&JSON.parse(e.message).type==='outbox.publish');root.outboxTest.reply({type:'capability.result',sessionId:envelope.sessionId,sequence:envelope.sequence,response:JSON.stringify({type:'outbox.publish.result',id:JSON.parse(envelope.message).id,ok:false,error:'required inbox relay did not accept the event',relays:{'wss://nos.lol/':true}})});});
  await expect.poll(()=>frame.evaluate(()=>(window as any).publication)).toMatchObject({ok:false,error:'required inbox relay did not accept the event'});
});
