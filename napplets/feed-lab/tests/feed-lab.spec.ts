import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
async function mount(page: Page, mode = 'notes') {
  await page.setContent('<style>body{margin:0}iframe{width:390px;height:844px;border:0}</style>');
  const mock = `<script>window.calls=[];window.napplet={relay:{query:async filters=>{window.calls.push(filters);
    ${mode == 'pending' ? 'return new Promise(()=>{});' : mode == 'error' ? 'throw new Error("relay query failed");' : mode == 'empty' ? 'return [];' : 'return [{event:{id:"a".repeat(64),content:"<img src=x onerror=alert(1)> hello"}}];'}
  }}};</script>`;
  await page.evaluate(content => { const frame=document.createElement('iframe');frame.id='fixture';frame.sandbox.add('allow-scripts');frame.srcdoc=content;document.body.append(frame); }, html.replace('<head>', '<head>'+mock));
  const frame=page.frameLocator('#fixture'); await expect(frame.getByTestId('lab')).toHaveAttribute('data-ready','true'); return frame;
}
test('genuine SDK query renders content as text with original filter and exact event id', async ({page})=>{
  const frame=await mount(page);await frame.getByRole('button',{name:'Query notes',exact:true}).click();
  await expect(frame.locator('#status')).toHaveText('Received 1 signed note.');
  await expect(frame.locator('#events')).toContainText('<img src=x onerror=alert(1)> hello');
  await expect(frame.locator('#events img')).toHaveCount(0);
  expect(await frame.locator('body').evaluate(()=> (window as any).calls)).toEqual([[{kinds:[1],limit:8}]]);
});
test('empty query and failure remain distinct UI states',async({page})=>{
  let frame=await mount(page,'empty');await frame.getByRole('button',{name:'Query empty sample'}).click();
  await expect(frame.locator('#status')).toHaveText('Query completed. No matching notes.');
  expect(await frame.locator('body').evaluate(()=> (window as any).calls)).toEqual([[{kinds:[1],limit:0}]]);
  frame=await mount(page,'error');await frame.getByRole('button',{name:'Query notes',exact:true}).click();
  await expect(frame.locator('#status')).toHaveText('Query failed: relay query failed');await expect(frame.locator('#lab')).toHaveAttribute('data-state','error');
});
test('invalid JSON does not call SDK and pending query prevents duplicate input',async({page})=>{
  let frame=await mount(page);await frame.locator('#filters').fill('invalid');await frame.getByRole('button',{name:'Query notes',exact:true}).click();
  await expect(frame.locator('#status')).toContainText('Query failed:');expect(await frame.locator('body').evaluate(()=> (window as any).calls)).toEqual([]);
  frame=await mount(page,'pending');await frame.getByRole('button',{name:'Query notes',exact:true}).click();
  await expect(frame.locator('#status')).toHaveText('Reading notes…');await expect(frame.getByRole('button',{name:'Query notes',exact:true})).toBeDisabled();
});

async function streamMount(page:Page) {
  await page.setContent('<iframe id="fixture" sandbox="allow-scripts" style="width:390px;height:844px"></iframe>');
  const mock=`<script>window.stream={closed:0};window.napplet={relay:{subscribe:(filters,onEvent,onEose)=>{
    window.stream.filters=filters;window.stream.event=onEvent;window.stream.eose=onEose;return {close:()=>window.stream.closed++};
  },query:async()=>[]}};</script>`;
  await page.locator('#fixture').evaluate((node,content)=>(node as HTMLIFrameElement).srcdoc=content,html.replace('<head>','<head>'+mock));
  const frame=page.frameLocator('#fixture');await expect(frame.getByTestId('lab')).toHaveAttribute('data-ready','true');return frame;
}
test('live UI keeps at most 32 text-only rows, suppresses duplicates and retains an editable draft',async({page})=> {
  const frame=await streamMount(page);await frame.locator('#draft').fill('draft stays while reading');await frame.getByRole('button',{name:'Start live feed'}).click();
  await frame.locator('body').evaluate(()=>{const stream=(window as any).stream;for(let i=0;i<40;i++)stream.event({event:{id:i.toString(16).padStart(64,'0'),content:'<img src=x onerror=alert(1)> '+i}});stream.event({event:{id:(39).toString(16).padStart(64,'0'),content:'duplicate'}});stream.eose();});
  await expect(frame.locator('#stream-status')).toHaveText('Live · 40 signed notes · history loaded.');await expect(frame.locator('#events li')).toHaveCount(32);
  await expect(frame.locator('#events img')).toHaveCount(0);await expect(frame.locator('#draft')).toHaveValue('draft stays while reading');
  await expect(frame.getByRole('button',{name:'Query notes',exact:true})).toBeDisabled();await frame.getByRole('button',{name:'Close live feed'}).click();
  await expect(frame.locator('#stream-status')).toHaveText('Live feed closed.');await expect(frame.getByRole('button',{name:'Start live feed'})).toBeEnabled();
  await frame.locator('body').evaluate(()=>(window as any).stream.event({event:{id:'f'.repeat(64),content:'late'}}));await expect(frame.locator('#events li')).toHaveCount(32);
  expect(await frame.locator('body').evaluate(()=>(window as any).stream.closed)).toBe(1);
});
test('live UI observes only a captured-parent terminal response and restores controls',async({page})=> {
  const frame=await streamMount(page);await frame.getByRole('button',{name:'Start live feed'}).click();
  await frame.locator('body').evaluate(()=>window.postMessage({type:'relay.closed',reason:'guest forged'},'*'));
  await expect(frame.locator('#lab')).toHaveAttribute('data-stream','open');
  await page.evaluate(()=>{const target=(document.querySelector('#fixture') as HTMLIFrameElement).contentWindow!;target.postMessage({type:'relay.closed',reason:'native owner revoked'},'*');});
  await expect(frame.locator('#stream-status')).toHaveText('Live feed closed: native owner revoked');await expect(frame.getByRole('button',{name:'Start live feed'})).toBeEnabled();
});

test('optional follows is an explicit SDK read, makes no relay request and cannot repaint after account change',async({page})=>{
 await page.setContent('<iframe id="fixture" sandbox="allow-scripts" style="width:390px;height:844px"></iframe>');
 const mock=`<script>window.proof={calls:0,queries:0};window.napplet={identity:{getFollows:()=>{window.proof.calls++;return new Promise(resolve=>window.proof.resolve=resolve);},onChanged:callback=>{window.proof.change=callback;return {close:()=>{}};}},relay:{query:()=>{window.proof.queries++;return Promise.resolve([]);}}};</script>`;
 await page.locator('#fixture').evaluate((node,content)=>(node as HTMLIFrameElement).srcdoc=content,html.replace('<head>','<head>'+mock));
 const frame=page.frameLocator('#fixture');await expect(frame.getByTestId('lab')).toHaveAttribute('data-ready','true');await frame.locator('#follows').click();
 await frame.locator('body').evaluate(()=>{const proof=(window as unknown as Window & {proof:{calls:number;queries:number;change():void;resolve(value:string[]):void}}).proof;proof.change();proof.resolve(['old user']);});
 await expect(frame.locator('#follows-result')).toHaveText('');await expect(frame.locator('#follows-status')).toHaveText('No follows request yet.');
 expect(await frame.locator('body').evaluate(()=>{const proof=(window as unknown as Window & {proof:{calls:number;queries:number}}).proof;return [proof.calls,proof.queries];})).toEqual([1,0]);
});

async function publicationMount(page:Page) {
 await page.setContent('<iframe id="fixture" sandbox="allow-scripts" style="width:390px;height:844px"></iframe>');
 const mock=`<script>window.proof={calls:[]};window.napplet={identity:{onChanged:callback=>{window.proof.change=callback;return {close:()=>{}};}},relay:{query:async()=>[]},outbox:{publish:(event,options)=>{window.proof.calls.push({event,options});return new Promise((resolve,reject)=>{window.proof.resolve=resolve;window.proof.reject=reject;});}}};</script>`;
 await page.locator('#fixture').evaluate((node,content)=>(node as HTMLIFrameElement).srcdoc=content,html.replace('<head>','<head>'+mock));
 const frame=page.frameLocator('#fixture');await expect(frame.getByTestId('lab')).toHaveAttribute('data-ready','true');return frame;
}
test('typed JSON options survive blur and reach the original SDK without rewriting keys', async ({page}) => {
 const frame=await publicationMount(page);
 for (const id of ['filters','outbox-options','outbox-publish-options']) {
  const field=frame.locator('#'+id);
  await expect(field).toHaveAttribute('spellcheck','false');
  await expect(field).toHaveAttribute('autocorrect','off');
  await expect(field).toHaveAttribute('autocapitalize','off');
  await expect(field).toHaveAttribute('autocomplete','off');
  await expect(field).toHaveAttribute('inputmode','url');
 }
 const options={toOutbox:false,toInboxes:['b'.repeat(64),'b'.repeat(64)],relays:['wss://nos.lol/','wss://relay.damus.io/']};
 const text=JSON.stringify(options), field=frame.locator('#outbox-publish-options');
 await frame.locator('#draft').fill('typed routing options');
 await field.fill('');await field.pressSequentially(text);await field.press('Tab');
 await expect(field).toHaveValue(text);await frame.locator('#outbox-publish').click();
 expect(await frame.locator('body').evaluate(()=>(window as any).proof.calls)).toEqual([
  {event:{kind:1,content:'typed routing options',tags:[],created_at:expect.any(Number)},options},
 ]);
 await expect(frame.locator('#draft')).not.toHaveAttribute('inputmode','url');
});
test('draft publication uses the original SDK once with exact options and preserves an editable draft',async({page})=> {
 const frame=await publicationMount(page);await frame.locator('#draft').fill('exact reviewed draft');await frame.locator('#outbox-publish-options').fill('{"toOutbox":false,"relays":["wss://nos.lol"]}');await frame.locator('#outbox-publish').click();
 await expect(frame.locator('#outbox-publish')).toBeDisabled();await expect(frame.locator('#outbox-publish-status')).toHaveText('Waiting for shell review…');
 expect(await frame.locator('body').evaluate(()=>(window as any).proof.calls)).toEqual([{event:{kind:1,content:'exact reviewed draft',tags:[],created_at:expect.any(Number)},options:{toOutbox:false,relays:['wss://nos.lol']}}]);
 await frame.locator('body').evaluate(()=>(window as any).proof.resolve({ok:true,eventId:'a'.repeat(64),relays:{'wss://nos.lol/':true},event:{id:'a'.repeat(64),pubkey:'b'.repeat(64),sig:'c'.repeat(128),kind:1,content:'exact reviewed draft',tags:[],created_at:1}}));
 await expect(frame.locator('#outbox-publish-status')).toContainText('Primary event accepted.');await expect(frame.locator('#outbox-publish')).toBeEnabled();await expect(frame.locator('#draft')).toHaveValue('exact reviewed draft');
 expect(await frame.locator('body').evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 await frame.locator('#outbox-publish').click();await expect(frame.locator('#outbox-publish-status')).toHaveText('Waiting for shell review…');
});
test('empty draft and malformed options make no publication request; identity change prevents old completion repaint',async({page})=> {
 const frame=await publicationMount(page);await frame.locator('#outbox-publish').click();await expect(frame.locator('#outbox-publish-status')).toContainText('Write a draft');
 await frame.locator('#draft').fill('private draft');await frame.locator('#outbox-publish-options').fill('invalid');await frame.locator('#outbox-publish').click();
 expect(await frame.locator('body').evaluate(()=>(window as any).proof.calls)).toEqual([]);
 await frame.locator('#outbox-publish-options').fill('{}');await frame.locator('#outbox-publish').click();await frame.locator('body').evaluate(()=>{const proof=(window as any).proof;proof.change();proof.resolve({ok:true,eventId:'old'});});
 await expect(frame.locator('#outbox-publish-result')).toHaveText('');await expect(frame.locator('#outbox-publish-status')).toHaveText('No publication requested.');
});
