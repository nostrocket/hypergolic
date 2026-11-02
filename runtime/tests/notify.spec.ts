import {test, expect, type Page} from '@playwright/test';
// Genuine SDK/runtime transport checks with a browser double; not native acceptance.
async function open(page: Page) {
 await page.addInitScript(() => {
  if (window !== window.top) return;
  const root = window as any, listeners = new Set<(event: {data: string}) => void>(), state = {calls: [] as any[], delivery: 0, sequence: [] as number[], mode: 'allow', next: 0};root.notifyNative = state;
  root.notifyPush = (message: any, generation = 'notify-browser') => {const raw=JSON.stringify({type:'routing.event',sessionId:generation,delivery:++state.delivery,response:JSON.stringify(message)});listeners.forEach(listener=>listener({data:raw}));};
  root.HypergolicHost = {addEventListener: (_: string, listener: any) => listeners.add(listener), removeEventListener: (_: string, listener: any) => listeners.delete(listener), postMessage(raw: string) {
   const envelope=JSON.parse(raw);if(envelope.type==='routing-ack'){state.sequence.push(envelope.sequence);return;}if(envelope.type!=='capability')return;state.sequence.push(envelope.sequence);
   const wrapper=JSON.parse(envelope.message),message=wrapper.message;state.calls.push(message);let response:any=null;
   if(message.type==='notify.permission.request')response={type:'notify.permission.result',id:message.id,granted:state.mode==='allow'};
   if(message.type==='notify.send')response=state.mode==='allow'?{type:'notify.send.result',id:message.id,notificationId:'native-notify-'+(++state.next)}:{type:'notify.send.result',id:message.id,error:'permission denied'};
   queueMicrotask(()=>{const result=JSON.stringify({type:'capability.result',sessionId:'notify-browser',sequence:envelope.sequence,response:JSON.stringify({type:'routing.call.result',id:wrapper.id,response})});listeners.forEach(listener=>listener({data:result}));
    if(message.type==='notify.__register')root.notifyPush({type:'notify.controls',controls:['toasts','badges','actions','channels']});});
  }};
 });
 await page.goto('/assets/runtime/index.html?sessionId=notify-browser&fixture=routing-lab');const guest=page.frameLocator('#napplet');await expect(guest.locator('#lab')).toHaveAttribute('data-ready','true');return guest;
}
test('genuine SDK canonical permission, send and all callback surfaces use native result and captured recipient',async({page})=>{
 const guest=await open(page);await guest.locator('#notify-permission').click();await expect(guest.locator('#notify-permission-result')).toHaveText('{"granted":true}');
 await guest.locator('#notify-send').click();await expect(guest.locator('#notify-result')).toHaveText('{"notificationId":"native-notify-1"}');
 for(const message of [{type:'notify.action',notificationId:'native-notify-1',actionId:'reply'},{type:'notify.clicked',notificationId:'native-notify-1'},{type:'notify.dismissed',notificationId:'native-notify-1',reason:'user'}])await page.evaluate(message=>(window as any).notifyPush(message),message);
 await expect(guest.locator('#notify-events')).toContainText('"kind":"dismissed"');await expect(guest.locator('#notify-events')).toContainText('"actionId":"reply"');
 await page.evaluate(()=>(window as any).notifyPush({type:'notify.controls',controls:['toasts','badges','actions','channels']}));await expect(guest.locator('#notify-controls')).toHaveText('["toasts","badges","actions","channels"]');
 const calls=await page.evaluate(()=>(window as any).notifyNative.calls);expect(calls.find((row:any)=>row.type==='notify.send').body).toBe('Exact SDK notification + ⚡');expect(calls.find((row:any)=>row.type==='notify.permission.request')).toBeTruthy();
});
test('denied SDK permission and send stay failures; no browser fallback grants success',async({page})=>{
 const guest=await open(page);await page.evaluate(()=>(window as any).notifyNative.mode='deny');await guest.locator('#notify-permission').click();await expect(guest.locator('#notify-permission-result')).toHaveText('{"granted":false}');await guest.locator('#notify-send').click();await expect(guest.locator('#notify-status')).toContainText('Request failed:');await expect(guest.locator('#notify-result')).toBeEmpty();
});
test('foreign generation, malformed push and guest spoof cannot deliver callbacks or acquire native request',async({page})=>{
 const guest=await open(page);await page.evaluate(() => {const root=window as any;root.notifyPush({type:'notify.action',notificationId:'foreign',actionId:'reply'},'foreign-generation');root.notifyPush({type:'notify.action',notificationId:'foreign',actionId:'reply',sender:'forged'});root.notifyPush({type:'notify.controls',controls:['system']});});
 await guest.locator('#notify-malformed').click();await expect(guest.locator('#notify-events')).toBeEmpty();expect((await page.evaluate(()=>(window as any).notifyNative.calls)).filter((row:any)=>row.title==='Forged source')).toHaveLength(0);
 await page.evaluate(()=>(window as any).notifyPush({type:'notify.clicked',notificationId:'native-positive'}));await expect(guest.locator('#notify-events')).toContainText('native-positive');
});

test('bounded oversized SDK send returns a correlated denial promptly without crossing the native boundary',async({page})=>{
 const guest=await open(page);await guest.locator('#notify-oversized').click();
 await expect(guest.locator('#notify-oversized-result')).toContainText('"accepted":false',{timeout:5000});
 expect((await page.evaluate(()=>(window as any).notifyNative.calls)).filter((row:any)=>row.type==='notify.send')).toHaveLength(0);
 await guest.locator('#notify-send').click();await expect(guest.locator('#notify-result')).toHaveText('{"notificationId":"native-notify-1"}');
});
