import {captureEventSnapshot} from '../../src/security/event-snapshot';
import {createCatalogRecommendations} from '../../src/napplets/catalog-recommendation';
import {captureRecommendationRead} from '../src/discovery-recommendations';
import {test,expect} from '@playwright/test';
import {finalizeEvent,getPublicKey} from 'nostr-tools/pure';
const key=new Uint8Array(32).fill(1),account=getPublicKey(key),coordinate='35129:'+account+':test';
const event={kind:30267,created_at:1790000000,content:'preserved',tags:[['d','napplets'],['a',coordinate],['title','My apps']]};
const signed=finalizeEvent({...event},key);
async function setup(page:any,mode='success',fixture='napplet-discovery',service?:{read:object;prepared:object;app:object;signed:object}) {
  await page.addInitScript(({mode,account,event,signed,service}:any)=>{
    if(window!==window.top)return;
    const root=window as any;root.recommendTest={calls:[],mode};const listeners=new Set<any>();
    root.HypergolicHost={addEventListener:(_:any,listener:any)=>listeners.add(listener),removeEventListener:(_:any,listener:any)=>listeners.delete(listener),postMessage(raw:string){
      const envelope=JSON.parse(raw);if(envelope.type==='ready'){root.recommendTest.ready=true;return;}if(envelope.type!=='capability')return;
      const request=JSON.parse(envelope.message);root.recommendTest.calls.push(request);
      const send=(response:any)=>listeners.forEach(listener=>listener({data:JSON.stringify({type:'capability.result',sessionId:envelope.sessionId,sequence:envelope.sequence,response:response===null?null:JSON.stringify(response)})}));
      const base={type:request.type+'.result',id:request.id};
      if(request.type==='relay.catalogRecommendation'){
        if(!request.coordinate)send({...base,result:mode==='incomplete-read'?{status:'incomplete',failedRelays:['wss://relay.example.com']}:service?.read??{status:'ready',account,revision:null,recommended:[]}});
        else if(mode==='incomplete-peers')send({...base,result:{status:'incomplete',failedRelays:['wss://relay.example.com']}});
        else if(mode==='stale'||mode==='incomplete')send({...base,result:{status:mode}});
        else if(mode==='hold')root.recommendTest.finish=()=>send({...base,result:{status:'prepared',event,relays:['wss://relay.example.com/']}});
        else send({...base,result:service?.prepared??{status:'prepared',event,relays:['wss://relay.example.com/']}});
      }else if(request.type==='relay.publish')send(mode==='null'?null:mode==='rejected'?{...base,ok:false,error:'no relay accepted the event'}:{...base,ok:true,event:mode==='mismatch'?{...signed,content:'forged'}:service?.signed??signed,eventId:service?.signed?.id??signed.id});
      else if(request.type==='relay.catalogPage')send({...base,result:{page:1,until:Math.floor(Date.now()/1000),events:service?[{event:service.app}]:[],more:false,partial:false,gap:false,bounded:false}});
      else if(request.type==='relay.query')send({...base,events:[]});
    }};
  },{mode,account,event,signed,...(service?{service}:{})});
  await page.goto('/assets/runtime/index.html?sessionId=recommendation-test&fixture='+fixture);
  await expect.poll(()=>page.evaluate(()=>Boolean((window as any).recommendTest.ready))).toBe(true);
  const guest=page.frames().find((frame:any)=>frame.parentFrame()===page.mainFrame())!;
  return guest;
}
test('only verified Discover exposes recommendation transport',async({page})=>{
  const guest=await setup(page,'success','nap-support');
  expect(await guest.evaluate(()=>Boolean((window as any).hypergolic?.recommendations))).toBe(false);
});
test('failed relay details survive read and preparation without publishing',async({page})=>{
  let guest=await setup(page,'incomplete-read');
  expect(await guest.evaluate(()=>(window as any).hypergolic.recommendations.read())).toEqual({status:'incomplete',failedRelays:['wss://relay.example.com']});
  guest=await setup(page,'incomplete-peers');
  expect(await guest.evaluate(({coordinate,account}:any)=>(window as any).hypergolic.recommendations.recommend({coordinate,account,revision:null}),{coordinate,account})).toEqual({status:'incomplete',failedRelays:['wss://relay.example.com']});
  expect(await page.evaluate(()=>(window as any).recommendTest.calls.filter((row:any)=>row.type==='relay.publish'))).toEqual([]);
});
test('a reachable offer crosses the bridge without forwarding any guest-selected destinations', async ({page}) => {
  const offer = {account, revision: null, token: 'ab'.repeat(16)};
  const read = {status: 'incomplete', failedRelays: ['wss://offline.example.org'], offer};
  const app = finalizeEvent({kind:35129,created_at:1790000000,content:'',tags:[['d','test']]}, key);
  const guest = await setup(page, 'success', 'napplet-discovery', {read, app, signed,
    prepared: {status:'prepared', event, relays:['wss://relay.example.com/']}});
  expect(await guest.evaluate(() => (window as any).hypergolic.recommendations.read())).toEqual(read);
  const attempt = {account, revision:null, coordinate, reachableToken:offer.token};
  expect(await guest.evaluate((input: typeof attempt) => (window as any).hypergolic.recommendations.recommend({...input, relays:['wss://other.example.org']}), attempt)).toEqual({status:'unavailable'});
  expect(await guest.evaluate((input: typeof attempt) => (window as any).hypergolic.recommendations.recommend(input), attempt)).toEqual({status:'published'});
  const calls = await page.evaluate(() => (window as any).recommendTest.calls);
  expect(calls.filter((row:any) => row.coordinate)).toEqual([{type:'relay.catalogRecommendation', id:expect.any(String), ...attempt}]);
  expect(calls.filter((row:any) => row.type==='relay.publish')).toEqual([{type:'relay.publish', id:expect.any(String), event}]);
});

test('malformed offers never become actionable', () => {
  const offer = {account, revision:null, token:'ab'.repeat(16)};
  for (const changed of [{...offer, token:0}, {...offer, revision:'bad'}, {...offer, relays:[]}, {...offer, account:'wrong'}]) {
    expect(() => captureRecommendationRead({status:'incomplete', failedRelays:['wss://offline.example.org'], offer:changed})).toThrow();
  }
  expect(() => captureRecommendationRead({status:'incomplete', offer})).toThrow();
});

test('packaged Discover waits for a separate tap before asking for scoped publication', async ({page}) => {
  const target = '35129:' + account + ':scoped';
  const app = finalizeEvent({kind:35129, created_at:Math.floor(Date.now()/1000)-20, content:'',
    tags:[['d','scoped'],['title','Scoped app'],['x','f'.repeat(64)]]}, key);
  const offer = {account, revision:null, token:'ab'.repeat(16)};
  const template = {...event, tags:[['d','napplets'],['a',target]]};
  const guest = await setup(page, 'success', 'napplet-discovery', {
    read:{status:'incomplete', failedRelays:['wss://offline.example.org'], offer},
    prepared:{status:'prepared', event:template, relays:['wss://relay.example.com/']},
    app, signed:finalizeEvent({...template}, key)
  });
  await guest.getByRole('button', {name:'Details for Scoped app'}).click();
  await guest.getByRole('button', {name:'Recommend publicly', exact:true}).click();
  const choice = guest.getByRole('button', {name:'Use reachable relays this time'});
  await expect(choice).toBeVisible();
  await expect(guest.getByRole('button', {name:'Retry all relays'})).toBeVisible();
  await expect(guest.locator('.recommend-status')).toContainText('offline.example.org');
  const requests = () => page.evaluate(() => (window as any).recommendTest.calls.filter((row:any) => row.coordinate || row.type==='relay.publish'));
  expect(await requests()).toEqual([]);
  await choice.click();
  await expect(guest.locator('.recommend-status')).toHaveText('Recommended publicly.');
  expect(await requests()).toEqual([
    {type:'relay.catalogRecommendation', id:expect.any(String), coordinate:target, account, revision:null, reachableToken:offer.token},
    {type:'relay.publish', id:expect.any(String), event:template}
  ]);
});
test('failed relay details retain the native destination safety policy',()=>{
  for(const failedRelays of [['http://relay.example.com'],['wss://127.0.0.1'],['wss://relay.example.com','wss://RELAY.example.com/']]){
    expect(()=>captureRecommendationRead({status:'incomplete',failedRelays})).toThrow();
  }
});
test('exact Discover reads selected account and publishes only the prepared event through native review',async({page})=>{
  const guest=await setup(page);
  const result=await guest.evaluate(async({coordinate,account}:any)=>{
    const api=(window as any).hypergolic.recommendations;
    parent.postMessage({type:'relay.catalogRecommendation',id:'forged',token:'wrong'},'*');
    const read=await api.read();
    return {read,result:await api.recommend({coordinate,account,revision:null})};
  },{coordinate,account});
  expect(result.read).toEqual({status:'ready',account,revision:null,recommended:[]});
  expect(result.result).toEqual({status:'published'});
  const calls=await page.evaluate(()=>(window as any).recommendTest.calls);
  expect(calls.some((row:any)=>row.id==='forged')).toBe(false);
  expect(calls.filter((row:any)=>row.type==='relay.publish')).toEqual([{type:'relay.publish',id:expect.any(String),event}]);
});
for(const mode of ['null','mismatch','stale','incomplete','rejected'])test(`recommendation ${mode} cannot report publication success`,async({page})=>{
  const guest=await setup(page,mode);
  expect(await guest.evaluate(({coordinate,account}:any)=>(window as any).hypergolic.recommendations.recommend({coordinate,account,revision:null}),{coordinate,account})).toEqual({status:mode==='stale'||mode==='incomplete'?mode:mode==='rejected'?'failed':'uncertain'});
  if(mode==='stale'||mode==='incomplete')expect(await page.evaluate(()=>(window as any).recommendTest.calls.filter((row:any)=>row.type==='relay.publish'))).toEqual([]);
});

test('a pending native prepare cannot start a second recommendation review',async({page})=>{
  const guest=await setup(page,'hold');
  const second=await guest.evaluate(async({coordinate,account}:any)=>{
    const root=window as any;
    void root.hypergolic.recommendations.recommend({coordinate,account,revision:null}).then((result:any)=>{root.recommendResult=result;});
    return root.hypergolic.recommendations.recommend({coordinate,account,revision:null});
  },{coordinate,account});
  expect(second).toEqual({status:'unavailable'});
  await expect.poll(()=>page.evaluate(()=>typeof (window as any).recommendTest.finish)).toBe('function');
  await page.evaluate(()=>(window as any).recommendTest.finish());
  await expect.poll(()=>guest.evaluate(()=>(window as any).recommendResult)).toEqual({status:'published'});
  expect(await page.evaluate(()=>(window as any).recommendTest.calls.filter((row:any)=>row.type==='relay.publish').length)).toBe(1);
});

for(const mode of ['success','null'])test(`packaged public Recommend uses native service snapshot and ${mode} receipt`,async({page})=>{
  const previous=finalizeEvent({kind:30267,created_at:Math.floor(Date.now()/1000)-30,content:'keep private-list content',tags:[['d','napplets'],['title','Original list'],['a','35129:'+account+':existing']]},key);
  const app=finalizeEvent({kind:35129,created_at:Math.floor(Date.now()/1000)-20,content:'Native snapshot integration',tags:[['d','native-service-app'],['title','Native service app'],['x','f'.repeat(64)]]},key);
  const target='35129:'+account+':native-service-app';
  const native=createCatalogRecommendations(account,{
    catalog:{destinations:()=>['wss://relay.example.com/']},
    queryDetailed:async()=>({events:[{event:JSON.parse(JSON.stringify(previous))}],incomplete:false}),
  } as never,async()=>true);
  const signal=new AbortController().signal;
  const read=await native.dispatch({type:'relay.catalogRecommendation',id:'service-read'},signal,()=>{});
  const prepared=await native.dispatch({type:'relay.catalogRecommendation',id:'service-prepare',account,revision:previous.id,coordinate:target},signal,()=>{});
  expect(prepared).toMatchObject({status:'prepared',relays:['wss://relay.example.com/']});
  const plan=prepared as {event:any;relays:string[]};
  const guard=native.bind(captureEventSnapshot(plan.event,account,plan.relays));
  expect(guard).not.toBeNull();
  if(mode==='null')guard!.release(true);
  else {await guard!(signal,()=>{});await guard!(signal,()=>{});}
  const signed=finalizeEvent({...plan.event},key);
  const guest=await setup(page,mode,'napplet-discovery',{read,prepared,app,signed});
  await guest.getByRole('button',{name:'Details for Native service app',exact:true}).click();
  await guest.getByRole('button',{name:'Recommend publicly',exact:true}).click();
  await expect(guest.locator('.recommend-status')).toHaveText(mode==='success'?'Recommended publicly.':'Publication could not be confirmed. Check your list before trying again.');
  const calls=await page.evaluate(()=>(window as any).recommendTest.calls);
  const writes=calls.filter((row:any)=>row.type==='relay.publish');
  expect(writes).toEqual([{type:'relay.publish',id:expect.any(String),event:plan.event}]);
  expect(writes[0].event.tags).toEqual([...previous.tags,['a',target]]);
  expect(writes[0].event.content).toBe(previous.content);
});
