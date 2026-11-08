import {test, expect, type Page} from '@playwright/test';
import {build} from 'vite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {finalizeEvent} from 'nostr-tools/pure';
import {naddrEncode} from 'nostr-tools/nip19';
import {prepareLegacyFixtures} from '../tools/prepare-legacy-fixtures.mjs';
const generation = '12345678-1234-4234-8234-123456789abc';
const publisher = 'c2f1ab4e6a577dd8980b57e15986ed92830b95a94f374192235563532b5cac20';
const pins = {
  'recipe-cards': {eventId:'b70911af4382baded327ce6af4b595197ff7a4781e3704b9f066a74f68b48a07',htmlHash:'9067048a9ce80d7e79ea76b960acc88aa53645754ec4e7549de1c1525a690194',version:'92d5639e1da2a0b9ac6bbb9d41d67b0026c15ed614e2d553f8ad2e4e4e896ecc'},
  longform: {eventId:'5fff2ec459ffb1a2d2966fc9815bc8ba45db96a669dfe4924d6c63e65b08a24e',htmlHash:'d5558df7e1f3823c0ad5c64273d57802fe304c1e2266bab8e5151fbf05ad51f4',version:'3ba5049444dd249abbe671f818d555b4e3c90b7cab88a70187bc3a012f9afd67'},
};
const key=new Uint8Array(32);key[31]=11;
const article=finalizeEvent({kind:30023,created_at:1700000000,content:'Real main runtime public content.',tags:[['d','main-read'],['title','Main runtime article'],['t','recipe'],['ingredient','1','cup','Rice'],['step','1','Cook rice']]},key);
let host = '', document = '';
test.beforeAll(async () => {
  await prepareLegacyFixtures();
  const result:any=await build({configFile:false,logLevel:'silent',define:{__BUNDLED_FIXTURES__:'{}',__UX_HTML__:'""',__UX_SHA256__:'""',__UX_AGGREGATE__:'""'},build:{write:false,minify:true,target:'es2022',modulePreload:false,lib:{entry:'src/main.ts',formats:['iife'],name:'HypergolicRuntime'}}});
  host=(Array.isArray(result)?result[0]:result).output.find((item:any)=>item.type==='chunk').code;
  const builder=readFileSync('tools/build.mjs','utf8');
  document=/const document = `([\s\S]+?)`;/.exec(builder)![1]!;
});
type Mode='legacy'|'ordinary'|'bad-consent'|'wrong-pin'|'changed-context'|'synthetic-domain';
async function open(page:Page,appId:keyof typeof pins,mode:Mode='legacy') {
  const bytes=readFileSync(`.test-fixtures/legacy/${appId}.html`);const pin=pins[appId];
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(pin.htmlHash);
  await page.route('**/assets/runtime/index.html?*',route=>route.fulfill({contentType:'text/html',body:document}));
  await page.route('**/assets/runtime/host.js',route=>route.fulfill({contentType:'text/javascript',body:host}));
  await page.addInitScript(({generation,html,appId,pin,publisher,mode,event})=>{
    if(window!==window.top)return;
    const bytes=Uint8Array.from(atob(html),c=>c.charCodeAt(0)),listeners=new Set<(event:{data:string})=>void>();
    const state:any={wire:[],diagnostics:[],chunks:[],reply:(envelope:unknown)=>{for(const listener of listeners)listener({data:JSON.stringify(envelope)});}};
    (window as any).__legacyMain=state;
    Object.defineProperty(window,'HypergolicHost',{value:{addEventListener:(_:string,listener:(event:{data:string})=>void)=>listeners.add(listener),removeEventListener:(_:string,listener:(event:{data:string})=>void)=>listeners.delete(listener),postMessage:(raw:string)=>{
      const message=JSON.parse(raw);state.wire.push(message);
      if(message.type==='ready'||message.type==='error'){state.diagnostics.push(message);return;}
      if(message.type==='artifact.read'){
        state.chunks.push(message.sequence);const offset=message.sequence*48*1024,chunk=bytes.slice(offset,offset+48*1024);
        const context={profile:'legacy-read-only-v1',consent:mode!=='bad-consent',eventId:pin.eventId,htmlHash:pin.htmlHash,relays:['wss://relay.damus.io','wss://nos.lol','wss://relay.nostr.band','wss://relay.primal.net']};
        if(mode==='changed-context'&&message.sequence>0)context.relays=['wss://relay.damus.io'];
        state.reply({type:'artifact.chunk',sessionId:generation,sequence:message.sequence,base64:btoa(String.fromCharCode(...chunk)),byteLength:chunk.length,totalBytes:bytes.length,publisher,appId,eventId:mode==='wrong-pin'?'f'.repeat(64):pin.eventId,version:pin.version,htmlHash:pin.htmlHash,domains:mode==='synthetic-domain'?['relay']:[],done:offset+chunk.length===bytes.length,...(mode==='ordinary'?{}:{legacyReadOnly:context})});return;
      }
      if(message.type==='relay-stream'){
        const request=JSON.parse(message.message);if(request.type!=='legacy.subscribe')return;
        queueMicrotask(()=>{
          let delivery=0;
          const matches=request.filters.some((f:any)=>(!f.kinds||f.kinds.includes(event.kind))&&(!f.ids||f.ids.includes(event.id))&&(!f.authors||f.authors.includes(event.pubkey))&&(!f['#d']||f['#d'].includes('main-read')));
          if(matches)state.reply({type:'capability.stream',sessionId:generation,sequence:message.sequence,delivery:++delivery,response:JSON.stringify({type:'relay.event',subId:request.subId,result:{event}})});
          state.reply({type:'capability.stream',sessionId:generation,sequence:message.sequence,delivery:++delivery,response:JSON.stringify({type:'relay.eose',subId:request.subId})});
        });
      }
    }}});
  },{generation,html:bytes.toString('base64'),appId,pin,publisher,mode,event:article});
  await page.goto(`/assets/runtime/index.html?sessionId=${generation}&source=published`);
  return page.locator('#napplet').contentFrame();
}
for(const appId of ['recipe-cards','longform'] as const)test(`actual main reads unchanged ${appId} through native artifact chunks and dedicated read wire`,async({page})=>{
  const frame=await open(page,appId);
  await expect.poll(()=>page.evaluate(()=>(window as any).__legacyMain.diagnostics.some((m:any)=>m.type==='ready'))).toBe(true);
  if(appId==='longform')await frame.locator('body').evaluate((_,address)=>{location.hash='#/post/'+address;},naddrEncode({kind:30023,pubkey:article.pubkey,identifier:'main-read'}));
  await expect(frame.getByText('Main runtime article',{exact:true}).first()).toBeVisible({timeout:10000});
  await expect(page.locator('body > [role=status]')).toContainText('Read-only compatibility');
  expect(await frame.locator('body').evaluate(()=>({nostr:typeof(window as any).nostr,napplet:typeof(window as any).napplet}))).toEqual({nostr:'undefined',napplet:'undefined'});
  const state=await page.evaluate(()=>({wire:(window as any).__legacyMain.wire,chunks:(window as any).__legacyMain.chunks}));
  expect(state.chunks.length).toBeGreaterThan(1);expect(state.wire.filter((m:any)=>m.type==='relay-stream').length).toBeGreaterThan(0);
  expect(state.wire.filter((m:any)=>m.type==='relay-stream').every((m:any)=>JSON.parse(m.message).type==='legacy.subscribe')).toBe(true);
  expect(state.wire.filter((m:any)=>m.type==='capability').every((m:any)=>JSON.parse(m.message).type==='legacy.close')).toBe(true);
});
test('actual main ordinary pin receives no legacy adapter, import projection or native legacy dispatch',async({page})=>{
  const frame=await open(page,'recipe-cards','ordinary');
  await expect(frame.locator('body')).toBeVisible();
  expect(await frame.locator('body').evaluate(()=>({nostr:typeof(window as any).nostr,socket:WebSocket.name,importmap:document.querySelectorAll('script[type=importmap]').length}))).toEqual({nostr:'undefined',socket:'WebSocket',importmap:0});
  expect(await page.evaluate(()=>(window as any).__legacyMain.wire.some((m:any)=>m.type==='relay-stream'&&JSON.parse(m.message).type==='legacy.subscribe'))).toBe(false);
  await expect(page.locator('body > [role=status]')).toHaveCount(0);
});
for(const mode of ['bad-consent','wrong-pin','changed-context','synthetic-domain'] as const)test(`actual main denies invalid native legacy metadata: ${mode}`,async({page})=>{
  await open(page,'longform',mode);
  await expect(page.getByRole('alert')).toHaveText('The napplet could not be loaded.');
  expect(await page.evaluate(()=>(window as any).__legacyMain.diagnostics)).toContainEqual({type:'error',sessionId:generation,code:'artifact-integrity'});
  expect(await page.evaluate(()=>(window as any).__legacyMain.wire.some((m:any)=>m.type==='relay-stream'))).toBe(false);
});

test('actual main revokes genuine replacement documents and rejects stale native deliveries',async({page})=>{
  await open(page,'recipe-cards');
  await expect.poll(()=>page.evaluate(()=>(window as any).__legacyMain.wire.some((m:any)=>m.type==='relay-stream'))).toBe(true);
  await page.evaluate(()=>{document.querySelector<HTMLIFrameElement>('#napplet')!.srcdoc='<!doctype html><html><body>Replacement document</body></html>';});
  await expect(page.getByRole('alert')).toHaveText('The napplet could not be loaded.');
  expect(await page.evaluate(()=>(window as any).__legacyMain.diagnostics)).toContainEqual({type:'error',sessionId:generation,code:'frame-navigation'});
  await page.evaluate(({event,generation})=>{const state=(window as any).__legacyMain;const stream=state.wire.find((m:any)=>m.type==='relay-stream');const request=JSON.parse(stream.message);state.reply({type:'capability.stream',sessionId:generation,sequence:stream.sequence,delivery:3,response:JSON.stringify({type:'relay.event',subId:request.subId,result:{event}})});},{event:article,generation});
  await expect(page.locator('#napplet')).toHaveCount(0);
  await expect(page.getByText('Main runtime article',{exact:true})).toHaveCount(0);
});
