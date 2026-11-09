import {test, expect, type Page} from '@playwright/test';
import {build} from 'vite';
let bundle='';
test.beforeAll(async()=>{const result:any=await build({configFile:false,logLevel:'silent',build:{write:false,minify:true,target:'es2022',lib:{entry:'tests/fixtures/legacy-readonly.ts',formats:['iife'],name:'LegacyGuardProof'}}});bundle=(Array.isArray(result)?result[0]:result).output.find((item:any)=>item.type==='chunk').code;});
async function open(page:Page,html:string){
  await page.route('**/__legacy-guard',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><head></head><body></body></html>'}));
  await page.goto('/__legacy-guard');await page.addScriptTag({content:bundle});
  await page.evaluate(html=>(window as any).__legacy.mount(html,false,true),html);
  await expect.poll(()=>page.evaluate(()=>(window as any).__legacy.resumed)).toBe(1);
  return page.locator('#legacy').contentFrame();
}
const empty='<!doctype html><html><head></head><body>Original document</body></html>';
test('private transfer stays hidden from publisher listeners and prototype hooks; synthetic and sibling handshake forgeries fail',async({page})=>{
  const html=`<!doctype html><html><head><script>
  window.stolen=0;window.portsRead=0;window.portMethods=0;
  const ports=Object.getOwnPropertyDescriptor(MessageEvent.prototype,'ports'),data=Object.getOwnPropertyDescriptor(MessageEvent.prototype,'data');
  Object.defineProperty(MessageEvent.prototype,'data',{configurable:true,get(){if(this.target instanceof MessagePort)stolen++;return data.get.call(this)}});
  Object.defineProperty(MessageEvent.prototype,'ports',{configurable:true,get(){portsRead++;return ports.get.call(this)}});
  const post=MessagePort.prototype.postMessage,start=MessagePort.prototype.start,listen=EventTarget.prototype.addEventListener;
  MessagePort.prototype.postMessage=function(...args){portMethods++;return post.apply(this,args)};
  MessagePort.prototype.start=function(...args){portMethods++;return start.apply(this,args)};
  EventTarget.prototype.addEventListener=function(...args){if(this instanceof MessagePort)stolen++;return listen.apply(this,args)};
  window.addEventListener('message',event=>{if(event.type==='message'&&event.ports.length)stolen++},true);
  window.dispatchEvent(new MessageEvent('message',{source:parent,data:{type:'hypergolic.legacy.document.port',session:'12345678-1234-4234-8234-123456789abc',challenge:'forged'}}));
  window.dispatchEvent(new PageTransitionEvent('pagehide'));
  window.addEventListener('pagehide',event=>event.stopImmediatePropagation(),true);
  </script></head><body>Hostile document</body></html>`;
  const frame=await open(page,html);
  expect(await frame.locator('body').evaluate(()=>({stolen:(window as any).stolen,portMethods:(window as any).portMethods}))).toEqual({stolen:0,portMethods:0});
  // A sibling cannot trigger another transfer or acquire the existing private port.
  await page.evaluate(()=>{const frame=document.createElement('iframe');frame.sandbox.add('allow-scripts');frame.srcdoc='<script>parent.postMessage({type:"hypergolic.legacy.document.ready",session:"12345678-1234-4234-8234-123456789abc"},"*")<\/script>';document.body.append(frame);(window as any).__legacy.guard.loaded();});
  await expect.poll(()=>page.evaluate(()=>(window as any).__legacy.resumed)).toBe(2);
  expect(await frame.locator('body').evaluate(()=>(window as any).stolen)).toBe(0);
  await frame.locator('body').evaluate(()=>{location.replace('about:blank');});
  await expect.poll(()=>page.evaluate(()=>(window as any).__legacy.revoked)).toBe(1);
});
test('same-document challenge queues bounded work and fresh proof resumes it; destroyed queues never replay',async({page})=>{
  await open(page,empty);
  await page.evaluate(()=>{const s=(window as any).__legacy;s.guard.loaded();s.guard.run(()=>s.queueRuns++,128);s.immediate=s.queueRuns;});
  expect(await page.evaluate(()=>(window as any).__legacy.immediate)).toBe(0);
  await expect.poll(()=>page.evaluate(()=>(window as any).__legacy.queueRuns)).toBe(1);
  await page.evaluate(()=>{const s=(window as any).__legacy;s.guard.loaded();s.guard.run(()=>s.queueRuns++,128);s.destroy();});
  expect(await page.evaluate(()=>(window as any).__legacy.queueRuns)).toBe(1);
  expect(await page.evaluate(()=>(window as any).__legacy.guard.isActive())).toBe(false);
});
for(const bound of ['count','bytes'] as const)test(`queue ${bound} exhaustion revokes rather than dropping or replaying work`,async({page})=>{
  await open(page,empty);
  await page.evaluate(bound=>{const s=(window as any).__legacy;s.guard.loaded();if(bound==='count')for(let i=0;i<33;i++)s.guard.run(()=>s.queueRuns++,1);else s.guard.run(()=>s.queueRuns++,256*1024+1);},bound);
  expect(await page.evaluate(()=>(window as any).__legacy.revoked)).toBe(1);
  expect(await page.evaluate(()=>(window as any).__legacy.queueRuns)).toBe(0);
});

test('a lost original-document port cannot be replaced by window forgeries and times out without replay',async({page})=>{
  await open(page,empty);
  await page.evaluate(()=>{const s=(window as any).__legacy;s.disconnectDocumentPort();s.guard.loaded();s.guard.run(()=>s.queueRuns++,128);
    const source=document.querySelector('iframe')!.contentWindow;
    s.guard.receive(new MessageEvent('message',{source,data:{type:'pong',challenge:'forged'}}),()=>s.queueRuns++);
    s.guard.receive(new MessageEvent('message',{source,data:{type:'hypergolic.legacy.document.ready',session:s.session}}),()=>s.queueRuns++);
  });
  expect(await page.evaluate(()=>(window as any).__legacy.guard.isActive())).toBe(false);
  await expect.poll(()=>page.evaluate(()=>(window as any).__legacy.revoked)).toBe(1);
  expect(await page.evaluate(()=>(window as any).__legacy.queueRuns)).toBe(0);
});
test('private navigation admits only the local article route and denies a stale document',async({page})=>{
  const frame=await open(page,empty);
  const invalid=await page.evaluate(()=>{const guard=(window as any).__legacy.guard;let rejected=0;for(const target of ['https://reader.example/article','#/compose','#/post/javascript:alert(1)'])try{guard.navigate(target);}catch{rejected++;}return rejected;});
  expect(invalid).toBe(3);
  expect(await frame.locator('body').evaluate(()=>location.hash)).toBe('');
  await page.evaluate(()=>(window as any).__legacy.destroy());
  expect(await page.evaluate(()=>{try{(window as any).__legacy.guard.navigate('#/post/naddr1qqqq');return false;}catch{return true;}})).toBe(true);
  expect(await frame.locator('body').evaluate(()=>location.hash)).toBe('');
});
