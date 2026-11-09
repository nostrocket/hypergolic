import {npubEncode} from 'nostr-tools/nip19';
import {createHash} from 'node:crypto';
import {expect,test,type Page} from '@playwright/test';

const generation = '8487e847-a1e9-4ad5-ac5d-42c3a5e104d9';
const pubkey = '1'.repeat(64);
async function open(page:Page,domains = ['common','identity','relay'],social=false) {
  const html = '<!doctype html><html><head><title>Common proof</title></head><body><p>Common proof</p></body></html>';
  const digest = (value:string) => createHash('sha256').update(value).digest('hex');
  await page.addInitScript(({generation,domains,html,hash,version,pubkey,social}) => {
    if (window !== window.top) return;
    const listeners = new Set<(value:{data:string})=>void>();
    const requests:Record<string,unknown>[] = [];
    const send = (value:object) => {for(const listener of listeners)listener({data:JSON.stringify(value)});};
    const awaiting:Record<string,unknown>[]=[];
    (window as any).__commonProof = {requests,awaiting,review:()=>{const captured=awaiting.shift();if(!captured)throw Error('No pending native review');const request=JSON.parse(captured.message as string);send({type:'capability.result',sessionId:generation,sequence:captured.sequence,response:JSON.stringify({type:request.type+'.result',id:request.id,ok:false,error:'user-denied'})});}};
    Object.defineProperty(window,'HypergolicHost',{value:{
      addEventListener(_type:string,listener:(value:{data:string})=>void){listeners.add(listener);},
      removeEventListener(_type:string,listener:(value:{data:string})=>void){listeners.delete(listener);},
      postMessage(raw:string) {
        const captured = JSON.parse(raw);
        if (captured.type === 'artifact.read') {
          send({type:'artifact.chunk',sessionId:generation,sequence:0,base64:btoa(html),byteLength:html.length,
            totalBytes:html.length,publisher:pubkey,appId:'common-test',eventId:'2'.repeat(64),htmlHash:hash,version,domains,done:true});
          return;
        }
        if (captured.type !== 'capability') return;
        const request = JSON.parse(captured.message);
        requests.push(request);
        if (!domains.includes('common')) return;
        if(social&&['common.follow','common.unfollow','common.react','common.report'].includes(request.type)){awaiting.push(captured);return;}
        const base = {type:request.type+'.result',id:request.id};
        let response;
        if (request.type === 'common.getProfile') response = domains.includes('relay') || domains.includes('outbox')
          ? {...base,ok:true,pubkey,profile:{name:'Publisher profile',displayName:'Emoji publisher'}}
          : {...base,ok:false,pubkey,error:'unsupported'};
        else if (request.type === 'common.follows') response = domains.includes('identity')
          ? {...base,ok:true,pubkeys:[pubkey]} : {...base,ok:false,pubkeys:[],error:'unsupported'};
        else response = {...base,ok:false,error:'unsupported'};
        send({type:'capability.result',sessionId:generation,sequence:captured.sequence,response:JSON.stringify(response)});
      },
    }});
  },{generation,domains,html,social,hash:digest(html),version:digest(digest(html)+' /index.html\n'),pubkey});
  await page.goto(`/assets/runtime/index.html?source=published&sessionId=${generation}`);
  await expect(page.frameLocator('#napplet').getByText('Common proof')).toBeVisible();
  const frame = await (await page.locator('#napplet').elementHandle())?.contentFrame();
  if (!frame) throw Error('Missing verified guest');
  await frame.evaluate(async()=>{await (window as any).napplet.shell.ready();});
  return frame;
}

test('Common carries canonical profile results and exposes a successful follows wire result as the public array',async({page})=>{
  const guest = await open(page);
  const result = await guest.evaluate(async pubkey=>{
    const api = (window as any).napplet;
    const profile = await api.common.getProfile(pubkey);
    const follows = await api.common.follows();
    const unsupported = await api.common.follow(pubkey);
    return {profile,follows,unsupported,available:api.shell.supports('common')};
  },pubkey);
  expect(result).toEqual({profile:{ok:true,pubkey,profile:{name:'Publisher profile',displayName:'Emoji publisher'}},
    follows:[pubkey],unsupported:{ok:false,error:'unsupported'},available:true});
  const captured = await page.evaluate(()=>(window as any).__commonProof.requests);
  expect(captured.map((row:any)=>row.type)).toEqual(['common.getProfile','common.follows','common.follow']);
});

test('Common method failure remains explicit without adding Identity or Relay to a codec-only grant',async({page})=>{
  const guest = await open(page,['common']);
  const result = await guest.evaluate(async pubkey=>{
    const api = (window as any).napplet;
    let followsError = '';
    try {await api.common.follows();}catch(error){followsError = (error as Error).message;}
    return {profile:await api.common.getProfile(pubkey),followsError,identity:typeof api.identity,relay:typeof api.relay};
  },pubkey);
  expect(result).toEqual({profile:{ok:false,pubkey,error:'unsupported'},followsError:'unsupported',identity:'undefined',relay:'undefined'});
});

test('Common cannot be manufactured by an ungranted raw post',async({page})=>{
  const guest = await open(page,['theme']);
  const absent = await guest.evaluate(()=>{
    const api = (window as any).napplet;
    parent.postMessage({type:'common.getProfile',id:'raw',target:'1'.repeat(64)},'*');
    return {namespace:typeof api.common,reported:api.shell.supports('common')};
  });
  expect(absent).toEqual({namespace:'undefined',reported:false});
  expect(await page.evaluate(()=>(window as any).__commonProof.requests)).toEqual([]);
});


test('four Common social SDK methods retain original fields and a native-review promise beyond ordinary timeout',async({page})=>{
  await page.clock.install();const guest=await open(page,['common','identity','outbox'],true),npub=npubEncode(pubkey);
  const cases=[{method:'follow',args:[npub],payload:{pubkeys:[npub]}},{method:'unfollow',args:[npub],payload:{pubkeys:[npub]}},
    {method:'react',args:['2'.repeat(64),':wave:','https://emoji.example.org/wave.png'],payload:{targetEventId:'2'.repeat(64),reaction:':wave:',customEmojiHref:'https://emoji.example.org/wave.png'}},
    {method:'report',args:[{type:'event',id:'2'.repeat(64)},'spam','review text'],payload:{target:{type:'event',id:'2'.repeat(64)},reason:'spam',text:'review text'}}];
  for(const [index,value] of cases.entries()){
    await guest.evaluate(({method,args})=>{(window as any).__socialSettled=false;(window as any).__socialReply=null;void (window as any).napplet.common[method](...args).then((result:unknown)=>{(window as any).__socialReply=result;(window as any).__socialSettled=true;});},value);
    await expect.poll(()=>page.evaluate(()=>(window as any).__commonProof.awaiting.length)).toBe(1);
    const captured=await page.evaluate(()=>(window as any).__commonProof.requests.at(-1));expect(captured.type).toBe('common.'+value.method);expect(captured).toMatchObject(value.payload);
    if(index===0){await page.clock.fastForward(30_000);expect(await guest.evaluate(()=>(window as any).__socialSettled)).toBe(false);}
    await page.evaluate(()=>(window as any).__commonProof.review());
    await expect.poll(()=>guest.evaluate(()=>(window as any).__socialReply)).toEqual({ok:false,error:'user-denied'});
  }
});
