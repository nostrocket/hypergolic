import { createHash } from 'node:crypto';
import { expect, test, type Page, type Frame } from '@playwright/test';

const generation = '4ba3bdc3-8130-4a46-b5b9-3d4087a214a6';
const media = 'media-90c4a736-d407-472b-bf89-8b6de2abdd0d';
async function open(page: Page, grant = true, mixed = false, liveProfile = false) {
  const html = '<!doctype html><html><head><title>Media proof</title></head><body><p>Media proof</p></body></html>';
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const hash = digest(html);
  await page.addInitScript(({generation, media, html, hash, version, grant, mixed, liveProfile}) => {
    if (window !== window.top) return;
    const listeners = new Set<(event:{data:string})=>void>();
    const send = (value:object) => { for (const listener of listeners) listener({data:JSON.stringify(value)}); };
    const push = (message:object, sessionId = generation) => send({type:'media.event',sessionId,message});
    const requests: object[] = [];
    let lastSequence = 0;
    const effects = {transfers:0};
    const domains = mixed ? ['intent','keys','media','outbox'] : grant ? ['media','storage'] : ['storage'];
    const acceptedWire: string[] = [];
    Object.defineProperty(window, '__mediaProof', {value:{requests,push,acceptedWire,effects,nativePlay:()=>{if(liveProfile){effects.transfers++;push({type:'media.state',sessionId:media,status:'buffering'});}}}});
    Object.defineProperty(window, 'HypergolicHost', {value:{
      addEventListener: (_name:string, listener:(event:{data:string})=>void) => listeners.add(listener),
      removeEventListener: (_name:string, listener:(event:{data:string})=>void) => listeners.delete(listener),
      postMessage(raw:string) {
        const row = JSON.parse(raw);
        if (row.type === 'artifact.read') send({type:'artifact.chunk',sessionId:generation,sequence:0,
          base64:btoa(html),byteLength:html.length,totalBytes:html.length,publisher:'1'.repeat(64),
          appId:'media-test',eventId:'2'.repeat(64),htmlHash:hash,version,domains,done:true});
        if (row.type !== 'media' && row.type !== 'capability') return;
        if (row.sequence !== lastSequence + 1 || row.type === 'media' && raw.length > 32 * 1024) return;
        lastSequence = row.sequence;
        if (row.type === 'capability') {
          const message = JSON.parse(row.message);
          acceptedWire.push(message.type);
          let response;
          if (message.type === 'storage.get') response = {type:'storage.get.result',id:message.id,value:'ordinary path remains live'};
          if (message.type === 'outbox.query') response = {type:'outbox.query.result',id:message.id,events:[]};
          if (message.type === 'routing.call') {
            const route = message.message;
            response = {type:'routing.call.result',id:message.id,response:route.type === 'intent.invoke'
              ? {type:'intent.invoke.result',id:route.id,result:{ok:true,handled:true,
                archetype:route.request.archetype,action:route.request.action}} : null};
          }
          if (response) send({type:'capability.result',sessionId:generation,sequence:row.sequence,response:JSON.stringify(response)});
          return;
        }
        requests.push(row.message);
        acceptedWire.push(row.message.type);
        if (row.message.type === 'media.session.create') {
          if (row.message.live === true && !liveProfile) {
            push({type:'media.session.create.result',id:row.message.id,error:'Live radio needs renewed Media access.'});return;
          }
          push({type:'media.session.create.result',id:row.message.id,sessionId:media,owner:'shell'});
          push({type:'media.state',sessionId:media,status:'paused',volume:1});
          push({type:'media.capabilities',sessionId:media,actions:['stop','volume']});
        }
      },
    }});
  }, {generation,media,html,hash,version:digest(`${hash} /index.html\n`),grant,mixed,liveProfile});
  await page.goto(`/assets/runtime/index.html?sessionId=${generation}&source=published`);
  await expect(page.frameLocator('#napplet').getByText('Media proof')).toBeVisible();
  const guest = await (await page.locator('#napplet').elementHandle())?.contentFrame();
  if (!guest) throw new Error('Missing proof frame');
  await guest.evaluate(() => (window as any).napplet.shell.ready());
  return guest;
}

test('finite Media projects the signed Videos call shape and preserves late state and retirement', async ({page}) => {
  const guest = await open(page);
  const result = await guest.evaluate(() => (window as any).napplet.media.createSession({
    owner:'shell',source:{url:'https://video.example.org/clip.mp4',mimeType:'video/mp4'},
    metadata:{mediaType:'video',artwork:{url:'https://other.example.org/art.png'}}, autoplay:true, live:false,
    queue:[{url:'https://other.example.org/another.mp4'}],queueIndex:0,aspectRatio:16/9,loop:true,
  }));
  expect(result).toEqual({sessionId:media,owner:'shell'});
  const projected = await page.evaluate(() => (window as any).__mediaProof.requests);
  expect(projected).toEqual([{type:'media.session.create',id:expect.any(String),url:'https://video.example.org/clip.mp4'}]);
  const snapshots = await guest.evaluate(async media => {
    const api = (window as any).napplet.media;
    const state = await new Promise(resolve => api.onState(media,resolve));
    const actions = await new Promise(resolve => api.onCapabilities(media,resolve));
    (window as any).mediaEvents = [];
    api.onState(media,(value:unknown) => (window as any).mediaEvents.push(value));
    return {state,actions,available:(window as any).napplet.shell.supports('media')};
  }, media);
  expect(snapshots).toEqual({state:{status:'paused',volume:1},actions:['stop','volume'],available:true});
  await page.evaluate(({media}) => {
    const {push} = (window as any).__mediaProof;
    push({type:'media.state',sessionId:media,status:'playing'},'other-generation');
    push({type:'media.session.ended',sessionId:media,reason:'preempted'});
    push({type:'media.state',sessionId:media,status:'playing'});
  }, {media});
  expect(await guest.evaluate(media => new Promise(resolve => (window as any).napplet.media.onEnded(media,resolve)), media))
    .toEqual({sessionId:media,reason:'preempted'});
  expect(await guest.evaluate(() => (window as any).mediaEvents)).toEqual([{status:'paused',volume:1}]);
});

test('Media grant and exact-frame checks reject raw synthetic requests and unsupported profiles', async ({page}) => {
  const guest = await open(page);
  await page.evaluate(() => {
    const source = (document.querySelector('#napplet') as HTMLIFrameElement).contentWindow;
    window.dispatchEvent(new MessageEvent('message',{source,data:{type:'media.session.create',id:'fake',owner:'shell',source:{url:'https://public.example.org/fake.mp4'}}}));
  });
  const errors = await guest.evaluate(async () => {
    const api = (window as any).napplet.media;
    return Promise.all([
      api.createSession({owner:'napplet'}),
      api.createSession({owner:'shell',live:true,source:{url:'https://public.example.org/live'}}),
      api.createSession({owner:'shell',source:{url:'https://public.example.org/hls',mimeType:'application/vnd.apple.mpegurl'}}),
    ]);
  });
  expect(errors).toEqual([{error:'Unsupported media request.'},{error:'Live radio needs renewed Media access.'},{error:'Unsupported media request.'}]);
  expect(await page.evaluate(() => (window as any).__mediaProof.requests)).toEqual([{type:'media.session.create',id:expect.any(String),url:'https://public.example.org/live',live:true}]);
  expect(await page.evaluate(() => (window as any).__mediaProof.effects.transfers)).toBe(0);
});

test('a verified frame without Media cannot use a raw request to reach native', async ({page}) => {
  const guest = await open(page, false);
  expect(await guest.evaluate(() => {
    const api = (window as any).napplet;
    window.parent.postMessage({type:'media.session.create',id:'ungranted',owner:'shell',source:{url:'https://public.example.org/clip.mp4'}},'*');
    return [typeof api.media,api.shell.supports('media')];
  })).toEqual(['undefined',false]);
  expect(await page.evaluate(() => (window as any).__mediaProof.requests)).toEqual([]);
});


test('an escape-amplified Media URL cannot desynchronize ordinary native requests', async ({page}) => {
  const guest = await open(page);
  const results = await guest.evaluate(async () => {
    const api = (window as any).napplet;
    const invalid = await api.media.createSession({owner:'shell',source:{url:'\0'.repeat(8192)}});
    return {invalid,stored:await api.storage.getItem('key')};
  });
  expect(results).toEqual({invalid:{error:'Unsupported media request.'},stored:'ordinary path remains live'});
  expect(await page.evaluate(() => (window as any).__mediaProof.requests)).toEqual([]);
});

test('one verified mixed grant keeps Media, Outbox, Keys and Intent live without raw Relay', async ({page}) => {
  const guest = await open(page, true, true);
  const observed = await guest.evaluate(async () => {
    const api = (window as any).napplet;
    const invalid = await api.media.createSession({owner:'shell',source:{url:'\0'.repeat(8192)}});
    const video = await api.media.createSession({owner:'shell',source:{url:'https://video.example.org/clip.mp4'}});
    const outbox = await api.outbox.query({kinds:[1],limit:0});
    const intent = await api.intent.invoke('napplet:note/open');
    const key = await api.keys.registerAction({id:'clip.skip',label:'Skip',defaultKey:'s'});
    const surface = document.createElement('canvas');
    surface.dataset.testid = 'key-target';
    surface.tabIndex = 0;
    document.body.append(surface);
    (window as any).actions = 0;
    window.addEventListener('message', event => {
      if (event.isTrusted && event.source === parent && event.data?.type === 'hypergolic.private.media-active') {
        (window as any).keysActive = event.data.inputActive;
      }
    });
    api.keys.onAction('clip.skip', () => (window as any).actions++);
    return {invalid, video, outbox, intent, key, relay:typeof api.relay};
  });
  expect(observed).toMatchObject({invalid:{error:'Unsupported media request.'},video:{sessionId:media,owner:'shell'},
    outbox:{events:[]},intent:{ok:true},key:{binding:'S'},relay:'undefined'});
  const wire = await page.evaluate(() => (window as any).__mediaProof.acceptedWire as string[]);
  expect(wire.filter(type => type === 'media.session.create')).toHaveLength(1);
  expect(wire).toContain('outbox.query');
  expect(wire).toContain('routing.call');
  expect(wire.some(type => type.startsWith('relay.'))).toBe(false);
  await guest.getByTestId('key-target').focus();
  await page.evaluate(() => (window as any).__hypergolicMediaActive(true));
  await expect.poll(() => guest.evaluate(() => (window as any).keysActive)).toBe(true);
  await page.keyboard.press('s');
  expect(await guest.evaluate(() => (window as any).actions)).toBe(1);
  await page.evaluate(() => (window as any).__hypergolicMediaActive(false));
  await expect.poll(() => guest.evaluate(() => (window as any).keysActive)).toBe(false);
  await page.keyboard.press('s');
  expect(await guest.evaluate(() => (window as any).actions)).toBe(1);
});


test('live Media projects the signed Funclet shape and publisher play cannot substitute native source Play',async({page})=>{
  const guest=await open(page,true,false,true);
  const created=await guest.evaluate(()=> (window as any).napplet.media.createSession({owner:'shell',source:{url:'https://radio.example.org/stream'},metadata:{title:'Synthetic station',mediaType:'audio'},live:true,autoplay:false}));
  expect(created).toEqual({sessionId:media,owner:'shell'});
  expect(await page.evaluate(()=>(window as any).__mediaProof.requests)).toEqual([{type:'media.session.create',id:expect.any(String),url:'https://radio.example.org/stream',live:true}]);
  await guest.evaluate(media=>(window as any).napplet.media.sendCommand(media,'play'),media);
  expect(await page.evaluate(()=>(window as any).__mediaProof.effects.transfers)).toBe(0);
  await page.evaluate(()=>(window as any).__mediaProof.nativePlay());
  expect(await page.evaluate(()=>(window as any).__mediaProof.effects.transfers)).toBe(1);
});


async function prepareReviewMedia(guest: Frame) {
  await guest.evaluate(async media => {
    const api = (window as any).napplet;
    await api.media.createSession({owner:'shell',source:{url:'https://radio.example.org/stream'},live:true});
    const canvas = document.createElement('canvas');canvas.tabIndex=0;canvas.dataset.testid='review-canvas';
    const field = document.createElement('input');field.dataset.testid='review-editor';
    const button = document.createElement('button');button.textContent='Guest action';
    document.body.append(canvas,field,button);
    (window as any).reviewProof={actions:0,clicks:0,metadataRequests:0,status:'paused',rawKeys:0,rawPointer:0};
    button.onclick=()=>{(window as any).reviewProof.clicks++;};
    window.addEventListener('keydown',()=>{(window as any).reviewProof.rawKeys++;});
    window.addEventListener('message',event=>{
      if(event.isTrusted&&event.source===parent&&event.data?.type==='hypergolic.private.media-active')
        (window as any).inputBlockedSeen=event.data.inputBlocked;
    });
    for(const name of ['pointermove','mousemove'])window.addEventListener(name,()=>{(window as any).reviewProof.rawPointer++;});
    await api.keys.registerAction({id:'review.skip',label:'Skip',defaultKey:'s'});
    api.keys.onAction('review.skip',()=>{(window as any).reviewProof.actions++;});
    api.media.onState(media,(row:{status:string})=>{
      const proof=(window as any).reviewProof;
      if(row.status==='playing'&&proof.status!=='playing')proof.metadataRequests++;
      proof.status=row.status;
    });
  },media);
}

test('trusted review input occlusion preserves live media but blocks pointer, editor and Keys input', async ({page}) => {
  const guest = await open(page, true, true, true);
  await prepareReviewMedia(guest);
  await page.evaluate(({media})=>{
    (window as any).__hypergolicMediaActive(true);
    (window as any).__mediaProof.nativePlay();
    (window as any).__mediaProof.push({type:'media.state',sessionId:media,status:'playing'});
  },{media});
  await guest.getByTestId('review-canvas').focus();await page.keyboard.press('s');
  await expect.poll(()=>guest.evaluate(()=>(window as any).reviewProof.actions)).toBe(1);
  await guest.getByTestId('review-canvas').hover();
  const keysBefore=await guest.evaluate(()=>(window as any).reviewProof.rawKeys);
  const pointerBefore=await guest.evaluate(()=>(window as any).reviewProof.rawPointer);
  expect(pointerBefore).toBeGreaterThan(0);
  const box=await guest.getByTestId('review-canvas').boundingBox();expect(box).not.toBeNull();
  await guest.evaluate(()=>{
    const proof=(window as any).reviewProof;
    proof.restore={prevent:Event.prototype.preventDefault,stop:Event.prototype.stopImmediatePropagation,blur:HTMLElement.prototype.blur,
      source:Object.getOwnPropertyDescriptor(MessageEvent.prototype,'source'),data:Object.getOwnPropertyDescriptor(MessageEvent.prototype,'data'),
      cancelable:Object.getOwnPropertyDescriptor(Event.prototype,'cancelable')};
    Object.defineProperty(Event.prototype,'cancelable',{configurable:true,get:()=>false});
    Event.prototype.preventDefault=()=>{};Event.prototype.stopImmediatePropagation=()=>{};HTMLElement.prototype.blur=()=>{};
  });
  await page.evaluate(()=>(window as any).__hypergolicInputActive(false));
  await expect(page.locator('#napplet')).toHaveJSProperty('inert',true);
  await guest.evaluate(async()=>{
    Object.defineProperty(MessageEvent.prototype,'source',{configurable:true,get:()=>parent});
    window.postMessage({type:'hypergolic.private.media-active',active:true,inputActive:true,inputBlocked:false},'*');
    window.dispatchEvent(new MessageEvent('message',{source:parent,data:{type:'hypergolic.private.media-active',active:true,inputActive:true,inputBlocked:false}}));
    await new Promise(resolve=>setTimeout(resolve,20));
  });
  await guest.getByTestId('review-editor').evaluate((input:HTMLInputElement)=>input.focus());
  await page.keyboard.type('s');await page.keyboard.insertText('日本');
  expect(await guest.getByTestId('review-editor').inputValue()).toBe('');
  await guest.evaluate(()=>{
    Object.defineProperty(MessageEvent.prototype,'source',(window as any).reviewProof.restore.source);
    Object.defineProperty(MessageEvent.prototype,'data',{configurable:true,get:()=>({type:'hypergolic.private.media-active',active:true,inputActive:true,inputBlocked:false})});
  });
  await page.evaluate(()=>(window as any).__hypergolicInputActive(false));
  await guest.getByTestId('review-editor').evaluate((input:HTMLInputElement)=>input.focus());
  await page.keyboard.type('b');
  expect(await guest.getByTestId('review-editor').inputValue()).toBe('');
  await guest.getByTestId('review-canvas').evaluate((canvas:HTMLCanvasElement)=>canvas.focus());
  await page.keyboard.press('s');
  await page.mouse.move(box!.x+5,box!.y+5);await page.mouse.move(box!.x+25,box!.y+10);
  await expect(guest.getByRole('button',{name:'Guest action'}).click({trial:true,timeout:400})).rejects.toThrow();
  expect(await guest.evaluate(()=>{const {restore,...proof}=(window as any).reviewProof;return proof;})).toEqual({actions:1,clicks:0,metadataRequests:1,status:'playing',rawKeys:keysBefore,rawPointer:pointerBefore});
  const requests=await page.evaluate(()=>(window as any).__mediaProof.requests);
  expect(requests.some((row:{type:string})=>row.type==='media.session.destroy'||row.type==='media.command')).toBe(false);
  await guest.evaluate(()=>{
    const restore=(window as any).reviewProof.restore;
    Event.prototype.preventDefault=restore.prevent;Event.prototype.stopImmediatePropagation=restore.stop;HTMLElement.prototype.blur=restore.blur;
    Object.defineProperty(Event.prototype,'cancelable',restore.cancelable);
    Object.defineProperty(MessageEvent.prototype,'source',restore.source);Object.defineProperty(MessageEvent.prototype,'data',restore.data);
  });
  // Cancel removes input occlusion only; no paused -> playing edge or second metadata request.
  await page.evaluate(()=>(window as any).__hypergolicInputActive(true));
  await expect(page.locator('#napplet')).toHaveJSProperty('inert',false);
  await guest.getByTestId('review-canvas').focus();await page.keyboard.press('s');
  await expect.poll(()=>guest.evaluate(()=>(window as any).reviewProof.actions)).toBe(2);
  expect(await guest.evaluate(()=>(window as any).reviewProof.metadataRequests)).toBe(1);
  await guest.getByRole('button',{name:'Guest action'}).click();
  expect(await guest.evaluate(()=>(window as any).reviewProof.clicks)).toBe(1);
  // An actual native source/background deactivation still wins over later input updates.
  await page.evaluate(()=>{(window as any).__hypergolicMediaActive(false);(window as any).__hypergolicInputActive(true);});
  await expect(page.locator('#napplet')).toHaveJSProperty('inert',true);
  await expect.poll(()=>guest.evaluate(()=>(window as any).inputBlockedSeen)).toBe(true);
  await page.keyboard.press('s');
  expect(await guest.evaluate(()=>(window as any).reviewProof.actions)).toBe(2);
});
