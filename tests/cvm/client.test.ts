import test from 'node:test';
import assert from 'node:assert/strict';
import {CvmMcpClient,type CvmBytePort,type CvmAuthenticated,type CvmPurpose} from '../../src/cvm/cvm-client.ts';
import {captureMcp,CvmError,type McpMessage,type CvmOptions} from '../../src/cvm/cvm-contract.ts';
import {CvmEndpoint,type CvmScope} from '../../src/cvm/cvm-session.ts';
const options:CvmOptions={timeoutMs:1000,initialize:true,payment:'prompt'};
const permit={token:'owned-test-permit'};
let permitSequence=0;
const message=captureMcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'owned',arguments:{ratio:-1.5},_meta:{progressToken:'stream'}}});
const id=(n:number)=>n.toString(16).padStart(64,'0');
function setup(nonce?:()=>string){
 let listener:(value:CvmAuthenticated)=>void=()=>{},closed:()=>void=()=>{},sequence=0;
 const calls:{purpose:CvmPurpose;message:McpMessage;replyTo:string|null;id:string}[]=[];let closes=0;
 let respond=(purpose:CvmPurpose,row:McpMessage,eventId:string)=>{
  if(purpose==='initialize')listener({eventId:id(500),references:[eventId],paymentInteraction:'explicit_gating',message:{jsonrpc:'2.0',id:row.id,result:{protocolVersion:'2025-06-18',capabilities:{}}}});
  else if(purpose==='approved'&&row.method!==undefined&&row.id!==undefined)listener({eventId:id(501),references:[eventId],message:{jsonrpc:'2.0',id:row.id,result:{ok:true}}});
 };
 const port:CvmBytePort={async publish(_permit,purpose,row,replyTo,_deadline,_signal,prepared,acknowledged){const eventId=id(++sequence);calls.push({purpose,message:row,replyTo,id:eventId});prepared(eventId);respond(purpose,row,eventId);acknowledged();},onMessage(handler){listener=handler;return()=>{listener=()=>{};};},onClosed(handler){closed=handler;return()=>{closed=()=>{};};},async close(){closes++;}};
 const client=new CvmMcpClient(port,()=>performance.now(),nonce);
 return{client,port,calls,emit:(value:CvmAuthenticated)=>listener(value),nativeClose:()=>closed(),setRespond:(next:typeof respond)=>{respond=next;},closes:()=>closes};
}
const request=(h:ReturnType<typeof setup>,next=message,policy=options,ms=1000)=>h.client.request({token:permit.token+'-'+(++permitSequence)},next,performance.now()+ms,new AbortController().signal,policy);
test('MCP init/initialized precede approved bytes and e-only early reply is correctly correlated',async()=>{
 const h=setup();const result=await request(h);assert.deepEqual(result,{jsonrpc:'2.0',id:1,result:{ok:true}});
 assert.deepEqual(h.calls.map(call=>call.purpose),['initialize','initialized','approved']);
 assert.equal(h.calls[0].message.params?.protocolVersion,'2025-06-18');assert.deepEqual(h.calls[0].message.params?.capabilities,{});
 assert.equal(h.calls[2].message.params?.arguments&&Object.isFrozen(h.calls[2].message.params.arguments),true);
 await h.client.close();assert.equal(h.closes(),1);
});
test('actual ordered CEP41 start/chunk/close does not replace final RPC; controls use scoped purpose',async()=>{
 const h=setup(),seen:unknown[]=[];h.client.onEvent(value=>seen.push(value));
 h.setRespond((purpose,row,eventId)=>{
  if(purpose!=='approved')return;
  for(const [progress,frame] of [[1,{frameType:'start'}],[2,{frameType:'chunk',chunkIndex:0,data:'owned'}],[3,{frameType:'close',lastChunkIndex:0}]] as const)
   h.emit({eventId:id(500+progress),references:[eventId],message:{jsonrpc:'2.0',method:'notifications/progress',params:{progressToken:'stream',progress,cvm:{type:'open-stream',...frame}}}});
  h.emit({eventId:id(504),references:[eventId],message:{jsonrpc:'2.0',id:row.id,result:{done:true}}});
 });
 assert.deepEqual(await request(h,message,{...options,initialize:false}),{jsonrpc:'2.0',id:1,result:{done:true}});
 assert.equal(seen.length,3);assert.equal(h.calls.filter(call=>call.purpose==='stream-control').length,1);await h.client.close();
});
test('authenticated server requests keep exact inner e reference for separately reviewed response',async()=>{
 const h=setup();await request(h);h.emit({eventId:id(700),references:[],message:{jsonrpc:'2.0',id:'server',method:'ping'}});
 assert.equal(await request(h,captureMcp({jsonrpc:'2.0',id:'server',result:{}})),null);
 assert.equal(h.calls.at(-1)?.replyTo,id(700));await h.client.close();
});
test('wrong response reference closes adapter rather than accepting server signed wrong invocation',async()=>{
 const h=setup();h.setRespond((purpose,row)=>{if(purpose==='approved')h.emit({eventId:id(700),references:[id(999)],message:{jsonrpc:'2.0',id:row.id,result:{}}});});
 await assert.rejects(request(h,message,{...options,initialize:false}),/invalid message/);await h.client.close();assert.equal(h.closes(),1);
});
test('early transparent payment gate is correlated and later invocation uses its own payment policy',async()=>{
 const h=setup();await request(h,message,{...options,initialize:false,payment:'deny'});
 h.setRespond((purpose,row,eventId)=>{if(purpose==='approved')h.emit({eventId:id(700),references:[eventId],message:{jsonrpc:'2.0',method:'notifications/payment_required',params:{amount:1,pmi:'owned',pay_req:'opaque'}}});});
 await assert.rejects(request(h,captureMcp({...message,id:2}),{...options,initialize:false,payment:'prompt'}),/payment required/);
 await assert.rejects(request(h,captureMcp({...message,id:3}),{...options,initialize:false,payment:'allow'}),/session closed/);
 assert.equal(h.calls.length,2);await h.client.close();assert.equal(h.closes(),1);
 const fresh=setup();fresh.setRespond((purpose,row,eventId)=>{if(purpose==='approved')fresh.emit({eventId:id(700),references:[eventId],message:{jsonrpc:'2.0',id:row.id,error:{code:-32042,message:'Payment Required'}}});});
 await assert.rejects(request(fresh,message,{...options,initialize:false,payment:'allow'}),/payment denied/);await fresh.client.close();
});
test('uncooperative native publish cannot extend timeout; stale reply cannot finish fresh RPC',async()=>{
 const h=setup(),base=h.port.publish;let release!:()=>void;
 h.port.publish=()=>new Promise(resolve=>{release=resolve;});
 await assert.rejects(request(h,message,{...options,initialize:false},15),/relay timeout/);release();
 h.port.publish=base;await assert.rejects(request(h,captureMcp({...message,id:2}),{...options,initialize:false}),/session closed/);
 const fresh=setup();assert.equal((await request(fresh,captureMcp({...message,id:2}),{...options,initialize:false}))?.id,2);
 h.emit({eventId:id(799),references:[id(1)],message:{jsonrpc:'2.0',id:1,result:{late:true}}});await h.client.close();await fresh.client.close();assert.equal(h.closes(),1);
});
test('native closure immediately ends notification publication, and uncertain close is never retried',async()=>{
 const h=setup();h.port.publish=()=>new Promise(()=>{});let closes=0;
 h.port.close=async()=>{closes++;throw Error('owned unknown drain');};
 const pending=request(h,captureMcp({jsonrpc:'2.0',method:'notifications/owned'}),{...options,initialize:false});h.nativeClose();
 await assert.rejects(pending,/session closed/);await assert.rejects(h.client.close(),/unknown drain/);await assert.rejects(h.client.close(),/unknown drain/);assert.equal(closes,1);
});
test('accepted signed final reply survives immediate transport close without renewing source authority',async()=>{
 const h=setup();h.setRespond((purpose,row,eventId)=>{if(purpose==='approved'){
  h.emit({eventId:id(799),references:[eventId],message:{jsonrpc:'2.0',id:row.id,result:{finished:true}}});h.nativeClose();
 }});
 assert.deepEqual(await request(h,message,{...options,initialize:false}),{jsonrpc:'2.0',id:1,result:{finished:true}});
 await h.client.close();assert.equal(h.closes(),1);
});
test('prepared identity precedes commit and notification ACK remains decisive before close',async()=>{
 const h=setup(),base=h.port.publish;
 h.port.publish=async(p,purpose,row,replyTo,deadline,signal,prepared,acknowledged)=>{
  await base(p,purpose,row,replyTo,deadline,signal,prepared,()=>{acknowledged();h.nativeClose();});
 };
 assert.equal(await request(h,captureMcp({jsonrpc:'2.0',method:'notifications/owned'}),{...options,initialize:false}),null);
 await h.client.close();assert.equal(h.closes(),1);
});
test('endpoint accepts an already authenticated final before channel close, while still fencing stale source',async()=>{
 for(const invalidate of [false,true]){
  const h=setup();let current=true;
  const scope:CvmScope={endpoint:'owned',generation:'generation',epoch:1,identity:'a'.repeat(64),publisher:'b'.repeat(64),appId:'owned',version:'c'.repeat(64),instance:'instance'};
  const endpoint=new CvmEndpoint(scope,{now:()=>performance.now(),assertCurrent(){if(!current)throw new CvmError('session closed');},async review(){return{token:'owned-integrated-permit'};},async open(){return h.client;}});
  h.setRespond((purpose,row,eventId)=>{if(purpose==='approved'){
   h.emit({eventId:id(799),references:[eventId],message:{jsonrpc:'2.0',id:row.id,result:{finished:true}}});if(invalidate)current=false;h.nativeClose();
  }});
  const reply=await endpoint.dispatch({type:'cvm.request',id:'owned',server:{pubkey:'d'.repeat(64)},message,options:{initialize:false}});
  if(invalidate){assert.equal(reply?.error,'session closed');assert.equal(reply?.message,undefined);}
  else assert.deepEqual(reply?.message,{jsonrpc:'2.0',id:1,result:{finished:true}});
  endpoint.revoke();await h.client.close();
 }
});

test('initialization uses non-authority nonce IDs, avoids caller collision and preserves caller payload',async()=>{
 const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];let index=0;
 const h=setup(()=>ids[index++]!);const caller='hypergolic:init:'+ids[0];
 const original=captureMcp({jsonrpc:'2.0',id:caller,method:'owned'}),result=await request(h,original);
 assert.equal(h.calls[0].message.id,'hypergolic:init:'+ids[1]);assert.deepEqual(h.calls[2].message,original);assert.equal(result?.id,caller);assert.equal(JSON.stringify(h.calls).includes('owned-test-permit'),false);await h.client.close();
 const old=setup();const oldResult=await request(old,captureMcp({jsonrpc:'2.0',id:'hypergolic:init',method:'owned'}));assert.equal(oldResult?.id,'hypergolic:init');assert.notEqual(old.calls[0].message.id,'hypergolic:init');await old.client.close();
});
test('actual MCP client rejects cancellation of init and only publishes cancellation for an active approved request',async()=>{
 const h=setup();let initialization:{row:McpMessage;eventId:string}|null=null;
 h.setRespond((purpose,row,eventId)=>{if(purpose==='initialize')initialization={row,eventId};});
 const main=request(h);await new Promise(resolve=>setImmediate(resolve));assert.ok(initialization);
 const init=initialization as unknown as {row:McpMessage;eventId:string};
 for(const requestId of [init.row.id,'never-issued'])await assert.rejects(request(h,captureMcp({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:requestId!}}),{...options,initialize:false}));
 assert.equal(h.calls.length,1);
 h.emit({message:{jsonrpc:'2.0',id:init.row.id!,result:{protocolVersion:'2025-06-18',capabilities:{}}},eventId:id(700),references:[init.eventId]});await new Promise(resolve=>setImmediate(resolve));
 const business=h.calls.find(row=>row.purpose==='approved'&&row.message.method==='tools/call')!;assert.ok(business);
 const cancelled=await request(h,captureMcp({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:1,reason:'owned'}}),{...options,initialize:false});assert.equal(cancelled,null);
 h.emit({message:{jsonrpc:'2.0',id:1,result:{done:true}},eventId:id(701),references:[business.id]});await main;
 const count=h.calls.length;await assert.rejects(request(h,captureMcp({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:1}}),{...options,initialize:false}));assert.equal(h.calls.length,count);await h.client.close();
});
