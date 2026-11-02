import {test, expect, type Page} from '@playwright/test';
const defaults={theme:'dark',count:3,enabled:true,tags:['alpha'],advanced:{density:'comfortable'}};
async function open(page:Page){
 await page.addInitScript(() => {
  if(window!==window.top)return;
  const root=window as any,listeners=new Set<(event:{data:string})=>void>(),state={calls:[] as any[],delivery:0,values:{theme:'dark',count:3,enabled:true,tags:['alpha'],advanced:{density:'comfortable'}},registered:false};root.configNative=state;
  root.configPush=(message:any,generation='config-browser')=>{const raw=JSON.stringify({type:'routing.event',sessionId:generation,delivery:++state.delivery,response:JSON.stringify(message)});listeners.forEach(fn=>fn({data:raw}));};
  root.HypergolicHost={addEventListener:(_:string,fn:any)=>listeners.add(fn),removeEventListener:(_:string,fn:any)=>listeners.delete(fn),postMessage(raw:string){
   const envelope=JSON.parse(raw);if(envelope.type!=='capability')return;const wrapper=JSON.parse(envelope.message),message=wrapper.message;state.calls.push(message);let response:any=null;
   if(message.type==='config.registerSchema'){
    const properties=message.schema.properties??{},code=properties.token?.default!==undefined?'secret-with-default':properties.name?.pattern?'pattern-not-allowed':null;
    response=state.rejectSchemaReply?{type:'config.registerSchema.result',id:message.id,ok:'invalid'}:code?{type:'config.registerSchema.result',id:message.id,ok:false,code,error:'Schema rejected: '+code}:{type:'config.registerSchema.result',id:message.id,ok:true};if(!code&&!state.rejectSchemaReply)state.registered=true;
   }
   if(message.type==='config.get'&&state.registered)response={type:'config.values',id:message.id,values:state.values};
   queueMicrotask(()=>{const result=JSON.stringify({type:'capability.result',sessionId:'config-browser',sequence:envelope.sequence,response:JSON.stringify({type:'routing.call.result',id:wrapper.id,response})});listeners.forEach(fn=>fn({data:result}));
    if(message.type==='config.subscribe'||message.type==='config.get'&&!state.registered)root.configPush(state.registered?{type:'config.values',values:state.values}:{type:'config.schemaError',code:'no-schema',error:'No configuration schema is registered.'});});
  }};
 });
 await page.goto('/assets/runtime/index.html?sessionId=config-browser&fixture=routing-lab');const guest=page.frameLocator('#napplet');await expect(guest.locator('#lab')).toHaveAttribute('data-ready','true');return guest;
}
test('genuine configuration SDK observes positive schema ACK, exact default snapshot, initial/live subscription and focused settings request',async({page})=>{
 const guest=await open(page);await guest.locator('#config-register').click();await expect(guest.locator('#config-status')).toHaveText('Configuration schema accepted.');await guest.locator('#config-get').click();await expect(guest.locator('#config-result')).toHaveText(JSON.stringify(defaults));
 await guest.locator('#config-subscribe').click();await expect(guest.locator('#config-events')).toHaveText(JSON.stringify([defaults]));const next={...defaults,theme:'light',token:'public-browser-token + ⚡'};await page.evaluate(values=>(window as any).configPush({type:'config.values',values}),next);await expect(guest.locator('#config-events')).toHaveText(JSON.stringify([defaults,next]));
 await guest.locator('#config-open').click();await expect.poll(async()=>page.evaluate(()=>(window as any).configNative.calls.some((row:any)=>row.type==='config.openSettings'&&row.section==='Basics'))).toBe(true);await guest.locator('#config-unsubscribe').click();await expect.poll(async()=>page.evaluate(()=>(window as any).configNative.calls.some((row:any)=>row.type==='config.unsubscribe'))).toBe(true);
});
test('no-schema emits error without values; forbidden schema receives negative SDK ACK without default success',async({page})=>{
 const guest=await open(page);await guest.locator('#config-subscribe').click();await expect(guest.locator('#config-errors')).toContainText('no-schema');await expect(guest.locator('#config-events')).toBeEmpty();
 await guest.locator('#config-bad-default').click();await expect(guest.locator('#config-status')).toContainText('Request failed: Schema rejected: secret-with-default');await guest.locator('#config-bad-pattern').click();await expect(guest.locator('#config-status')).toContainText('Request failed: Schema rejected: pattern-not-allowed');await expect(guest.locator('#config-errors')).toContainText('no-schema');await expect(guest.locator('#config-result')).toBeEmpty();
});
test('guest writes/authority and foreign or malformed config pushes acquire no native data route',async({page})=>{
 const guest=await open(page);await guest.locator('#config-register').click();await expect(guest.locator('#config-status')).toHaveText('Configuration schema accepted.');await guest.locator('#config-subscribe').click();await expect(guest.locator('#config-events')).toHaveText(JSON.stringify([defaults]));const count=await page.evaluate(()=>(window as any).configNative.calls.length);await guest.locator('#config-malformed').click();
 await page.evaluate(()=>{const root=window as any;root.configPush({type:'config.values',values:{theme:'foreign'}},'foreign-generation');root.configPush({type:'config.values',values:{theme:'forged'},publisher:'forged'});});await expect(guest.locator('#config-events')).toHaveText(JSON.stringify([defaults]));expect(await page.evaluate(()=>(window as any).configNative.calls.length)).toBe(count);
 const next={...defaults,theme:'light'};await page.evaluate(values=>(window as any).configPush({type:'config.values',values}),next);await expect(guest.locator('#config-events')).toHaveText(JSON.stringify([defaults,next]));
});
test('genuine SDK depth-four schema crosses the runtime into the captured native carrier without truncation',async({page})=>{
 const guest=await open(page);await guest.locator('#config-depth-four').click();await expect(guest.locator('#config-status')).toHaveText('Depth-four schema accepted.');
 const call=await page.evaluate(()=>(window as any).configNative.calls.find((row:any)=>row.type==='config.registerSchema'));expect(call.schema.properties.deep.properties.child.properties.leaf.properties.values.items.enum).toEqual(['native-depth-four']);expect(call.version).toBe(2);
});

test('one-shot configuration snapshots stay correlated and cannot duplicate live subscription callbacks',async({page})=>{
 const guest=await open(page);await guest.locator('#config-register').click();await expect(guest.locator('#config-status')).toHaveText('Configuration schema accepted.');
 await guest.locator('#config-subscribe').click();await expect(guest.locator('#config-events')).toHaveText(JSON.stringify([defaults]));
 await guest.locator('#config-get').click();await expect(guest.locator('#config-read-count')).toHaveText(JSON.stringify({reads:1}));await expect(guest.locator('#config-result')).toHaveText(JSON.stringify(defaults));
 const next={...defaults,theme:'light'};await page.evaluate(values=>(window as any).configPush({type:'config.values',values}),next);
 await expect(guest.locator('#config-events')).toHaveText(JSON.stringify([defaults,next]));
 await guest.locator('#config-unsubscribe').click();await expect.poll(async()=>page.evaluate(()=>(window as any).configNative.calls.some((row:any)=>row.type==='config.unsubscribe'))).toBe(true);
 await page.evaluate(values=>(window as any).configPush({type:'config.values',values}),defaults);
 await guest.locator('#config-get').click();await expect(guest.locator('#config-read-count')).toHaveText(JSON.stringify({reads:2}));
 await expect(guest.locator('#config-events')).toHaveText(JSON.stringify([defaults,next]));
});


test('a rejected native schema reply reports both the failed registration and one SDK schema-error callback',async({page})=>{
 const guest=await open(page);await page.evaluate(()=>(window as any).configNative.rejectSchemaReply=true);
 await guest.locator('#config-register').click();await expect(guest.locator('#config-status')).toContainText('Request failed: Configuration schema was not applied.');
 await expect(guest.locator('#config-errors')).toContainText('invalid-schema');
 const errors=JSON.parse(await guest.locator('#config-errors').textContent()??'null');expect(errors).toHaveLength(1);expect(errors[0].code).toBe('invalid-schema');
 await expect(guest.locator('#config-result')).toBeEmpty();await expect(guest.locator('#config-events')).toBeEmpty();
});
