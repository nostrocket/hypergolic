import { test, expect } from '@playwright/test';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZV8AAAAASUVORK5CYII=';
// Native-port double: genuine packaged SDK, Kehto, private adapter and DOM, without native DNS/TLS proof.
async function open(page: import('@playwright/test').Page, mode = 'image') {
  let payload = png;
  if (mode === 'audio') {
    const buffer = new ArrayBuffer(48044), view = new DataView(buffer), bytes = new Uint8Array(buffer);
    const tag = (offset:number,value:string) => {for(let i=0;i<value.length;i++) bytes[offset+i]=value.charCodeAt(i);};
    tag(0,'RIFF');view.setUint32(4,48036,true);tag(8,'WAVE');tag(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,8000,true);view.setUint32(28,16000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);tag(36,'data');view.setUint32(40,48000,true);
    payload = Buffer.from(bytes).toString('base64');
  }
  await page.addInitScript(({png,mode})=>{
    if (window !== window.top) return;
    const listeners = new Set<(event:{data:string})=>void>();
    const calls: any[] = []; (window as any).resourceCalls = calls;
    const held: (() => void)[] = []; (window as any).releaseResourceResponses = () => { for (const release of held.splice(0)) release(); };
    const handle = '00000000-0000-4000-8000-000000000001';
    (window as any).HypergolicHost = {
      addEventListener: (_:string,listener:any)=>listeners.add(listener), removeEventListener:(_:string,listener:any)=>listeners.delete(listener),
      postMessage(raw:string) {
        const envelope=JSON.parse(raw);if(envelope.type !== 'capability') return;
        const request=JSON.parse(envelope.message);calls.push(request);
        let response:any;
        if(request.type === 'resource.cancel')response=null;
        else if(mode === 'denied')response={type:request.type+'.error',id:request.id,error:'blocked-by-policy'};
        else if(request.type === 'resource.__chunk')response={type:request.type+'.result',id:request.id,base64:mode === 'tamper'?'QQ==':png};
        else if(request.type === 'resource.bytes')response={type:request.type+'.result',id:request.id,transfer:{handle,length:atob(png).length,mime:mode === 'audio'?'audio/wav':'image/png'}};
        else if(request.type === 'resource.bytesMany')response={type:request.type+'.result',id:request.id,items:request.urls.map((url:string)=>({url,ok:true,transfer:{handle,length:atob(png).length,mime:'image/png'}}))};
        else if(request.type === 'resource.info')response={type:request.type+'.result',id:request.id,info:{schemes:[{scheme:'https',enabled:true},{scheme:'htree',enabled:false}],maxBytes:10485760,maxUrls:8}};
        const data=JSON.stringify({type:'capability.result',sessionId:envelope.sessionId,sequence:envelope.sequence,response:response===null?null:JSON.stringify(response)});
        const deliver = () => { for(const listener of listeners)listener({data}); };
        if(mode === 'hold' && request.type === 'resource.bytes') held.push(deliver); else deliver();
      },
    };
  },{png:payload,mode});
  await page.goto('/assets/runtime/index.html?sessionId=resource-browser&fixture=resource-lab');
  const frame=page.frameLocator('#napplet');await expect(frame.getByTestId('lab')).toHaveAttribute('data-ready','true');return frame;
}
test('genuine SDK receives Blob, renders PNG and sees only public canonical envelopes',async({page})=>{
  const frame=await open(page);await frame.locator('#load').click();await expect(frame.locator('#status')).toHaveText('Resource loaded.');
  await expect(frame.getByTestId('lab')).toHaveAttribute('data-rendered','1x1');
  await expect(frame.locator('#receipt')).toContainText('image/png');await expect(frame.locator('#preview img')).toHaveCount(1);
  const calls=await page.evaluate(()=>(window as any).resourceCalls);expect(calls.map((value:any)=>value.type)).toEqual(['resource.bytes','resource.__chunk']);
  const guest=page.frames().find(value=>value.parentFrame()===page.mainFrame())!;
  await guest.evaluate(()=>parent.postMessage({type:'resource.__chunk',id:'forged',handle:'00000000-0000-4000-8000-000000000001',offset:0},'*'));
  expect(await page.evaluate(()=>(window as any).resourceCalls.length)).toBe(2);
  await frame.locator('#clear').click();await expect(frame.locator('#preview img')).toHaveCount(0);
});
for(const mode of ['denied','tamper'])test(`resource ${mode} returns canonical SDK failure without a partial image`,async({page})=>{
  const frame=await open(page,mode);await frame.locator('#load').click();await expect(frame.locator('#status')).toContainText(mode==='denied'?'blocked-by-policy':'decode-failed');await expect(frame.locator('#preview img')).toHaveCount(0);
});
test('resource info reports selected scheme limits through actual SDK',async({page})=>{
  const frame=await open(page);await frame.locator('#info').click();await expect(frame.locator('#receipt')).toContainText('10485760');await expect(frame.locator('#receipt')).toContainText('htree');
});

test('SDK AbortSignal sends cancel without ACK and suppresses late bytes', async ({page}) => {
  const frame = await open(page, 'hold');
  await frame.locator('#load').click();
  await expect(frame.locator('#cancel')).toBeEnabled();
  await frame.locator('#cancel').click();
  await expect(frame.locator('#status')).toHaveText('Load cancelled.');
  await expect.poll(() => page.evaluate(() => (window as any).resourceCalls.map((call:any) => call.type))).toEqual(['resource.bytes', 'resource.cancel']);
  await page.evaluate(() => (window as any).releaseResourceResponses());
  await expect(frame.locator('#preview img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).resourceCalls.some((call:any) => call.type === 'resource.__chunk'))).toBe(false);
});
for (const mode of ['one', 'all']) test(`SDK ${mode} object URL revocation before readiness prevents late allocation`, async ({page}) => {
  await open(page, 'hold');
  const guest = page.frames().find(value => value.parentFrame() === page.mainFrame())!;
  await guest.evaluate((mode) => {
    const resource = (window as any).napplet.resource;
    const handle = resource.bytesAsObjectURL('data:,sample');
    (window as any).pendingURL = handle;
    if (mode === 'one') handle.revoke(); else resource.revokeAllObjectURLs();
  }, mode);
  await page.evaluate(() => (window as any).releaseResourceResponses());
  expect(await guest.evaluate(async () => {
    const handle = (window as any).pendingURL;
    await handle.ready;
    return {url: handle.url, readyIsPromise: handle.ready instanceof Promise, enumerable: Object.keys(handle).includes('ready')};
  })).toEqual({url: '', readyIsPromise: true, enumerable: false});
});

test('trusted media gate pauses, retains position, rejects hidden play and requires manual Play on return', async ({page}) => {
  const frame = await open(page,'audio');
  await frame.locator('#load').click();await expect(frame.locator('#status')).toHaveText('Resource loaded.');
  await frame.locator('#play-resource').click();
  await expect.poll(() => frame.locator('audio').evaluate((media:HTMLAudioElement)=>media.currentTime)).toBeGreaterThan(0.5);
  await page.evaluate(() => (window as any).__hypergolicMediaActive(false));
  await expect.poll(() => frame.locator('audio').evaluate((media:HTMLAudioElement)=>media.paused)).toBe(true);
  let previous = -1, stable = 0;
  await expect.poll(async () => {
    const position = await frame.locator('audio').evaluate((media:HTMLAudioElement)=>media.currentTime);
    stable = Math.abs(position - previous) < 0.005 ? stable + 1 : 0;previous = position;return stable;
  }).toBeGreaterThanOrEqual(3);
  const pausedAt = previous;expect(pausedAt).toBeGreaterThan(0.1);
  expect(await frame.locator('audio').evaluate(async (media:HTMLAudioElement)=>{try{await media.play();return 'played';}catch(error){return (error as DOMException).name;}})).toBe('NotAllowedError');
  // A guest-origin forged message cannot lift the private parent gate.
  await frame.locator('audio').evaluate(()=>window.postMessage({type:'hypergolic.private.media-active',active:true},'*'));
  expect(await frame.locator('audio').evaluate(async (media:HTMLAudioElement)=>{try{await media.play();return 'played';}catch(error){return (error as DOMException).name;}})).toBe('NotAllowedError');
  await page.evaluate(() => (window as any).__hypergolicMediaActive(true));
  await expect(frame.locator('audio')).toHaveJSProperty('paused',true);
  expect(await frame.locator('audio').evaluate(async (media:HTMLAudioElement)=>{try{await media.play();return 'played';}catch(error){return (error as DOMException).name;}})).toBe('NotAllowedError');
  expect(await frame.locator('audio').evaluate((media:HTMLAudioElement)=>media.currentTime)).toBeCloseTo(pausedAt,2);
  await frame.locator('#play-resource').click();
  await expect.poll(() => frame.locator('audio').evaluate((media:HTMLAudioElement)=>media.currentTime)).toBeGreaterThan(pausedAt + 0.1);
});


test('canonical single and bulk success envelopes carry MIME matching the reconstructed Blob', async ({page}) => {
  await open(page);
  const guest = page.frames().find(value => value.parentFrame() === page.mainFrame())!;
  const received = await guest.evaluate(async () => {
    const messages: {type:string,mime:unknown,blobType:unknown}[] = [];
    const capture = (event:MessageEvent) => {
      const value = event.data;
      if (value?.type === 'resource.bytes.result') messages.push({type:value.type,mime:value.mime,blobType:value.blob?.type});
      if (value?.type === 'resource.bytesMany.result') for (const item of value.items) messages.push({type:value.type,mime:item.mime,blobType:item.blob?.type});
    };
    window.addEventListener('message',capture);
    try {
      const resource = (window as any).napplet.resource;
      await resource.bytes('https://example.com/one.png');
      await resource.bytesMany(['https://example.com/two.png','https://example.com/three.png']);
      return messages;
    } finally { window.removeEventListener('message',capture); }
  });
  expect(received).toEqual([
    {type:'resource.bytes.result',mime:'image/png',blobType:'image/png'},
    {type:'resource.bytesMany.result',mime:'image/png',blobType:'image/png'},
    {type:'resource.bytesMany.result',mime:'image/png',blobType:'image/png'},
  ]);
});
