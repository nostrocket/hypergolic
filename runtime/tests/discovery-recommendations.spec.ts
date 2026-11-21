import {captureEventSnapshot} from '../../src/security/event-snapshot';
import {createCatalogRecommendations} from '../../src/napplets/catalog-recommendation';
import {test,expect} from '@playwright/test';
import {finalizeEvent,getPublicKey} from 'nostr-tools/pure';
const key=new Uint8Array(32).fill(1),account=getPublicKey(key),coordinate='35129:'+account+':test';
const event={kind:30267,created_at:1790000000,content:'preserved',tags:[['d','napplets'],['a',coordinate],['title','My apps']]};
const signed=finalizeEvent({...event},key);
async function setup(page:any,mode='success',fixture='napplet-discovery',service?:{prepared:object;app:object;signed:object}) {
  await page.addInitScript(({mode,account,event,signed,service}:any)=>{
    if(window!==window.top)return;
    const root=window as any;root.recommendTest={calls:[],mode};const listeners=new Set<any>();
    root.HypergolicHost={addEventListener:(_:any,listener:any)=>listeners.add(listener),removeEventListener:(_:any,listener:any)=>listeners.delete(listener),postMessage(raw:string){
      const envelope=JSON.parse(raw);if(envelope.type==='ready'){root.recommendTest.ready=true;return;}if(envelope.type!=='capability')return;
      const request=JSON.parse(envelope.message);root.recommendTest.calls.push(request);
      const send=(response:any)=>listeners.forEach(listener=>listener({data:JSON.stringify({type:'capability.result',sessionId:envelope.sessionId,sequence:envelope.sequence,response:response===null?null:JSON.stringify(response)})}));
      const base={type:request.type+'.result',id:request.id};
      if(request.type==='lists.prepareRecommendation') {
        const result = mode === 'duplicate' ? {status:'already-recommended'} :
          {account,...(service?.prepared??{status:'prepared',event,relays:['wss://relay.example.com/']})};
        if (mode === 'hold') root.recommendTest.finish = () => send({...base,result});
        else send({...base,result});
      }else if(request.type==='relay.publish')send(mode==='null'?null:mode==='rejected'?{...base,ok:false,error:'no relay accepted the event'}:{...base,ok:true,event:mode==='mismatch'?{...signed,content:'forged'}:service?.signed??signed,eventId:service?.signed?.id??signed.id});
      else if(request.type==='relay.query' || request.type==='outbox.query')send({...base,events:service && request.filters?.some((filter:any)=>filter.kinds?.includes(35129))?[{event:service.app}]:[]});
    }};
  },{mode,account,event,signed,...(service?{service}:{})});
  await page.goto('/assets/runtime/index.html?sessionId=recommendation-test&fixture='+fixture);
  await expect.poll(()=>page.evaluate(()=>Boolean((window as any).recommendTest.ready))).toBe(true);
  const guest=page.frames().find((frame:any)=>frame.parentFrame()===page.mainFrame())!;
  return guest;
}
test('the standard lists projection only offers the supported public app curation set',async({page})=>{
  const guest=await setup(page,'duplicate');
  const result=await guest.evaluate(async(coordinate:string)=>{
    const lists=(window as any).napplet.lists;
    const list={kind:30267,identifier:'napplets'};
    return [await lists.supported(),await lists.add(list,[{itemType:'address',value:coordinate}],{create:true}),
      await lists.add({kind:10000},[{itemType:'word',value:'x'}]),
      await lists.add(list,[{itemType:'address',value:coordinate,visibility:'private'}])];
  },coordinate);
  expect(result[0]).toEqual([{kind:30267,type:'app-curation-sets',addressable:true,supportedItemTypes:['address'],privateItems:false}]);
  expect(result[1]).toEqual({ok:true,added:0,skipped:1});
  expect(result[2]).toMatchObject({ok:false,error:'unsupported-list'});
  expect(result[3]).toEqual({ok:false,error:'private-items-unsupported'});
  expect(await page.evaluate(()=>(window as any).recommendTest.calls.filter((row:any)=>row.type==='relay.publish'))).toEqual([]);
});
test('list addition rejects a second request while the first waits for native review', async ({page}) => {
  const guest = await setup(page, 'hold');
  await guest.evaluate((coordinate: string) => {
    const root = window as any;
    const add = () => root.napplet.lists.add({kind:30267,identifier:'napplets'}, [{itemType:'address',value:coordinate}], {create:true});
    root.firstRecommendation = add();
    root.secondRecommendation = add();
  }, coordinate);
  await expect.poll(() => guest.evaluate(() => (window as any).secondRecommendation)).toMatchObject({ok:false,error:'list-unavailable'});
  await page.evaluate(() => (window as any).recommendTest.finish());
  expect(await guest.evaluate(() => (window as any).firstRecommendation)).toMatchObject({ok:true,added:1});
  const requests = await page.evaluate(() => (window as any).recommendTest.calls);
  expect(requests.filter((row:any) => row.type === 'relay.publish')).toHaveLength(1);
});

for (const [mode, error] of [['mismatch','publication-result-unknown'], ['rejected','publish-failed']] as const) {
  test(`standard lists preserves a ${mode} publication outcome`, async ({page}) => {
    const guest = await setup(page, mode);
    const result = await guest.evaluate((coordinate: string) => (window as any).napplet.lists.add(
      {kind:30267,identifier:'napplets'}, [{itemType:'address',value:coordinate}], {create:true}), coordinate);
    expect(result).toMatchObject({ok:false,error});
  });
}

for(const mode of ['success','null'])test(`packaged public Recommend uses native service snapshot and ${mode} receipt`,async({page})=>{
  const previous=finalizeEvent({kind:30267,created_at:Math.floor(Date.now()/1000)-30,content:'keep private-list content',tags:[['d','napplets'],['title','Original list'],['a','35129:'+account+':existing']]},key);
  const app=finalizeEvent({kind:35129,created_at:Math.floor(Date.now()/1000)-20,content:'Native snapshot integration',tags:[['d','native-service-app'],['title','Native service app'],['x','f'.repeat(64)]]},key);
  const target='35129:'+account+':native-service-app';
  const native=createCatalogRecommendations(account,{
    destinations:()=>['wss://relay.example.com/'],
    queryDetailed:async()=>({events:[{event:JSON.parse(JSON.stringify(previous))}],incomplete:false}),
  } as never,async()=>true);
  const signal=new AbortController().signal;
  const prepared=await native.prepareAddition(target,true,signal,()=>{});
  expect(prepared).toMatchObject({status:'prepared',relays:['wss://relay.example.com/']});
  const plan=prepared as {event:any;relays:string[]};
  const guard=native.bind(captureEventSnapshot(plan.event,account,plan.relays));
  expect(guard).not.toBeNull();
  if(mode==='null')guard!.release(true);
  else {await guard!(signal,()=>{});await guard!(signal,()=>{});}
  const signed=finalizeEvent({...plan.event},key);
  const guest=await setup(page,mode,'napplet-discovery',{prepared,app,signed});
  await guest.getByRole('button',{name:'Details for Native service app',exact:true}).click();
  await guest.getByRole('button',{name:'Recommend publicly',exact:true}).click();
  await expect(guest.locator('.recommend-status')).toHaveText(mode==='success'?'Added to your public recommendations.':'Could not confirm the public recommendation. Check your list before trying again.');
  if(mode==='null')await expect(guest.getByRole('button',{name:'Recommend publicly',exact:true})).toBeDisabled();
  const calls=await page.evaluate(()=>(window as any).recommendTest.calls);
  const writes=calls.filter((row:any)=>row.type==='relay.publish');
  expect(writes).toEqual([{type:'relay.publish',id:expect.stringMatching(/^lists-publish-/),event:plan.event}]);
  expect(writes[0].event.tags).toEqual([...previous.tags,['a',target]]);
  expect(writes[0].event.content).toBe(previous.content);
});
