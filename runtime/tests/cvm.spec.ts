import {createHash} from 'node:crypto';import {expect,test,type Page} from '@playwright/test';
const generation='8487e847-a1e9-4ad5-ac5d-42c3a5e104d9',pubkey='4'.repeat(64);
async function open(page:Page,granted=true){
 const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
 const html='<!doctype html><html><head><title>CVM fixture</title></head><body><p>CVM fixture</p></body></html>',hash=createHash('sha256').update(html).digest('hex');
 await page.addInitScript(({generation,pubkey,html,hash,version,granted})=>{
  if(window!==window.top)return;const listeners=new Set<(e:{data:string})=>void>(),requests:any[]=[],held:any[]=[];
  const send=(value:object)=>{for(const listener of listeners)listener({data:JSON.stringify(value)});};
  const reply=(captured:any,message:object)=>send({type:'cvm.response',sessionId:generation,sequence:captured.sequence,response:JSON.stringify(message)});
  (window as any).__cvm={requests,held,finish(){const captured=held.shift();if(!captured)throw Error('No held request');const row=JSON.parse(captured.message),mcp=JSON.parse(row.message);reply(captured,{type:'cvm.request.result',id:row.id,message:{jsonrpc:'2.0',id:mcp.id,result:{accepted:true}}});},event(){send({type:'cvm.event',sessionId:generation,message:JSON.stringify({type:'cvm.event',server:{pubkey},message:{jsonrpc:'2.0',method:'notifications/progress',params:{progressToken:'stream',progress:1}}})});}};
  Object.defineProperty(window,'HypergolicHost',{value:{addEventListener(_t:string,h:(e:{data:string})=>void){listeners.add(h);},removeEventListener(_t:string,h:(e:{data:string})=>void){listeners.delete(h);},postMessage(raw:string){const value=JSON.parse(raw);
   if(value.type==='artifact.read'){send({type:'artifact.chunk',sessionId:generation,sequence:0,base64:btoa(html),byteLength:html.length,totalBytes:html.length,publisher:pubkey,appId:'owned-cvm',eventId:'2'.repeat(64),htmlHash:hash,version,domains:granted?['cvm']:['theme'],done:true});return;}
   if(value.type!=='cvm')return;requests.push(value);const row=JSON.parse(value.message);
   if(row.type==='cvm.request'){const mcp=JSON.parse(row.message);if(mcp.method==='hold'){held.push(value);return;}const result=mcp.method==='resources/read'?{contents:[{uri:'a',text:'one'},{uri:'b',mimeType:'text/plain',blob:'dHdv'}]}:mcp.method==='tools/list'?{tools:[{name:'owned'}]}:{accepted:true};reply(value,{type:'cvm.request.result',id:row.id,...(mcp.method!==undefined&&mcp.id!==undefined?{message:{jsonrpc:'2.0',id:mcp.id,result}}:{})});}
   else reply(value,{type:row.type+'.result',id:row.id,...(row.type==='cvm.registry.has'?{has:false}:row.type==='cvm.close'?{}:{error:'unsupported method'})});
  }}});
 },{generation,pubkey,html,hash,version:digest(hash+' /index.html\n'),granted});
 await page.goto(`/assets/runtime/index.html?source=published&sessionId=${generation}`);await expect(page.frameLocator('#napplet').getByText('CVM fixture')).toBeVisible();
 const guest=await(await page.locator('#napplet').elementHandle())!.contentFrame();if(!guest)throw Error('missing guest');await guest.evaluate(async()=>{await(window as any).napplet.shell.ready();});return guest;
}
test('injected CVM wrappers preserve MCP bytes/typed IDs and all Resource contents in private native lane',async({page})=>{
 const guest=await open(page);const result=await guest.evaluate(async pubkey=>{
  const api=(window as any).napplet.cvm,server={pubkey};
  async function check(name:string,action:()=>Promise<unknown>){try{return await action();}catch(error){throw Error(name+': '+(error as Error).message);}}
  return {tools:await check('tools',()=>api.listTools(server)),resources:await check('resources',()=>api.readResource(server,'owned://all')),
   raw:await check('raw',()=>api.request(server,{jsonrpc:'2.0',id:-2,method:'owned',params:{temperature:0.5,text:'\ud800'}})),
   notification:await check('notification',()=>api.request(server,{jsonrpc:'2.0',method:'notifications/owned'})),has:await check('registry',()=>api.registry.has({family:'owned'}))};
 },pubkey);
 expect(result).toEqual({tools:[{name:'owned'}],resources:[{uri:'a',text:'one'},{uri:'b',mimeType:'text/plain',blob:'dHdv'}],raw:{jsonrpc:'2.0',id:-2,result:{accepted:true}},notification:null,has:false});
 const rows=await page.evaluate(()=>(window as any).__cvm.requests.map((row:any)=>JSON.parse(row.message)));
 expect(rows[2].message).toContain('"id":-2');expect(JSON.parse(rows[2].message).params).toEqual({temperature:0.5,text:'\ud800'});expect(rows.every((r:any)=>!('scope'in r)&&!('token'in r))).toBe(true);
});
test('120s operation survives ordinary30s; server callbacks require genuine parent delivery',async({page})=>{
 const guest=await open(page);await page.clock.install();
 await guest.evaluate(pubkey=>{const api=(window as any).napplet.cvm;(window as any).__events=[];api.onEvent((event:unknown)=>(window as any).__events.push(event));(window as any).__legacy=[];api.onEvent((server:unknown,message:unknown)=>(window as any).__legacy.push({server,message}));(window as any).__held=api.request({pubkey},{jsonrpc:'2.0',id:'held',method:'hold'},{timeoutMs:120000});(window as any).__done=false;(window as any).__held.then(()=>{(window as any).__done=true;});},pubkey);
 await expect.poll(()=>page.evaluate(()=>(window as any).__cvm.held.length)).toBe(1);await page.clock.runFor(31000);expect(await guest.evaluate(()=>(window as any).__done)).toBe(false);
 await guest.evaluate(()=>{window.dispatchEvent(new MessageEvent('message',{source:parent,data:{type:'cvm.event',server:{pubkey:'bad'},message:{}}}));});expect(await guest.evaluate(()=>(window as any).__events.length)).toBe(0);
 await page.evaluate(()=>{(window as any).__cvm.event();(window as any).__cvm.finish();});await expect.poll(()=>guest.evaluate(()=>(window as any).__done)).toBe(true);expect(await guest.evaluate(()=>(window as any).__events.length)).toBe(1);expect(await guest.evaluate(()=>(window as any).__legacy[0].server.pubkey)).toBe(pubkey);
});
test('ungranted opaque guest has no namespace and raw CVM cannot reach native',async({page})=>{const guest=await open(page,false);expect(await guest.evaluate(()=>typeof(window as any).napplet.cvm)).toBe('undefined');await guest.evaluate(()=>parent.postMessage({type:'cvm.request',id:'forged',server:{pubkey:'4'.repeat(64)},message:{jsonrpc:'2.0',id:1,method:'ping'}},'*'));await page.waitForTimeout(50);expect(await page.evaluate(()=>(window as any).__cvm.requests)).toEqual([]);});
