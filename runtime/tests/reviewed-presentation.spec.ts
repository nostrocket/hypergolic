import {test,expect,type Page,type FrameLocator} from '@playwright/test';
import {build} from 'vite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {finalizeEvent} from 'nostr-tools/pure';
import {injectReviewedPresentation} from '../src/reviewed-presentation';
import {injectCreatorUpload} from '../src/reviewed-creator-upload';
import {preparePresentationFixtures} from '../tools/prepare-presentation-fixtures.mjs';
const pins=JSON.parse(readFileSync('fixtures/reviewed-presentation-manifest.json','utf8'));
const generation='12345678-1234-4234-8234-123456789abc';
const hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const pngHash=hash(Buffer.from(png,'base64'));
const fixtureDomains:Record<string,string[]>={
  'emoji-browser':['common','identity','inc','outbox','relay','resource','storage','theme'],
  'mapplets':['inc','intent','outbox','resource'],'feed-builder':['identity','intent','outbox','relay','storage'],
  'emoji-pack-creator':['common','identity','inc','outbox','relay','resource','storage','theme','upload'],
};
const ownKey=new Uint8Array(32);ownKey[31]=11;
const packKey=new Uint8Array(32);packKey[31]=12;
const note=finalizeEvent({kind:1,created_at:Math.floor(Date.now()/1000),content:'Neutral creator note',tags:[]},ownKey);
const feedContent='nfilter1qgqswq3rwsxkuet4w3exzmpdw3hhq6tr6f2w34';
const savedFeed=finalizeEvent({kind:39823,created_at:Math.floor(Date.now()/1000),content:feedContent,
  tags:[['d','neutral-saved'],['title','neutral-saved'],['t','nfilter']]},ownKey);
const pack=finalizeEvent({kind:30030,created_at:Math.floor(Date.now()/1000),content:'',tags:[['d','neutral-pack'],['title','Neutral pack'],
  ...Array.from({length:6},(_,index)=>['emoji','sample_'+index,`https://assets.example.com/${index}.png`])]},packKey);
let host='',document='';
test.beforeAll(async()=>{
  await preparePresentationFixtures();
  const result:any=await build({configFile:false,logLevel:'silent',define:{__BUNDLED_FIXTURES__:'{}',__UX_HTML__:'""',__UX_SHA256__:'""',__UX_AGGREGATE__:'""'},
    build:{write:false,minify:true,target:'es2022',modulePreload:false,lib:{entry:'src/main.ts',formats:['iife'],name:'HypergolicRuntime'}}});
  host=(Array.isArray(result)?result[0]:result).output.find((item:any)=>item.type==='chunk').code;
  document=/const document = `([\s\S]+?)`;/.exec(readFileSync('tools/build.mjs','utf8'))![1]!;
});
async function open(page:Page,appId:string,variant='exact',uploadMode='complete') {
  const pin=pins.find((value:any)=>value.appId===appId);
  const domains=fixtureDomains[appId]??['identity','inc','relay','storage','theme'];
  const original=readFileSync(`.test-fixtures/presentation/${appId}.html`);
  expect(hash(original)).toBe(pin.sha256);expect(original.length).toBe(pin.bytes);
  const bytes=variant==='new-version'?Buffer.concat([original,Buffer.from('\n<!-- hypothetical updated fixture -->')]):original;
  const htmlHash=hash(bytes),aggregateHash=hash(htmlHash+' /index.html\n');
  await page.clock.install();
  await page.route('**/assets/runtime/index.html?*',route=>route.fulfill({contentType:'text/html',body:document}));
  await page.route('**/assets/runtime/host.js',route=>route.fulfill({contentType:'text/javascript',body:host}));
  await page.addInitScript(({generation,appId,pin,variant,html,htmlHash,aggregateHash,note,pack,png,savedFeed,domains,pngHash,uploadMode})=>{
    if(window!==window.top)return;
    const bytes=Uint8Array.from(atob(html),character=>character.charCodeAt(0));
    const listeners=new Set<(event:{data:string})=>void>(),held=new Map<string,any>();
    const state:any={requests:[],diagnostics:[],batches:0,chunks:0,releaseImages:false};
    (window as any).__presentation=state;
    const emit=(envelope:unknown)=>{for(const listener of listeners)listener({data:JSON.stringify(envelope)});};
    const reply=(envelope:any,response:unknown)=>emit({type:'capability.result',sessionId:generation,sequence:envelope.sequence,response:response===null?null:JSON.stringify(response)});
    const matches=(event:any,filters:any[])=>filters.some(filter=>(!filter.kinds||filter.kinds.includes(event.kind))&&
      (!filter.authors||filter.authors.includes(event.pubkey))&&(!filter['#p']||event.tags.some((t:string[])=>t[0]==='p'&&filter['#p'].includes(t[1])))&&
      (!filter['#P']||event.tags.some((t:string[])=>t[0]==='P'&&filter['#P'].includes(t[1]))));
    const events=(filters:any[])=>[note,pack,savedFeed].filter(event=>matches(event,filters));
    Object.defineProperty(window,'HypergolicHost',{value:{
      addEventListener:(_:string,listener:any)=>listeners.add(listener),removeEventListener:(_:string,listener:any)=>listeners.delete(listener),
      postMessage(raw:string){
        const envelope=JSON.parse(raw);state.requests.push(envelope);
        if(envelope.type==='ready'||envelope.type==='error'){state.diagnostics.push(envelope);return;}
        if(envelope.type==='artifact.read'){
          const payload=bytes.slice(envelope.sequence*49152,(envelope.sequence+1)*49152);
          emit({type:'artifact.chunk',sessionId:generation,sequence:envelope.sequence,publisher:'1'.repeat(64),
            appId:variant==='other-app'?'unreviewed-reader':appId,eventId:pin.eventId,version:aggregateHash,htmlHash,
            domains,
            base64:btoa(String.fromCharCode(...payload)),byteLength:payload.length,totalBytes:bytes.length,done:(envelope.sequence+1)*49152>=bytes.length});return;
        }
        if(envelope.type==='relay-stream'){
          const request=JSON.parse(envelope.message);let delivery=0;
          queueMicrotask(()=>{
            for(const event of events(request.filters))emit({type:'capability.stream',sessionId:generation,sequence:envelope.sequence,delivery:++delivery,
              response:JSON.stringify({type:request.type.startsWith('outbox.')?'outbox.event':'relay.event',subId:request.subId,result:{event}})});
            emit({type:'capability.stream',sessionId:generation,sequence:envelope.sequence,delivery:++delivery,response:JSON.stringify({type:'relay.eose',subId:request.subId})});
          });return;
        }
        if(envelope.type!=='capability')return;
        const request=JSON.parse(envelope.message);let response:any={type:request.type+'.result',id:request.id};
        if(request.type==='identity.getPublicKey')response.pubkey=note.pubkey;
        else if(request.type==='identity.getFollows')response.pubkeys=[pack.pubkey];
        else if(request.type==='identity.getRelays')response.relays={'wss://relay.example.org':{read:true,write:false}};
        else if(request.type==='storage.get')response.value=null;
        else if(request.type==='relay.query'||request.type==='outbox.query')response.events=events(request.filters).map(event=>({event}));
        else if(request.type==='outbox.publish'){response.ok=false;response.error='review cancelled';}
        else if(request.type==='relay.publish'){response.ok=false;response.error='review cancelled';}
        else if(request.type==='upload.__begin'){response.token='00000000-0000-4000-8000-000000000001';response.uploadId='presentation-upload';}
        else if(request.type==='upload.__append')response.cursor=request.offset+atob(request.base64).length;
        else if(request.type==='upload.__seal'){
          if(uploadMode==='denied')response.error='policy denied';
          else {
            const complete={ok:true,uploadId:'presentation-upload',status:'complete',rail:'blossom',
              url:`https://files.example.org/${pngHash}.png`,sha256:pngHash,size:atob(png).length,mimeType:'image/png'};
            state.pushUpload=(status:unknown=complete,overrides={})=>emit({type:'capability.upload',sessionId:generation,sequence:envelope.sequence,
              delivery:1,response:JSON.stringify({type:'upload.status.changed',status}),...overrides});
            response.result=uploadMode==='complete'?complete:{ok:true,uploadId:'presentation-upload',status:'pending',rail:'blossom'};
            if(uploadMode==='terminal-first')state.pushUpload();
          }
        }
        else if(request.type==='common.getProfile')response={...response,ok:false,profile:null};
        else if(request.type==='resource.bytesMany'){
          state.batches++;
          if(!state.releaseImages){held.set(request.id,envelope);return;}
          response.items=request.requests.map((item:any,index:number)=>({url:item.url,ok:true,
            transfer:{handle:`00000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,length:atob(png).length,mime:'image/png'}}));
        }else if(request.type==='resource.__chunk'){state.chunks++;response.base64=png;}
        else if(request.type==='resource.cancel'){
          const prior=held.get(request.id);if(prior){held.delete(request.id);reply(prior,{type:'resource.bytesMany.error',id:request.id,error:'timeout'});}
          reply(envelope,null);return;
        }
        reply(envelope,response);
      },
    }});
  },{generation,appId,pin,variant,html:bytes.toString('base64'),htmlHash,aggregateHash,note,pack,png,savedFeed,domains,pngHash,uploadMode});
  await page.goto(`/assets/runtime/index.html?sessionId=${generation}&source=published`);
  const frame=page.frameLocator('#napplet');
  await expect(frame.locator('#hypergolic-reviewed-presentation')).toHaveCount(variant==='exact'?1:0);
  await expect(frame.locator('[data-hypergolic-creator-upload]')).toHaveCount(appId==='emoji-pack-creator'&&variant==='exact'?1:0);
  await expect(frame.locator('body')).not.toHaveText('');
  return frame;
}
async function fits(locator:ReturnType<FrameLocator['locator']>) {
  const boxes=await locator.evaluateAll(elements=>elements.map(element=>{
    const rect=element.getBoundingClientRect();return{left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,width:innerWidth,height:innerHeight};
  }));
  expect(boxes.length).toBeGreaterThan(0);
  for(const box of boxes){expect(box.left).toBeGreaterThanOrEqual(-1);expect(box.right).toBeLessThanOrEqual(box.width+1);
    expect(box.top).toBeGreaterThanOrEqual(-1);expect(box.bottom).toBeLessThanOrEqual(box.height+1);}
}
for(const width of [320,360])for(const colorScheme of ['light','dark'] as const){
  test(`exact Emoji Browser controls fit and original Resource retry/selection work at ${width}px ${colorScheme}`,async({page})=>{
    await page.setViewportSize({width,height:844});await page.emulateMedia({colorScheme});
    const frame=await open(page,'emoji-browser');
    await expect.poll(()=>page.evaluate(()=>(window as any).__presentation.batches)).toBeGreaterThanOrEqual(1);
    await expect(frame.locator('img[data-emoji-resolver]')).toHaveCount(6);
    await page.clock.fastForward(5100);
    const retry=frame.getByRole('button',{name:'Try again (6)',exact:true});await expect(retry).toBeVisible();
    await fits(frame.locator('.topbar button,.toolbar button,.toolbar input'));
    for(const button of await frame.locator('.toolbar button').all())expect((await button.boundingBox())!.height,
      JSON.stringify(await button.evaluate(element=>({text:element.textContent,width:innerWidth,media:matchMedia('(max-width:720px)').matches,
        minimum:getComputedStyle(element).minBlockSize,classes:element.className})))).toBeGreaterThanOrEqual(44);
    await frame.getByRole('button',{name:'Pack',exact:true}).click();await expect(frame.getByRole('button',{name:'Pack',exact:true})).toHaveAttribute('aria-pressed','true');
    await page.evaluate(()=>(window as any).__presentation.releaseImages=true);
    await retry.click();await expect.poll(()=>page.evaluate(()=>(window as any).__presentation.chunks)).toBeGreaterThanOrEqual(6);
    await expect(frame.locator('.emoji-card')).toHaveCount(6);
    await frame.locator('.emoji-card').first().click();await expect(frame.locator('.detail')).toContainText('sample_0');
    await fits(frame.locator('.topbar button,.toolbar button,.toolbar input,.emoji-card,.detail button'));
    expect(await page.evaluate(()=>(window as any).__presentation.batches)).toBeGreaterThanOrEqual(2);
    expect(await frame.locator('body').evaluate(()=>typeof(window as any).nostr)).toBe('undefined');
  });
  test(`exact Creator Signals controls have readable theme contrast at ${width}px ${colorScheme}`,async({page})=>{
    await page.setViewportSize({width,height:844});await page.emulateMedia({colorScheme});
    const frame=await open(page,'creator-signals');
    const input=frame.getByRole('textbox',{name:'Search creator content'});await expect(input).toBeVisible();
    await input.fill('Neutral');await expect(input).toHaveValue('Neutral');
    const colors=await frame.locator('input,button:not(:disabled)').evaluateAll(elements=>elements.map(element=>{
      const style=getComputedStyle(element);return{color:style.color,background:style.backgroundColor};
    }));
    const luminance=(value:string)=>{const rgb=value.match(/[\d.]+/g)!.slice(0,3).map(channel=>{const c=Number(channel)/255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;});return rgb[0]!*.2126+rgb[1]!*.7152+rgb[2]!*.0722;};
    expect(colors.length).toBeGreaterThan(3);
    for(const color of colors){const a=luminance(color.color),b=luminance(color.background);expect((Math.max(a,b)+.05)/(Math.min(a,b)+.05)).toBeGreaterThanOrEqual(4.5);}
    const background=await input.evaluate(element=>getComputedStyle(element).backgroundColor);
    expect(background).not.toBe('rgb(11, 11, 11)');
    if(colorScheme==='light')expect(luminance(background)).toBeGreaterThan(.5);
    else expect(luminance(background)).toBeLessThan(.2);
    expect(await frame.locator('body').evaluate(()=>typeof(window as any).nostr)).toBe('undefined');
  });
}
for(const width of [320,360])test(`exact Mapplets toolbar controls fit and click at ${width}px with a usable map region`,async({page})=>{
  await page.setViewportSize({width,height:740});
  const frame=await open(page,'mapplets');
  const queries=()=>page.evaluate(()=>(window as any).__presentation.requests.filter((envelope:any)=>envelope.type==='capability'&&JSON.parse(envelope.message).type==='outbox.query').length);
  await expect.poll(queries).toBeGreaterThan(0);
  // Selected-state presentation fixture only; native mouse selection and editor routing are separate evidence.
  await frame.locator('#editButton').evaluate((button:HTMLButtonElement)=>{button.hidden=false;});
  await frame.locator('#transitControls').evaluate((group:HTMLElement)=>{group.hidden=false;});
  const controls=frame.locator('.topbar button:not([hidden]),.topbar select');
  await fits(controls);
  for(const control of await controls.all()){
    const box=(await control.boundingBox())!;expect(box.height).toBeGreaterThanOrEqual(44);
    expect(await control.evaluate(element=>{const box=element.getBoundingClientRect(),hit=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2);return hit===element||element.contains(hit);})).toBe(true);
  }
  await frame.getByRole('button',{name:'Edit',exact:true}).click();
  await frame.getByRole('button',{name:'Route',exact:true}).click();
  await expect(frame.getByRole('button',{name:'Route',exact:true})).toHaveAttribute('aria-pressed','true');
  const before=await queries();await frame.getByRole('button',{name:'Reload map',exact:true}).click();
  await expect.poll(queries).toBeGreaterThan(before);
  const map=(await frame.locator('.map-frame').boundingBox())!;
  expect(map.width).toBeGreaterThanOrEqual(width-40);expect(map.height).toBeGreaterThanOrEqual(300);
  await fits(frame.locator('.map-frame'));
});
for(const width of [320,360])test(`exact Feed Manager fields and Save work through reachable mobile controls at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:740});const frame=await open(page,'feed-builder');
  await expect(frame.locator('.saved-item')).toHaveCount(1);
  for(const control of await frame.locator('.rail button').all()){
    await control.scrollIntoViewIfNeeded();await fits(control);
    const box=(await control.boundingBox())!;expect(box.width).toBeGreaterThanOrEqual(44);expect(box.height).toBeGreaterThanOrEqual(44);
    expect(await control.evaluate(element=>{const box=element.getBoundingClientRect(),hit=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2);return hit===element||element.contains(hit);})).toBe(true);
  }
  await frame.getByRole('button',{name:'＋ New',exact:true}).click();
  for(const tab of await frame.getByRole('tablist',{name:'View',exact:true}).getByRole('tab').all()){
    await fits(tab);expect((await tab.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await frame.getByRole('tab',{name:'JSON',exact:true}).click();
  const name=frame.getByPlaceholder('morning-reads'),json=frame.locator('textarea'),relays=frame.getByPlaceholder('wss://relay.example…');
  await name.fill('neutral-filter');await json.fill('[{"kinds":[1],"#t":["neutral-topic"]}]');
  await expect(frame.locator('.type-indicator')).toHaveText('will save as nfilter');await expect(relays).toHaveValue('');
  const save=frame.getByRole('button',{name:'Save',exact:true});await expect(save).toBeEnabled();
  for(const control of [name,json,relays]){
    await control.scrollIntoViewIfNeeded();await fits(control);
    expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await page.mouse.move(width-8,300);await page.mouse.wheel(0,-2000);
  await expect.poll(()=>frame.locator('body').evaluate(()=>document.scrollingElement!.scrollTop)).toBe(0);
  const scroll=await frame.locator('body').evaluate(()=>({height:document.scrollingElement!.scrollHeight,viewport:innerHeight,
    overflow:getComputedStyle(document.documentElement).overflowY}));
  expect(scroll.height).toBeGreaterThan(scroll.viewport);expect(['hidden','clip']).not.toContain(scroll.overflow);
  await page.mouse.wheel(0,1200);
  await expect.poll(()=>frame.locator('body').evaluate(()=>document.scrollingElement!.scrollTop)).toBeGreaterThan(0);
  await expect(() => fits(save)).toPass({timeout:5000});
  expect((await save.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await save.evaluate(element=>{const box=element.getBoundingClientRect(),hit=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2);return hit===element||element.contains(hit);})).toBe(true);
  expect(await frame.locator('body').evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await save.click();await expect(frame.locator('.status')).toContainText('review cancelled');
  const requests=await page.evaluate(()=>(window as any).__presentation.requests.filter((row:any)=>row.type==='capability').map((row:any)=>JSON.parse(row.message)));
  expect(requests.filter((row:any)=>row.type==='outbox.publish')).toEqual([{type:'outbox.publish',id:expect.any(String),event:{kind:39823,
    tags:[['d','neutral-filter'],['title','neutral-filter'],['t','nfilter']],content:feedContent,created_at:expect.any(Number)}}]);
  expect(requests.some((row:any)=>row.type==='relay.publish'||row.type.startsWith('upload.'))).toBe(false);
});
test('exact Feed Manager desktop retains its original sidebar and viewport layout',async({page})=>{
  await page.setViewportSize({width:1024,height:740});const frame=await open(page,'feed-builder');
  const rail=(await frame.locator('.rail').boundingBox())!,editor=(await frame.locator('.editor').boundingBox())!;
  expect(rail.width).toBe(240);expect(editor.x).toBe(240);expect((await frame.locator('main').boundingBox())!.height).toBe(740);
});
test('unchanged Feed Manager preserves sequential JSON typing and the textarea caret',async({page})=>{
  const frame=await open(page,'feed-builder');await frame.getByRole('button',{name:'＋ New',exact:true}).click();
  await frame.getByRole('tab',{name:'JSON',exact:true}).click();
  const json=frame.locator('textarea'),text='[{"kinds":[1],"#t":["neutral-topic"]}]';
  await json.focus();await json.press('ControlOrMeta+A');await json.pressSequentially(text,{delay:5});
  await expect(json).toHaveValue(text);
  expect(await json.evaluate((element:HTMLTextAreaElement)=>[element.selectionStart,element.selectionEnd])).toEqual([text.length,text.length]);
  await expect(frame.locator('.type-indicator')).toHaveText('will save as nfilter');
});
for(const width of [320,360])test(`exact Emoji Pack Creator fields, staging and Publish remain usable at ${width}px`,async({page},info)=>{
  await page.setViewportSize({width,height:600});const frame=await open(page,'emoji-pack-creator');
  const title=frame.getByRole('textbox',{name:'Pack title',exact:true}),identifier=frame.locator('[aria-label="Pack identifier"]');
  await title.fill('Neutral reaction pack title');await fits(title);expect((await title.boundingBox())!.width).toBeGreaterThanOrEqual(width-70);
  const regenerate=frame.getByRole('button',{name:'Regenerate pack id'}),before=await identifier.textContent();await regenerate.click();
  await expect(identifier).not.toHaveText(before!);await expect(title).toHaveValue('Neutral reaction pack title');await fits(identifier);
  expect(await identifier.evaluate(element=>element.scrollWidth<=element.clientWidth&&getComputedStyle(element).whiteSpace==='normal'&&getComputedStyle(element).overflow==='visible')).toBe(true);
  const shortcode=frame.getByRole('textbox',{name:'Emoji shortcode'}),upload=frame.getByRole('button',{name:'Upload emoji image'});
  await shortcode.fill('neutral_code');await fits(shortcode);await fits(upload);
  for(const control of [title,shortcode,upload,regenerate]){
    const box=(await control.boundingBox())!;expect(box.height).toBeGreaterThanOrEqual(44);expect(box.width).toBeGreaterThanOrEqual(44);
  }
  const chooser=page.waitForEvent('filechooser');await upload.click();await (await chooser).setFiles({name:'neutral.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
  await expect(frame.locator('[data-staged-emoji]')).toHaveCount(1);await expect(frame.getByRole('status')).toContainText('Uploaded :neutral_code:');
  const publish=frame.getByRole('button',{name:'Publish pack',exact:true});await expect(publish).toBeEnabled();
  await page.mouse.move(width-5,250);await page.mouse.wheel(0,-2000);
  await expect.poll(()=>frame.locator('body').evaluate(()=>document.scrollingElement!.scrollTop)).toBe(0);
  await page.mouse.wheel(0,1200);
  await expect.poll(()=>frame.locator('body').evaluate(()=>document.scrollingElement!.scrollTop)).toBeGreaterThan(0);
  await fits(publish);expect((await publish.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await publish.evaluate(element=>{const box=element.getBoundingClientRect(),hit=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2);return hit===element||element.contains(hit);})).toBe(true);
  expect(await frame.locator('body').evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await info.attach('creator-layout.json',{contentType:'application/json',body:JSON.stringify(await frame.locator('main').evaluate(element=>({
    viewport:{width:innerWidth,height:innerHeight},documentHeight:document.scrollingElement!.scrollHeight,
    titleWidth:element.querySelector('[aria-label="Pack title"]')!.getBoundingClientRect().width,
    identifier:{width:element.querySelector('.dtag')!.getBoundingClientRect().width,height:element.querySelector('.dtag')!.getBoundingClientRect().height},
    stagedHeight:element.querySelector('.staged')!.getBoundingClientRect().height,scrollTop:document.scrollingElement!.scrollTop})))});
  await page.screenshot({path:info.outputPath('creator-mobile.png')});
  await publish.click();await expect(frame.getByRole('alert')).toContainText('review cancelled');
  const calls=await page.evaluate(()=>(window as any).__presentation.requests.filter((row:any)=>row.type==='capability').map((row:any)=>JSON.parse(row.message)));
  expect(calls.filter((row:any)=>row.type==='relay.publish').map((row:any)=>row.event.kind)).toEqual([30030]);
});
async function startCreatorUpload(page:Page, mode:string, variant='exact') {
  await page.route('**/*',route=>route.abort());
  const frame=await open(page,'emoji-pack-creator',variant,mode);
  await frame.getByRole('textbox',{name:'Emoji shortcode'}).fill('neutral_code');
  const chooser=page.waitForEvent('filechooser');
  await frame.getByRole('button',{name:'Upload emoji image'}).click();
  await (await chooser).setFiles({name:'neutral.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
  await expect.poll(()=>page.evaluate(()=>(window as any).__presentation.requests.filter((row:any)=>
    row.type==='capability'&&JSON.parse(row.message).type==='upload.__seal').length)).toBe(1);
  return frame;
}
test('exact Emoji Pack Creator stages only the matching trusted terminal upload after the SDK deadline',async({page})=>{
  const frame=await startCreatorUpload(page,'pending');
  const staged=frame.locator('[data-staged-emoji]');
  await expect(staged).toHaveCount(0);await expect(frame.getByText('upload failed',{exact:true})).toHaveCount(0);
  const complete={ok:true,uploadId:'presentation-upload',status:'complete',rail:'blossom',
    url:`https://files.example.org/${pngHash}.png`,sha256:pngHash,size:Buffer.from(png,'base64').length,mimeType:'image/png'};
  await frame.locator('body').evaluate(status=>{
    window.dispatchEvent(new MessageEvent('message',{source:parent,data:{type:'upload.status.changed',status}}));
    window.dispatchEvent(new Event('pagehide'));
  },complete);
  await page.evaluate(status=>{
    const state=(window as any).__presentation;
    state.pushUpload({...status,uploadId:'unrelated-upload'});
    state.pushUpload(status,{sessionId:'unrelated-generation'});
  },complete);
  await page.clock.fastForward(31_000);
  await expect(staged).toHaveCount(0);
  await page.evaluate(()=>(window as any).__presentation.pushUpload());
  await expect(staged).toHaveCount(1);await expect(frame.getByRole('status')).toContainText('Uploaded :neutral_code:');
});
test('exact Emoji Pack Creator handles a matching terminal upload before its pending response',async({page})=>{
  const frame=await startCreatorUpload(page,'terminal-first');
  await expect(frame.locator('[data-staged-emoji]')).toHaveCount(1);
});
for(const [status,error] of [['failed','outcome unknown'],['cancelled','user cancelled']]){
  test(`exact Emoji Pack Creator preserves terminal upload ${status}`,async({page})=>{
    const frame=await startCreatorUpload(page,'pending');
    await page.evaluate(({status,error})=>(window as any).__presentation.pushUpload({
      ok:false,uploadId:'presentation-upload',status,rail:'blossom',error}),{status,error});
    await expect(frame.getByText(error,{exact:true})).toBeVisible();
    await expect(frame.locator('[data-staged-emoji]')).toHaveCount(0);
    await expect(frame.getByRole('button',{name:'Upload emoji image'})).toBeEnabled();
  });
}
test('exact Emoji Pack Creator preserves an initial upload denial',async({page})=>{
  const frame=await startCreatorUpload(page,'denied');
  await expect(frame.getByText('policy denied',{exact:true})).toBeVisible();
  await expect(frame.locator('[data-staged-emoji]')).toHaveCount(0);
});
test('exact Emoji Pack Creator times out an upload without a terminal status',async({page})=>{
  const frame=await startCreatorUpload(page,'pending');
  await page.clock.fastForward(661_000);
  await expect(frame.getByText('upload confirmation timed out',{exact:true})).toBeVisible();
  await page.evaluate(()=>(window as any).__presentation.pushUpload());
  await expect(frame.locator('[data-staged-emoji]')).toHaveCount(0);
});
test('an unreviewed Emoji Pack Creator version receives the original pending upload result',async({page})=>{
  const frame=await startCreatorUpload(page,'pending','new-version');
  await expect(frame.getByText('upload failed',{exact:true})).toBeVisible();
  await page.evaluate(()=>(window as any).__presentation.pushUpload());
  await expect(frame.locator('[data-staged-emoji]')).toHaveCount(0);
});
test('exact Emoji Pack Creator desktop retains its original two-column metadata layout',async({page})=>{
  await page.setViewportSize({width:1024,height:740});const frame=await open(page,'emoji-pack-creator');
  const columns=await frame.locator('.meta').evaluate(element=>getComputedStyle(element).gridTemplateColumns.split(' '));
  expect(columns).toHaveLength(2);expect((await frame.locator('main').boundingBox())!.height).toBe(740);
});
for(const appId of ['emoji-browser','creator-signals','mapplets','feed-builder','emoji-pack-creator'])for(const variant of ['other-app','new-version']){
  test(`ordinary ${appId} ${variant} receives no presentation override`,async({page})=>{await open(page,appId,variant);});
}
test('unpublished, wrong-app and future-version metadata retain byte-identical documents and CSP',()=>{
  const html='<head><meta http-equiv="Content-Security-Policy" content="default-src none"></head><body></body>';
  for(const pin of pins){for(const metadata of [{published:false,appId:pin.appId,aggregateHash:pin.aggregateHash},
    {published:true,appId:'other',aggregateHash:pin.aggregateHash},{published:true,appId:pin.appId,aggregateHash:'f'.repeat(64)}]){
    expect(injectReviewedPresentation(html,metadata)).toBe(html);
    expect(injectCreatorUpload(html,{...metadata,domains:['upload']})).toBe(html);
  }}
});
