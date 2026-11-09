import {test,expect,type Page,type FrameLocator} from '@playwright/test';
import {build} from 'vite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {finalizeEvent} from 'nostr-tools/pure';
import {preparePresentationFixtures} from '../tools/prepare-presentation-fixtures.mjs';

const pin=JSON.parse(readFileSync('fixtures/reviewed-presentation-manifest.json','utf8')).find((item:{appId:string})=>item.appId==='mapplets');
const generation='12345678-1234-4234-8234-123456789abc';
const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const assets:Record<string,{base64:string;mime:string}>={};
function asset(bytes:Buffer,mime:string):string {
  const hash=sha(bytes);assets[hash]={base64:bytes.toString('base64'),mime};return hash;
}
const json=(value:unknown)=>asset(Buffer.from(JSON.stringify(value)),'application/json');
const sprite=asset(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=','base64'),'image/png');
const style=json({version:8,sources:{neutral:{type:'geojson',data:{type:'FeatureCollection',features:[
  {type:'Feature',geometry:{type:'Point',coordinates:[0,0]},properties:{}}]}}},layers:[
  {id:'background',type:'background',paint:{'background-color':'#222b37'}},
  {id:'anchor',type:'circle',source:'neutral',paint:{'circle-radius':12,'circle-color':'#c29d49'}}]});
const sprites=json({});
const manifest=json({format:'mappy-tile-manifest-v1',bounds:[-0.1,-0.1,0.1,0.1],minzoom:3,maxzoom:18,tiles:{},assets:{
  'style-openmaptiles.json':style,'sprites/ofm.json':sprites,'sprites/ofm.png':sprite,
  'sprites/ofm@2x.json':sprites,'sprites/ofm@2x.png':sprite}});
const key=new Uint8Array(32);key[31]=19;
const release=finalizeEvent({kind:30078,created_at:1700000000,content:'',tags:[['d','mappy-map-madeira-poc'],['manifest',manifest]]},key);
let host='',document='';

test.beforeAll(async()=>{
  await preparePresentationFixtures();
  const result:any=await build({configFile:false,logLevel:'silent',define:{__BUNDLED_FIXTURES__:'{}',__UX_HTML__:'""',__UX_SHA256__:'""',__UX_AGGREGATE__:'""'},
    build:{write:false,minify:true,target:'es2022',modulePreload:false,lib:{entry:'src/main.ts',formats:['iife'],name:'HypergolicRuntime'}}});
  host=(Array.isArray(result)?result[0]:result).output.find((item:any)=>item.type==='chunk').code;
  document=/const document = `([\s\S]+?)`;/.exec(readFileSync('tools/build.mjs','utf8'))![1]!;
});

async function openMap(page:Page, revised=false) {
  const original=readFileSync('.test-fixtures/presentation/mapplets.html');
  expect(sha(original)).toBe(pin.sha256);expect(original.length).toBe(pin.bytes);
  const bytes=revised?Buffer.concat([original,Buffer.from('\n<!-- hypothetical update -->')]):original;
  const htmlHash=sha(bytes),version=sha(htmlHash+' /index.html\n');
  await page.route('**/*',route=>route.abort());
  await page.route('**/assets/runtime/index.html?*',route=>route.fulfill({contentType:'text/html',body:document}));
  await page.route('**/assets/runtime/host.js',route=>route.fulfill({contentType:'text/javascript',body:host}));
  await page.addInitScript(({html,pin,generation,assets,release,htmlHash,version})=>{
    if(window!==window.top)return;
    const bytes=Uint8Array.from(atob(html),c=>c.charCodeAt(0));
    const listeners=new Set<(event:{data:string})=>void>(), transfers=new Map<string,{base64:string;mime:string}>();
    const state={requests:[] as string[]}; (window as any).__mapProbe=state;
    const emit=(message:unknown)=>{for(const listener of listeners)listener({data:JSON.stringify(message)});};
    Object.defineProperty(window,'HypergolicHost',{value:{
      addEventListener:(_:string,listener:any)=>listeners.add(listener),removeEventListener:(_:string,listener:any)=>listeners.delete(listener),
      postMessage(raw:string){
        const envelope=JSON.parse(raw);
        if(envelope.type==='artifact.read'){
          const start=envelope.sequence*49152,payload=bytes.slice(start,start+49152);
          emit({type:'artifact.chunk',sessionId:generation,sequence:envelope.sequence,publisher:'1'.repeat(64),
            appId:pin.appId,eventId:pin.eventId,version,htmlHash,
            domains:['inc','intent','outbox','resource','storage'],base64:btoa(String.fromCharCode(...payload)),
            byteLength:payload.length,totalBytes:bytes.length,done:start+49152>=bytes.length});return;
        }
        if(envelope.type!=='capability')return;
        const request=JSON.parse(envelope.message);
        const response:any={type:request.type+'.result',id:request.id};
        state.requests.push(request.type==='routing.call'?request.message.type:request.type);
        if(request.type==='storage.get')response.value=request.key==='trusted-author'?release.pubkey:null;
        else if(request.type==='outbox.query')response.events=request.filters.some((f:any)=>
          f.kinds?.includes(release.kind)&&f.authors?.includes(release.pubkey)&&f['#d']?.includes('mappy-map-madeira-poc'))?[{event:release}]:[];
        else if(request.type==='resource.bytes'){
          const item=assets[request.url.slice('blossom:sha256:'.length)];
          if(item){const handle=crypto.randomUUID();transfers.set(handle,item);response.transfer={handle,length:atob(item.base64).length,mime:item.mime};}
          else {response.type=request.type+'.error';response.error='not-found';}
        }else if(request.type==='resource.__chunk')response.base64=transfers.get(request.handle)?.base64;
        emit({type:'capability.result',sessionId:generation,sequence:envelope.sequence,response:JSON.stringify(response)});
      },
    }});
  },{html:bytes.toString('base64'),pin,generation,assets,release,htmlHash,version});
  await page.goto(`/assets/runtime/index.html?sessionId=${generation}&source=published`);
  const frame=page.frameLocator('#napplet');
  await expect(frame.locator('#loadingPanel')).toBeHidden();
  await expect(frame.getByRole('button',{name:'Select a rectangular map area'})).toBeVisible();
  await expect(frame.locator('#errorPanel')).toBeHidden();
  return frame;
}

test.use({hasTouch:true,viewport:{width:360,height:740},launchOptions:{args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']}});
test.skip(({browserName})=>browserName!=='chromium','Chromium CDP sends browser-dispatched touch input');


async function selection(frame:FrameLocator,page:Page) {
  const canvas=frame.locator('#map .maplibregl-canvas'), button=frame.getByRole('button',{name:'Select a rectangular map area'});
  const edit=frame.getByRole('button',{name:'Edit',exact:true}), overlay=frame.locator('.selection-rectangle');
  const box=(await canvas.boundingBox())!;
  const start={x:Math.round(box.x+box.width*0.3),y:Math.round(box.y+box.height*0.3),id:1};
  const end={x:start.x+60,y:start.y+70,id:1};
  const cdp=await page.context().newCDPSession(page);
  const touch=(type:'touchStart'|'touchMove'|'touchEnd'|'touchCancel',...touchPoints:(typeof start)[])=>
    cdp.send('Input.dispatchTouchEvent',{type,touchPoints});
  const arm=async()=>{await button.tap();await expect(canvas).toHaveClass(/is-selecting/);await expect(overlay).toBeHidden();};
  const drag=async()=>{await touch('touchStart',start);await touch('touchMove',end);await touch('touchEnd');};
  return {canvas,edit,overlay,box,start,end,touch,arm,drag};
}
async function expectNoIntent(page:Page) {
  const requests=await page.evaluate(()=>(window as any).__mapProbe.requests as string[]);
  expect(requests).toContain('resource.bytes');
  expect(requests).not.toContain('intent.invoke');
  expect(requests.some(type=>type.endsWith('.publish'))).toBe(false);
}

test('exact Mapplets selects a rectangle with trusted touch without sending an Intent',async({page},info)=>{
  const frame=await openMap(page), map=await selection(frame,page);
  await map.arm();
  await expect(map.canvas).toHaveCSS('touch-action','none');
  await map.canvas.evaluate(canvas=>canvas.dispatchEvent(new Event('touchstart',{bubbles:true,cancelable:true})));
  await expect(map.overlay).toBeHidden();
  await map.touch('touchStart',map.start);await map.touch('touchMove',map.end);
  await expect(map.overlay).toBeVisible();await expect(map.edit).toBeHidden();
  await map.touch('touchEnd');
  await expect(map.edit).toBeVisible();await expect(map.canvas).not.toHaveClass(/is-selecting/);
  await expectNoIntent(page);
  await info.attach('outcome.json',{contentType:'application/json',body:JSON.stringify({trustedTouch:'selected',intentCalls:0})});
});

test('exact Mapplets discards interrupted drags and permits a fresh selection',async({page})=>{
  const frame=await openMap(page), map=await selection(frame,page);
  const start=async()=>{
    await map.touch('touchStart',map.start);await map.touch('touchMove',map.end);
    await expect(map.overlay).toBeVisible();
  };
  const cancelled=async()=>{await expect(map.overlay).toBeHidden();await expect(map.edit).toBeHidden();};
  await map.arm();
  await start();await map.touch('touchCancel');await cancelled();
  await start();await map.touch('touchStart',map.end,{x:map.end.x+30,y:map.end.y+30,id:2});
  await map.touch('touchEnd');await cancelled();
  await map.canvas.focus();await start();
  await page.evaluate(()=>{
    const control=document.createElement('button');document.body.append(control);control.focus();
  });
  await cancelled();await map.touch('touchEnd');
  await map.canvas.focus();await start();
  // Changing the map origin during a drag must not turn cancellation into a large selection.
  const node=frame.locator('#map');await node.evaluate(element=>{(element as HTMLElement).style.transform='translate(20px,20px)';});
  await page.evaluate(()=>(window as any).__hypergolicInputActive(false));
  await cancelled();await map.touch('touchEnd');
  await node.evaluate(element=>{(element as HTMLElement).style.transform='';});
  await page.evaluate(()=>(window as any).__hypergolicInputActive(true));
  await map.drag();await expect(map.edit).toBeVisible();
  await expectNoIntent(page);
});

test('exact Mapplets keeps ordinary touch pan, pinch and armed mouse selection',async({page})=>{
  const frame=await openMap(page), map=await selection(frame,page);
  const initial=await map.canvas.screenshot();
  await map.drag();
  await expect.poll(async()=>initial.equals(await map.canvas.screenshot())).toBe(false);
  await expect(map.edit).toBeHidden();await expect(map.canvas).not.toHaveClass(/is-selecting/);
  const scale=frame.locator('.maplibregl-ctrl-scale'), before=await scale.textContent();
  const a={x:Math.round(map.box.x+map.box.width*0.4),y:map.end.y,id:1}, b={x:a.x+50,y:a.y,id:2};
  await map.touch('touchStart',a,b);
  await map.touch('touchMove',{...a,x:a.x-25},{...b,x:b.x+25});
  await map.touch('touchMove',{...a,x:a.x-50},{...b,x:b.x+50});
  await map.touch('touchEnd');
  await expect(scale).not.toHaveText(before!);
  await expect(map.edit).toBeHidden();
  await map.arm();
  await page.mouse.move(map.start.x,map.start.y);await page.mouse.down();await page.mouse.move(map.end.x,map.end.y,{steps:3});await page.mouse.up();
  await expect(map.edit).toBeVisible();await expectNoIntent(page);
});

test('an unreviewed Mapplets version retains the original input behavior',async({page})=>{
  const frame=await openMap(page,true),map=await selection(frame,page);
  await map.arm();await map.drag();
  await expect(map.edit).toBeHidden();await expect(map.canvas).toHaveClass(/is-selecting/);
  await expectNoIntent(page);
});
