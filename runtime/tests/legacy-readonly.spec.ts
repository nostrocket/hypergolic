import {test, expect, type Page} from '@playwright/test';
import {build} from 'vite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {finalizeEvent} from 'nostr-tools/pure';
import {naddrEncode} from 'nostr-tools/nip19';
import {prepareLegacyFixtures} from '../tools/prepare-legacy-fixtures.mjs';
let bundle = '';
test.beforeAll(async () => {
  await prepareLegacyFixtures();
  const result: any = await build({configFile: false, logLevel: 'silent', build: {write: false, minify: false,
    lib: {entry: 'tests/fixtures/legacy-readonly.ts', formats: ['iife'], name: 'LegacyProof'}}});
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item: any) => item.type === 'chunk').code;
});
async function setup(page: Page, html: string, recipe = false, event: any = null) {
  await page.route('**/__legacy-proof', route => route.fulfill({contentType: 'text/html', body: '<!doctype html><html><head></head><body></body></html>'}));
  await page.goto('/__legacy-proof');
  await page.addScriptTag({content: bundle});
  await page.evaluate(({html, recipe, event}) => {const state = (window as any).__legacy; state.auto = event; state.mount(html, recipe);}, {html, recipe, event});
  return page.locator('#legacy').contentFrame();
}
const demo = '<!doctype html><html><head></head><body><script>window.messages=[];window.errors=[];window.ws=new WebSocket("wss://relay.damus.io");ws.onmessage=e=>messages.push(JSON.parse(e.data));ws.onopen=()=>{window.opened=true};</script></body></html>';
const key = new Uint8Array(32); key[31] = 9;
const article = finalizeEvent({kind: 30023, created_at: 1700000000, content: 'A real verified public article.', tags: [['d', 'bounded-read'], ['title', 'Controlled public article'], ['t', 'recipe'], ['ingredient', '1', 'cup', 'Rice'], ['step', '1', 'Cook rice']]}, key);
for (const [name, hash, recipe] of [['recipe-cards', '9067048a9ce80d7e79ea76b960acc88aa53645754ec4e7549de1c1525a690194', true], ['longform', 'd5558df7e1f3823c0ad5c64273d57802fe304c1e2266bab8e5151fbf05ad51f4', false]] as const) {
  test(`exact unchanged ${name} guest reads signed public content with local dependencies`, async ({page}) => {
    const html = readFileSync(`.test-fixtures/legacy/${name}.html`); expect(createHash('sha256').update(html).digest('hex')).toBe(hash);
    const remotes: string[] = []; page.on('request', request => {if (!request.url().startsWith('http://127.0.0.1:4187/') && !request.url().startsWith('blob:') && !request.url().startsWith('data:')) remotes.push(request.url());});
    const frame = await setup(page, html.toString(), recipe, article);
    if (!recipe) await frame.locator('body').evaluate((_, route) => {location.hash = '#/post/' + route;}, naddrEncode({kind: 30023, pubkey: article.pubkey, identifier: 'bounded-read'}));
    await expect(frame.getByText('Controlled public article', {exact: true}).first()).toBeVisible({timeout: 12000});
    expect(await frame.locator('body').evaluate(() => typeof (window as any).nostr)).toBe('undefined');
    expect(remotes).toEqual([]);
    expect(await page.evaluate(() => (window as any).__legacy.requests.every((r: any) => r.type === 'relay.subscribe' && r.filters.every((f: any) => f.limit <= 32)))).toBe(true);
  });
}
test('guest and forged raw writes never dispatch; caller IDs are rewritten and stale replies rejected', async ({page}) => {
  const frame = await setup(page, demo); await expect.poll(() => frame.locator('body').evaluate(() => (window as any).opened)).toBe(true);
  await frame.locator('body').evaluate(() => {
    const state = window as any;
    for (const operation of ['EVENT', 'AUTH', 'signEvent', 'exportPrivateKey', 'upload']) {
      try {state.ws.send(JSON.stringify([operation, 'x', {}]));} catch (error) {state.errors.push(String(error));}
      parent.postMessage({type:'legacy.readonly',session:'12345678-1234-4234-8234-123456789abc',operation:'send',socket:'socket-1',data:JSON.stringify([operation,'x',{}])},'*');
    }
    state.ws.send(JSON.stringify(['REQ','caller',{kinds:[30023],limit:200}]));
  });
  await expect.poll(() => page.evaluate(() => (window as any).__legacy.requests.length)).toBe(1);
  expect(await frame.locator('body').evaluate(() => (window as any).errors.length)).toBe(5);
  expect(await page.evaluate(() => (window as any).__legacy.requests[0].subId)).not.toBe('caller');
  await frame.locator('body').evaluate(() => (window as any).ws.send(JSON.stringify(['REQ','caller',{kinds:[30023],limit:1}])));
  await expect.poll(() => page.evaluate(() => (window as any).__legacy.requests.length)).toBe(2);
  await page.evaluate(event => {const s = (window as any).__legacy; s.deliveries[0]({type:'relay.event',subId:s.requests[0].subId,result:{event}}); s.deliveries[1]({type:'relay.event',subId:s.requests[1].subId,result:{event}});}, article);
  await expect.poll(() => frame.locator('body').evaluate(() => (window as any).messages.filter((m: any) => m[0] === 'EVENT').length)).toBe(1);
  await page.evaluate(event => {const s=(window as any).__legacy; s.destroy(); s.deliveries[1]({type:'relay.event',subId:s.requests[1].subId,result:{event}});}, article);
  expect(await frame.locator('body').evaluate(() => (window as any).messages.filter((m: any) => m[0] === 'EVENT').length)).toBe(1);
});
test('sibling frames, synthetic events, wrong session and oversized author lists acquire no authority', async ({page}) => {
  const frame = await setup(page, demo); await expect.poll(() => frame.locator('body').evaluate(() => (window as any).opened)).toBe(true);
  await page.evaluate(() => {const s=(window as any).__legacy; const message={type:'legacy.readonly',session:s.session,operation:'send',socket:'socket-1',data:JSON.stringify(['REQ','hostile',{kinds:[1]}])}; s.receiver.receive(new MessageEvent('message',{source:document.querySelector('iframe')!.contentWindow,data:message})); const sibling=document.createElement('iframe'); sibling.srcdoc='<script>parent.postMessage('+JSON.stringify(message)+',"*")<\/script>'; document.body.append(sibling);});
  await frame.locator('body').evaluate(() => {parent.postMessage({type:'legacy.readonly',session:'wrong-session',operation:'send',socket:'socket-1',data:JSON.stringify(['REQ','wrong',{kinds:[1]}])},'*'); (window as any).ws.send(JSON.stringify(['REQ','oversize',{authors:Array(65).fill('a'.repeat(64))}]));});
  await expect.poll(() => page.evaluate(() => (window as any).__legacy.status.length)).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as any).__legacy.requests)).toEqual([]);
  await expect.poll(() => frame.locator('body').evaluate(() => (window as any).messages.some((m: any) => m[0] === 'CLOSED' && m[1] === 'oversize'))).toBe(true);
});

test('three native reads remain bounded, limits are disclosed and CLOSE releases a slot', async ({page}) => {
  const frame = await setup(page, demo); await expect.poll(() => frame.locator('body').evaluate(() => (window as any).opened)).toBe(true);
  await frame.locator('body').evaluate(() => {for (const id of ['a','b','c','d']) (window as any).ws.send(JSON.stringify(['REQ',id,{kinds:[30023],limit:200}]));});
  await expect.poll(() => page.evaluate(() => (window as any).__legacy.requests.length)).toBe(3);
  await expect.poll(() => frame.locator('body').evaluate(() => (window as any).messages.some((m:any) => m[0] === 'CLOSED' && m[1] === 'd'))).toBe(true);
  expect(await page.evaluate(() => (window as any).__legacy.status.some((m:string) => m.includes('Partial legacy history')))).toBe(true);
  await frame.locator('body').evaluate(() => {(window as any).ws.send(JSON.stringify(['CLOSE','a'])); (window as any).ws.send(JSON.stringify(['REQ','d',{kinds:[30023],limit:1}]));});
  await expect.poll(() => page.evaluate(() => (window as any).__legacy.requests.length)).toBe(4);
  expect(await page.evaluate(() => (window as any).__legacy.closes.length)).toBe(1);
});
test('an unconfigured peer closes explicitly before any native read admission', async ({page}) => {
  const html = '<!doctype html><html><head></head><body><script>window.opened=false;window.reason=null;const socket=new WebSocket("wss://relay.snort.social");socket.onopen=()=>{window.opened=true;socket.send(JSON.stringify(["REQ","read",{kinds:[30023],limit:1}]))};socket.onclose=event=>{window.reason=event.reason;window.closedState=socket.readyState};</script></body></html>';
  const frame = await setup(page, html);
  await expect.poll(() => frame.locator('body').evaluate(() => (window as any).reason)).toContain('not in Hypergolic’s Network relays');
  expect(await frame.locator('body').evaluate(() => ({opened: (window as any).opened, state: (window as any).closedState}))).toEqual({opened: false, state: 3});
  await frame.locator('body').evaluate(() => parent.postMessage({type:'legacy.readonly',session:'12345678-1234-4234-8234-123456789abc',operation:'send',socket:'socket-1',data:JSON.stringify(['REQ','forged-read',{kinds:[30023],limit:1}])},'*'));
  expect(await page.evaluate(() => (window as any).__legacy.requests)).toEqual([]);
  expect(await page.evaluate(() => (window as any).__legacy.status.some((message: string) => message.includes('not in Hypergolic’s Network relays')))).toBe(true);
});
test('native read lane preserves signature checks, exact generation, sequential delivery and legacy CLOSE', async ({page}) => {
  await setup(page, demo);
  await page.evaluate(() => {const s=(window as any).__legacy; s.openNative(); s.native.legacySubscribe({type:'relay.subscribe',id:'request',subId:'bounded',relay:'wss://relay.damus.io/',filters:[{kinds:[30023],limit:1}]},(message:unknown)=>s.nativeDeliveries.push(message));});
  const start = await page.evaluate(() => (window as any).__legacy.nativeWire[0]);
  expect(start.type).toBe('relay-stream'); expect(JSON.parse(start.message).type).toBe('legacy.subscribe');
  await page.evaluate(({start,event}) => {const s=(window as any).__legacy;const response=JSON.stringify({type:'relay.event',subId:'bounded',result:{event}}); s.nativeReply({type:'capability.stream',sessionId:'stale-generation',sequence:start.sequence,delivery:1,response});}, {start,event:article});
  expect(await page.evaluate(() => (window as any).__legacy.nativeDeliveries)).toEqual([]);
  await page.evaluate(({start,event}) => {const s=(window as any).__legacy; s.nativeReply({type:'capability.stream',sessionId:s.session,sequence:start.sequence,delivery:1,response:JSON.stringify({type:'relay.event',subId:'bounded',result:{event}})});}, {start,event:article});
  expect(await page.evaluate(() => (window as any).__legacy.nativeDeliveries.length)).toBe(1);
  await page.evaluate(({start,event}) => {const s=(window as any).__legacy;s.nativeReply({type:'capability.stream',sessionId:s.session,sequence:start.sequence,delivery:2,response:JSON.stringify({type:'relay.event',subId:'bounded',result:{event:{...event,content:'tampered'}}})});}, {start,event:article});
  const replies = await page.evaluate(() => (window as any).__legacy.nativeDeliveries);
  expect(replies.map((r:any) => r.type)).toEqual(['relay.event','relay.closed']);
  const wire = await page.evaluate(() => (window as any).__legacy.nativeWire);
  expect(wire.some((r:any) => r.type === 'capability' && JSON.parse(r.message).type === 'legacy.close')).toBe(true);
  expect(wire.every((r:any) => !r.message || !['relay.publish','EVENT','AUTH'].includes(JSON.parse(r.message).type))).toBe(true);
});
