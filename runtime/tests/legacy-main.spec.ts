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
const article=finalizeEvent({kind:30023,created_at:1700000000,content:'Real main runtime public content.',tags:[['d','main-read'],['title','Main runtime article'],['t','recipe'],['image','https://assets.example.com/recipe.png'],['ingredient','1','cup','Rice'],['step','1','Cook rice']]},key);
const addressIdentifier='https://recipes.example/item#recipe';
const addressArticle=finalizeEvent({kind:30023,created_at:1700000000,content:'Neutral public recipe text.',tags:[['d',addressIdentifier],['title','Selected public recipe'],['t','recipe']]},key);
let host = '', document = '';
test.beforeAll(async () => {
  await prepareLegacyFixtures();
  const result:any=await build({configFile:false,logLevel:'silent',define:{__BUNDLED_FIXTURES__:'{}',__UX_HTML__:'""',__UX_SHA256__:'""',__UX_AGGREGATE__:'""'},build:{write:false,minify:true,target:'es2022',modulePreload:false,lib:{entry:'src/main.ts',formats:['iife'],name:'HypergolicRuntime'}}});
  host=(Array.isArray(result)?result[0]:result).output.find((item:any)=>item.type==='chunk').code;
  const builder=readFileSync('tools/build.mjs','utf8');
  document=/const document = `([\s\S]+?)`;/.exec(builder)![1]!;
});
type Mode='legacy'|'ordinary'|'bad-consent'|'wrong-pin'|'changed-context'|'synthetic-domain'|'restricted-relays'|'address-entry'|'image-hold';
async function open(page:Page,appId:keyof typeof pins,mode:Mode='legacy',event=article) {
  const bytes=readFileSync(`.test-fixtures/legacy/${appId}.html`);const pin=pins[appId];
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(pin.htmlHash);
  await page.route('**/assets/runtime/index.html?*',route=>route.fulfill({contentType:'text/html',body:document}));
  await page.route('**/assets/runtime/host.js',route=>route.fulfill({contentType:'text/javascript',body:host}));
  await page.addInitScript(({generation,html,appId,pin,publisher,mode,event})=>{
    if(window!==window.top)return;
    const bytes=Uint8Array.from(atob(html),c=>c.charCodeAt(0)),listeners=new Set<(event:{data:string})=>void>();
    const transfers=new Map<string,string>();let transferSequence=0;
    const state:any={wire:[],diagnostics:[],chunks:[],imageReplies:[],reply:(envelope:unknown)=>{for(const listener of listeners)listener({data:JSON.stringify(envelope)});}};
    (window as any).__legacyMain=state;
    Object.defineProperty(window,'HypergolicHost',{value:{addEventListener:(_:string,listener:(event:{data:string})=>void)=>listeners.add(listener),removeEventListener:(_:string,listener:(event:{data:string})=>void)=>listeners.delete(listener),postMessage:(raw:string)=>{
      const message=JSON.parse(raw);state.wire.push(message);
      if(message.type==='ready'||message.type==='error'){state.diagnostics.push(message);return;}
      if(message.type==='artifact.read'){
        state.chunks.push(message.sequence);const offset=message.sequence*48*1024,chunk=bytes.slice(offset,offset+48*1024);
        const context={profile:'legacy-read-only-v1',consent:mode!=='bad-consent',eventId:pin.eventId,htmlHash:pin.htmlHash,relays:['wss://relay.damus.io','wss://nos.lol','wss://relay.nostr.band','wss://relay.primal.net']};
        if(mode==='restricted-relays')context.relays=['wss://nos.lol'];
        if(mode==='changed-context'&&message.sequence>0)context.relays=['wss://relay.damus.io'];
        state.reply({type:'artifact.chunk',sessionId:generation,sequence:message.sequence,base64:btoa(String.fromCharCode(...chunk)),byteLength:chunk.length,totalBytes:bytes.length,publisher,appId,eventId:mode==='wrong-pin'?'f'.repeat(64):pin.eventId,version:pin.version,htmlHash:pin.htmlHash,domains:mode==='synthetic-domain'?['relay']:[],done:offset+chunk.length===bytes.length,...(mode==='ordinary'?{}:{legacyReadOnly:context})});return;
      }
      if(message.type==='capability'){
        const request=JSON.parse(message.message);
        if(request.type==='legacy.image.bytes'){
          const handle='00000000-0000-4000-8000-'+String(++transferSequence).padStart(12,'0');
          const base64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4ZkAAAAASUVORK5CYII=';
          transfers.set(handle,base64);
          const reply=()=>state.reply({type:'capability.result',sessionId:generation,sequence:message.sequence,response:JSON.stringify({type:request.type+'.result',id:request.id,transfer:{handle,mime:'image/png',length:atob(base64).length}})});
          if(mode==='image-hold')state.imageReplies.push(reply);else queueMicrotask(reply);
        }else if(request.type==='legacy.image.__chunk'){
          const base64=transfers.get(request.handle);transfers.delete(request.handle);
          queueMicrotask(()=>state.reply({type:'capability.result',sessionId:generation,sequence:message.sequence,response:JSON.stringify({type:request.type+'.result',id:request.id,base64})}));
        }else if(request.type==='legacy.image.cancel')state.reply({type:'capability.result',sessionId:generation,sequence:message.sequence,response:null});
      }
      if(message.type==='relay-stream'){
        const request=JSON.parse(message.message);if(request.type!=='legacy.subscribe')return;
        queueMicrotask(()=>{
          let delivery=0;
          const identifier=event.tags.find((tag:string[])=>tag[0]==='d')?.[1];
          const matches=request.filters.some((f:any)=>(mode!=='address-entry'||f.authors?.includes(event.pubkey)&&f['#d']?.includes(identifier))&&(!f.kinds||f.kinds.includes(event.kind))&&(!f.ids||f.ids.includes(event.id))&&(!f.authors||f.authors.includes(event.pubkey))&&(!f['#d']||f['#d'].includes(identifier)));
          if(matches)state.reply({type:'capability.stream',sessionId:generation,sequence:message.sequence,delivery:++delivery,response:JSON.stringify({type:'relay.event',subId:request.subId,result:{event}})});
          state.reply({type:'capability.stream',sessionId:generation,sequence:message.sequence,delivery:++delivery,response:JSON.stringify({type:'relay.eose',subId:request.subId})});
        });
      }
    }}});
  },{generation,html:bytes.toString('base64'),appId,pin,publisher,mode,event});
  await page.goto(`/assets/runtime/index.html?sessionId=${generation}&source=published`);
  return page.locator('#napplet').contentFrame();
}
for(const appId of ['recipe-cards','longform'] as const)test(`actual main reads unchanged ${appId} through native artifact chunks and dedicated read wire`,async({page})=>{
  const remotes:string[]=[];page.on('request',request=>{if(request.url().startsWith('https://assets.example.com/'))remotes.push(request.url());});
  const frame=await open(page,appId);
  await expect.poll(()=>page.evaluate(()=>(window as any).__legacyMain.diagnostics.some((m:any)=>m.type==='ready'))).toBe(true);
  if(appId==='longform'){await page.locator('#legacy-article-toggle').click();await page.getByLabel('Open by address',{exact:true}).fill(naddrEncode({kind:30023,pubkey:article.pubkey,identifier:'main-read'}));await page.getByRole('button',{name:'Open',exact:true}).click();}
  await expect(frame.getByText('Main runtime article',{exact:true}).first()).toBeVisible({timeout:10000});
  await expect(frame.locator('img').first()).toHaveJSProperty('naturalWidth',1);
  expect(await frame.locator('img').first().getAttribute('src')).toMatch(/^blob:/);expect(remotes).toEqual([]);
  await expect(page.locator('body > [role=status]')).toContainText('Read-only compatibility');
  expect(await frame.locator('body').evaluate(()=>({nostr:typeof(window as any).nostr,napplet:typeof(window as any).napplet}))).toEqual({nostr:'undefined',napplet:'undefined'});
  const state=await page.evaluate(()=>({wire:(window as any).__legacyMain.wire,chunks:(window as any).__legacyMain.chunks}));
  expect(state.chunks.length).toBeGreaterThan(1);expect(state.wire.filter((m:any)=>m.type==='relay-stream').length).toBeGreaterThan(0);
  expect(state.wire.filter((m:any)=>m.type==='relay-stream').every((m:any)=>JSON.parse(m.message).type==='legacy.subscribe')).toBe(true);
  expect(state.wire.filter((m:any)=>m.type==='capability').every((m:any)=>['legacy.close','legacy.image.bytes','legacy.image.__chunk','legacy.image.cancel'].includes(JSON.parse(m.message).type))).toBe(true);
});
test('actual main ordinary pin receives no legacy adapter, import projection or native legacy dispatch',async({page})=>{
  const frame=await open(page,'recipe-cards','ordinary');
  await expect(frame.locator('body')).toBeVisible();
  expect(await frame.locator('body').evaluate(()=>({nostr:typeof(window as any).nostr,socket:WebSocket.name,importmap:document.querySelectorAll('script[type=importmap]').length}))).toEqual({nostr:'undefined',socket:'WebSocket',importmap:0});
  expect(await page.evaluate(()=>(window as any).__legacyMain.wire.some((m:any)=>m.type==='relay-stream'&&JSON.parse(m.message).type==='legacy.subscribe'))).toBe(false);
  await expect(page.locator('body > [role=status]')).toHaveCount(0);
});
test('actual main carries attested relay selection into early denial while configured Recipe reads continue',async({page})=>{
  const frame=await open(page,'recipe-cards','restricted-relays');
  await expect(frame.getByText('Main runtime article',{exact:true}).first()).toBeVisible();
  await expect(page.locator('body > [role=status]')).toContainText('not in Hypergolic’s Network relays');
  const relays=await page.evaluate(()=>(window as any).__legacyMain.wire.filter((message:any)=>message.type==='relay-stream').map((message:any)=>JSON.parse(message.message).relay));
  expect(relays.length).toBeGreaterThan(0);expect(relays.every((relay:string)=>relay==='wss://nos.lol')).toBe(true);
});
for(const appId of ['recipe-cards','longform'] as const)test(`trusted address control opens selected signed content in unchanged ${appId}`,async({page})=>{
  await page.setViewportSize({width:360,height:800});
  const frame=await open(page,appId,'address-entry',addressArticle);
  await expect.poll(()=>page.evaluate(()=>(window as any).__legacyMain.diagnostics.some((message:any)=>message.type==='ready'))).toBe(true);
  await expect(frame.getByText('Selected public recipe',{exact:true})).toHaveCount(0);
  const label=appId==='recipe-cards'?'Open recipe by address':'Open by address';
  expect(await page.locator('details').getAttribute('open')).toBeNull();
  const initialHeight=await page.locator('#napplet').evaluate(frame=>frame.getBoundingClientRect().height);
  await page.locator('#legacy-article-toggle').click();
  expect(await page.locator('#napplet').evaluate(frame=>frame.getBoundingClientRect().height)).toBeLessThan(initialHeight);
  expect(await page.getByLabel(label,{exact:true}).getAttribute('autocapitalize')).toBe('none');
  expect(await page.getByLabel(label,{exact:true}).getAttribute('spellcheck')).toBe('false');
  expect(await page.locator('#legacy-article-open').evaluate(button=>button.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  expect(await page.locator('form').evaluate(form=>form.scrollWidth<=form.clientWidth)).toBe(true);
  const address=naddrEncode({kind:30023,pubkey:addressArticle.pubkey,identifier:addressIdentifier,relays:['wss://unconfigured.example']});
  await page.getByLabel(label,{exact:true}).fill('nostr:'+address);await page.getByRole('button',{name:'Open',exact:true}).click();
  await expect(frame.getByText('Selected public recipe',{exact:true}).first()).toBeVisible({timeout:10000});
  if(appId==='recipe-cards')await frame.getByRole('button',{name:'Recipe: Selected public recipe',exact:true}).click();
  await expect(frame.getByText('Neutral public recipe text.',{exact:true}).first()).toBeVisible();
  expect(await page.getByLabel(label,{exact:true}).inputValue()).toBe(naddrEncode({kind:30023,pubkey:addressArticle.pubkey,identifier:addressIdentifier}));
  const requests=await page.evaluate(()=>(window as any).__legacyMain.wire.filter((message:any)=>message.type==='relay-stream').map((message:any)=>JSON.parse(message.message)));
  expect(requests.some((request:any)=>request.filters.some((filter:any)=>filter.authors?.includes(addressArticle.pubkey)&&filter['#d']?.includes(addressIdentifier)&&filter.limit===1))).toBe(true);
  expect(requests.every((request:any)=>!request.relay.includes('unconfigured'))).toBe(true);
  if(appId==='recipe-cards'){
    expect(await page.locator('#legacy-article-clear').evaluate(button=>button.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    const count=requests.length;await page.getByRole('button',{name:'Clear selection',exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>(window as any).__legacyMain.wire.filter((message:any)=>message.type==='relay-stream').length)).toBeGreaterThan(count);
    const last=await page.evaluate(()=>JSON.parse((window as any).__legacyMain.wire.filter((message:any)=>message.type==='relay-stream').at(-1).message));
    expect(last.filters).toEqual([{kinds:[30023],limit:32}]);
  }
});
test('trusted address control denies malformed, external and wrong-kind inputs without native I/O',async({page})=>{
  await open(page,'longform','address-entry');
  await page.locator('#legacy-article-toggle').click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__legacyMain.diagnostics.some((message:any)=>message.type==='ready'))).toBe(true);
  for(const input of ['not-an-address','https://reader.example/post',naddrEncode({kind:35129,pubkey:article.pubkey,identifier:'wrong-kind'})]){
    await page.getByLabel('Open by address',{exact:true}).fill(input);await page.getByRole('button',{name:'Open',exact:true}).click();
    await expect(page.locator('form [role=status]')).not.toHaveText('Opening article…');
  }
  expect(await page.evaluate(()=>(window as any).__legacyMain.wire.filter((message:any)=>message.type==='relay-stream'))).toEqual([]);
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
  await page.locator('#legacy-article-toggle').click();
  const staleControl=await page.locator('form').elementHandle();
  if(!staleControl)throw new Error('Missing trusted address control');
  await page.getByLabel('Open recipe by address',{exact:true}).fill(naddrEncode({kind:30023,pubkey:article.pubkey,identifier:'main-read'}));
  const reads=await page.evaluate(()=>(window as any).__legacyMain.wire.filter((message:any)=>message.type==='relay-stream').length);
  await page.evaluate(()=>{document.querySelector<HTMLIFrameElement>('#napplet')!.srcdoc='<!doctype html><html><body>Replacement document</body></html>';});
  await expect(page.getByRole('alert')).toHaveText('The napplet could not be loaded.');
  expect(await page.evaluate(()=>(window as any).__legacyMain.diagnostics)).toContainEqual({type:'error',sessionId:generation,code:'frame-navigation'});
  await page.evaluate(({event,generation})=>{const state=(window as any).__legacyMain;const stream=state.wire.find((m:any)=>m.type==='relay-stream');const request=JSON.parse(stream.message);state.reply({type:'capability.stream',sessionId:generation,sequence:stream.sequence,delivery:3,response:JSON.stringify({type:'relay.event',subId:request.subId,result:{event}})});},{event:article,generation});
  await expect(page.locator('#napplet')).toHaveCount(0);
  await expect(page.getByText('Main runtime article',{exact:true})).toHaveCount(0);
  await staleControl.evaluate(form=>form.dispatchEvent(new SubmitEvent('submit',{bubbles:true,cancelable:true})));
  expect(await page.evaluate(()=>(window as any).__legacyMain.wire.filter((message:any)=>message.type==='relay-stream').length)).toBe(reads);
  await expect(page.locator('form')).toHaveCount(0);
});

test('image failure from a replaced source never triggers the original guest fallback',async({page})=>{
  const frame=await open(page,'recipe-cards');
  const image=frame.locator('img').first();await expect(image).toHaveJSProperty('naturalWidth',1);
  const oldURL=await image.getAttribute('src');
  await image.evaluate(element=>{const img=element as HTMLImageElement;(window as any).originalImage=img;img.src='http://assets.example.com/denied';img.src='https://assets.example.com/replacement.png';});
  await expect(image).toHaveJSProperty('naturalWidth',1);
  await expect.poll(()=>frame.locator('body').evaluate(()=>(window as any).originalImage.isConnected)).toBe(true);
  await expect.poll(()=>page.evaluate(()=>(window as any).__legacyMain.wire.some((message:any)=>message.type==='capability'&&JSON.parse(message.message).url==='https://assets.example.com/replacement.png'))).toBe(true);
  await expect.poll(()=>image.getAttribute('src')).not.toBe(oldURL);
  expect(await image.getAttribute('src')).toMatch(/^blob:/);
});
test('removed image cancels native work and drops late byte handles without attachment',async({page})=>{
  const frame=await open(page,'recipe-cards','image-hold');
  await expect.poll(()=>page.evaluate(()=>(window as any).__legacyMain.imageReplies.length)).toBe(1);
  await frame.locator('img').first().evaluate(image=>{(window as any).removedImage=image;image.remove();});
  await expect.poll(()=>page.evaluate(()=>(window as any).__legacyMain.wire.some((message:any)=>message.type==='capability'&&JSON.parse(message.message).type==='legacy.image.cancel'))).toBe(true);
  await page.evaluate(()=>(window as any).__legacyMain.imageReplies[0]());
  await expect.poll(()=>frame.locator('body').evaluate(()=>(window as any).removedImage.getAttribute('src'))).toBeNull();
  expect(await page.evaluate(()=>(window as any).__legacyMain.wire.some((message:any)=>message.type==='capability'&&JSON.parse(message.message).type==='legacy.image.__chunk'))).toBe(false);
});
test('replaced image source cancels old work and only consumes the current byte handle',async({page})=>{
  const frame=await open(page,'recipe-cards','image-hold');
  await expect.poll(()=>page.evaluate(()=>(window as any).__legacyMain.imageReplies.length)).toBe(1);
  await frame.locator('img').first().evaluate(image=>{(image as HTMLImageElement).src='https://assets.example.com/new.png';});
  await expect.poll(()=>page.evaluate(()=>(window as any).__legacyMain.imageReplies.length)).toBe(2);
  await page.evaluate(()=>{const state=(window as any).__legacyMain;state.imageReplies[0]();state.imageReplies[1]();});
  await expect(frame.locator('img').first()).toHaveJSProperty('naturalWidth',1);
  expect(await page.evaluate(()=>(window as any).__legacyMain.wire.filter((message:any)=>message.type==='capability'&&JSON.parse(message.message).type==='legacy.image.__chunk').length)).toBe(1);
});
test('removing a rendered image releases its Blob URL',async({page})=>{
  await page.addInitScript(()=>{const revoke=URL.revokeObjectURL.bind(URL);(window as any).releasedImageURLs=[];URL.revokeObjectURL=(url:string)=>{(window as any).releasedImageURLs.push(url);revoke(url);};});
  const frame=await open(page,'recipe-cards');
  const image=frame.locator('img').first();await expect(image).toHaveJSProperty('naturalWidth',1);
  const url=await image.getAttribute('src');await image.evaluate(element=>element.remove());
  await expect.poll(()=>frame.locator('body').evaluate(()=>(window as any).releasedImageURLs)).toContain(url);
});

test('unchanged Longform renders its original hero and Markdown image paths as native Blob images',async({page})=>{
  const event=finalizeEvent({kind:30023,created_at:1700000000,content:'An inline image: ![Inline proof](https://assets.example.com/inline.png)',
    tags:[['d','image-read'],['title','Longform image paths'],['image','https://assets.example.com/hero.png']]},key);
  const frame=await open(page,'longform','legacy',event);
  await page.locator('#legacy-article-toggle').click();
  await page.getByLabel('Open by address',{exact:true}).fill(naddrEncode({kind:30023,pubkey:event.pubkey,identifier:'image-read'}));
  await page.getByRole('button',{name:'Open',exact:true}).click();
  await expect(frame.getByText('Longform image paths',{exact:true})).toBeVisible();
  const images=frame.locator('img.md-img');await expect(images).toHaveCount(2);
  for(const image of await images.all()){await expect(image).toHaveJSProperty('naturalWidth',1);expect(await image.getAttribute('src')).toMatch(/^blob:/);}
  expect(await page.evaluate(()=>(window as any).__legacyMain.wire.filter((message:any)=>message.type==='capability'&&JSON.parse(message.message).type==='legacy.image.bytes').map((message:any)=>JSON.parse(message.message).url))).toEqual(['https://assets.example.com/hero.png','https://assets.example.com/inline.png']);
  // Exercise the generic DOM attribute API in the same unchanged guest document.
  const oldURL=await images.first().getAttribute('src');
  await images.first().evaluate(image=>image.setAttribute('src','https://assets.example.com/attribute.png'));
  await expect.poll(()=>images.first().getAttribute('src')).not.toBe(oldURL);
  await expect(images.first()).toHaveJSProperty('naturalWidth',1);
  expect(await images.first().getAttribute('src')).toMatch(/^blob:/);
});
test('canonical percent expansion settles rejected Unicode sources before a later image needs a slot',async({page})=>{
  const frame=await open(page,'recipe-cards');
  await expect(frame.locator('img').first()).toHaveJSProperty('naturalWidth',1);
  await frame.locator('body').evaluate(()=>{
    const state=window as any;state.expandedImageErrors=0;
    const first=document.createElement('img'),second=document.createElement('img'),valid=document.createElement('img');
    first.onerror=second.onerror=()=>state.expandedImageErrors++;
    first.src='https://assets.example.com/'+ '飯'.repeat(1000);
    second.setAttribute('src','https://assets.example.com/'+ '餐'.repeat(1000));
    valid.id='after-expanded-images';valid.setAttribute('src','https://assets.example.com/after-expanded.png');
    document.body.append(first,second,valid);
  });
  await expect.poll(()=>frame.locator('body').evaluate(()=>(window as any).expandedImageErrors)).toBe(2);
  await expect(frame.locator('#after-expanded-images')).toHaveJSProperty('naturalWidth',1);
  const urls=await page.evaluate(()=>(window as any).__legacyMain.wire.filter((message:any)=>message.type==='capability'&&JSON.parse(message.message).type==='legacy.image.bytes').map((message:any)=>JSON.parse(message.message).url));
  expect([...new Set(urls)]).toEqual(['https://assets.example.com/recipe.png','https://assets.example.com/after-expanded.png']);
});
