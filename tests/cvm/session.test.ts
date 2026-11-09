import test from 'node:test';
import assert from 'node:assert/strict';
import {CvmEndpoint,type CvmNativeSession,type CvmPorts,type CvmScope,type CvmReview} from '../../src/cvm/cvm-session.ts';
import {CvmError,type McpMessage} from '../../src/cvm/cvm-contract.ts';
const scope:CvmScope=Object.freeze({endpoint:'a',generation:'g',sourceRevision:'source-revision',epoch:1,identity:'1'.repeat(64),publisher:'2'.repeat(64),appId:'owned',version:'3'.repeat(64),instance:'instance'});
const server={pubkey:'4'.repeat(64)};
const request=(id:string|number=1,options:object={})=>({type:'cvm.request',id:'envelope-'+id,server,message:{jsonrpc:'2.0',id,method:'ping',params:{_meta:{progressToken:typeof id+':'+id}}},options});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}
function setup(){
  const calls={reviews:[]as CvmReview[],opens:0,requests:0,closes:0};let current=true;
  let event:(value:unknown)=>void=()=>{};
  let closed:()=>void=()=>{};
  let run:(message:McpMessage)=>Promise<McpMessage|null>=async message=>({jsonrpc:'2.0',id:message.id!,result:{}});
  const native:CvmNativeSession={async request(_permit,message){calls.requests++;return run(message);},onEvent(handler){event=handler;return()=>{event=()=>{};};},onClosed(handler){closed=handler;return()=>{closed=()=>{};};},async close(){calls.closes++;}};
  const ports:CvmPorts={now:()=>performance.now(),assertCurrent(){if(!current)throw new CvmError('session closed');},async review(review){calls.reviews.push(review);return{token:'owned-native-test-permit'};},async open(){calls.opens++;return native;}};
  const endpoint=new CvmEndpoint(scope,ports);
  return{endpoint,ports,native,calls,event:(raw:unknown)=>event(raw),closed:()=>closed(),setRun:(next:typeof run)=>{run=next;},invalidate:()=>{current=false;}};
}
test('owned raw reply restores exactMCP and immutable request, duplicateID cannot redispatch',async()=>{
 const h=setup();const message=request();const first=await h.endpoint.dispatch(message);
 assert.deepEqual(first,{type:'cvm.request.result',id:'envelope-1',message:{jsonrpc:'2.0',id:1,result:{}}});
 assert.equal((await h.endpoint.dispatch(message))?.error,'invalid message');assert.equal(h.calls.requests,1);
 assert.equal((await h.endpoint.dispatch(request('1')))?.error,undefined);assert.equal(h.calls.requests,2);h.endpoint.revoke();
});
test('notification and server-response publication returns ACK without fabricated message',async()=>{
 const h=setup();h.setRun(async()=>null);
 for(const message of [{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:'server',result:{}}]){
  if(message.id!==undefined)h.event({jsonrpc:'2.0',id:'server',method:'ping'});
  assert.deepEqual(await h.endpoint.dispatch({...request(),message}),{type:'cvm.request.result',id:'envelope-1'});
 }
 h.endpoint.revoke();
});
test('unknown types ignored; recognized unsupported methods/has haveexactresult and no transport',async()=>{
 const h=setup();assert.equal(await h.endpoint.dispatch({type:'cvm.unknown',id:'x'}),null);
 assert.deepEqual(await h.endpoint.dispatch({type:'cvm.registry.has',id:'x',selector:{family:'owned'}}),{type:'cvm.registry.has.result',id:'x',has:false});
 assert.equal((await h.endpoint.dispatch({type:'cvm.discover',id:'x'}))?.error,'unsupported method');assert.equal(h.calls.opens,0);
});
test('server events stayendpoint-owned and handler removal does notclose session',async()=>{
 const a=setup(),b=setup(),hold=deferred<McpMessage>();a.setRun(()=>hold.promise);const seen:unknown[]=[];let foreign=0;
 const off=a.endpoint.onEvent(event=>seen.push(event));b.endpoint.onEvent(()=>foreign++);
 const pending=a.endpoint.dispatch(request());await new Promise(resolve=>setTimeout(resolve,1));
 a.event({jsonrpc:'2.0',method:'notifications/progress',params:{progressToken:'number:1',progress:1}});
 assert.equal(seen.length,1);assert.equal(foreign,0);off();assert.equal(a.calls.closes,0);
 hold.resolve({jsonrpc:'2.0',id:1,result:{}});await pending;
 a.event({jsonrpc:'2.0',method:'notifications/progress',params:{progressToken:'number:1',progress:2}});assert.equal(seen.length,1);
 a.endpoint.revoke();b.endpoint.revoke();
});
test('close settles own pending beforecloseACK; unrelated endpoint stillusable',async()=>{
 const a=setup(),b=setup(),hold=deferred<McpMessage>();a.setRun(()=>hold.promise);
 const pending=a.endpoint.dispatch(request());await new Promise(resolve=>setTimeout(resolve,1));
 const close=await a.endpoint.dispatch({type:'cvm.close',id:'close',server});
 assert.equal((await pending)?.error,'session closed');assert.deepEqual(close,{type:'cvm.close.result',id:'close'});
 assert.equal((await b.endpoint.dispatch(request()))?.error,undefined);assert.equal(a.calls.closes,1);
 hold.resolve({jsonrpc:'2.0',id:1,result:{late:true}});b.endpoint.revoke();
});
test('absolute timeout fences late result/event and new work does notreuse old ID or payload',async()=>{
 const h=setup(),hold=deferred<McpMessage>(),events:unknown[]=[];h.endpoint.onEvent(e=>events.push(e));h.setRun(()=>hold.promise);
 const result=await h.endpoint.dispatch(request(1,{timeoutMs:15}));assert.equal(result?.error,'relay timeout');
 h.event({jsonrpc:'2.0',method:'notifications/progress',params:{progressToken:'number:1',progress:1}});assert.equal(events.length,0);
 hold.resolve({jsonrpc:'2.0',id:1,result:{late:true}});h.setRun(async message=>({jsonrpc:'2.0',id:message.id!,result:{fresh:true}}));
 const fresh=await h.endpoint.dispatch(request(2));assert.deepEqual(fresh?.message,{jsonrpc:'2.0',id:2,result:{fresh:true}});
 assert.equal(result?.message,undefined);h.endpoint.revoke();
});
test('close/revoke duringuncooperative review prevents nativeopen and stale event dispatch',async()=>{
 const h=setup(),gate=deferred<{token:string}>();h.ports.review=()=>gate.promise;
 const pending=h.endpoint.dispatch(request());await h.endpoint.close(server);assert.equal((await pending)?.error,'session closed');
 gate.resolve({token:'late'});await new Promise(resolve=>setTimeout(resolve,1));assert.equal(h.calls.opens,0);h.endpoint.revoke();
});
test('payment gates never produce guest-payment event or automaticretry',async()=>{
 for(const payment of ['prompt','allow','deny']){
  const h=setup();h.setRun(async message=>({jsonrpc:'2.0',id:message.id!,error:{code:-32042,message:'payment required'}}));
  const answer=await h.endpoint.dispatch(request(1,{payment}));assert.equal(answer?.error,payment==='prompt'?'payment required':'payment denied');assert.equal(h.calls.requests,1);h.endpoint.revoke();
 }
});
test('a wrong correlation or malformed native response rejects thewholeoperation',async()=>{
 const h=setup();h.setRun(async()=>({jsonrpc:'2.0',id:'other',result:{}}));assert.equal((await h.endpoint.dispatch(request()))?.error,'invalid message');h.endpoint.revoke();
});

test('an authenticated idle server request reaches only the open endpoint and can be answered',async()=>{
 const h=setup(),seen:unknown[]=[];h.endpoint.onEvent(e=>seen.push(e));await h.endpoint.dispatch(request());
 h.event({jsonrpc:'2.0',id:'server-next',method:'ping'});assert.equal(seen.length,1);
 h.setRun(async()=>null);assert.equal((await h.endpoint.dispatch({...request(),message:{jsonrpc:'2.0',id:'server-next',result:{}}}))?.error,undefined);
 const rejected=await h.endpoint.dispatch({...request(),message:{jsonrpc:'2.0',id:'not-requested',result:{}}});assert.equal(rejected?.error,'invalid message');h.endpoint.revoke();
});
test('a notification can publish while one MCP request is pending without opening another session',async()=>{
 const h=setup(),hold=deferred<McpMessage>();h.setRun(message=>message.method==='ping'?hold.promise:Promise.resolve(null));
 const first=h.endpoint.dispatch(request());await new Promise(resolve=>setTimeout(resolve,1));
 const notice=await h.endpoint.dispatch({...request(),id:'notice',message:{jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:1}}});
 assert.deepEqual(notice,{type:'cvm.request.result',id:'notice'});assert.equal(h.calls.opens,1);
 hold.resolve({jsonrpc:'2.0',id:1,result:{}});await first;h.endpoint.revoke();
});
test('native closure aborts only dispatched work and a new call opens a new session',async()=>{
 const h=setup(),hold=deferred<McpMessage>();h.setRun(()=>hold.promise);
 const pending=h.endpoint.dispatch(request());await new Promise(resolve=>setTimeout(resolve,1));h.closed();
 assert.equal((await pending)?.error,'session closed');
 h.setRun(async message=>({jsonrpc:'2.0',id:message.id!,result:{fresh:true}}));
 assert.equal((await h.endpoint.dispatch(request(2)))?.error,undefined);assert.equal(h.calls.opens,2);
 hold.resolve({jsonrpc:'2.0',id:1,result:{late:true}});h.endpoint.revoke();
});
test('idle native closure does not cancel a pending not-yet-dispatched review',async()=>{
 const h=setup();await h.endpoint.dispatch(request());const permit=deferred<{token:string}>();h.ports.review=()=>permit.promise;
 const pending=h.endpoint.dispatch(request(2));h.closed();permit.resolve({token:'fresh-permit'});
 assert.equal((await pending)?.error,undefined);assert.equal(h.calls.opens,2);h.endpoint.revoke();
 assert.throws(()=>h.endpoint.onEvent(()=>{}),/session closed/);
});
test('failed native event registration cannot poison session reuse or skip native close',async()=>{
 const h=setup(),subscribe=h.native.onEvent;
 h.native.onEvent=()=>{throw Error('owned subscription failure');};
 assert.equal((await h.endpoint.dispatch(request()))?.error,'policy denied');assert.equal(h.calls.closes,1);
 h.native.onEvent=subscribe;assert.equal((await h.endpoint.dispatch(request(2)))?.error,undefined);assert.equal(h.calls.opens,2);h.endpoint.revoke();
});
test('unsubscribe or synchronous bridge-close failure does not suppress other native context revocation',async()=>{
 const a=setup(),b=setup();a.ports.open=async review=>review.server.pubkey==='4'.repeat(64)?a.native:b.native;
 const subscribe=a.native.onEvent;a.native.onEvent=handler=>{subscribe(handler);return()=>{throw Error('owned unsubscribe failure');};};
 await a.endpoint.dispatch(request());await a.endpoint.dispatch({...request(2),server:{pubkey:'5'.repeat(64)}});
 let firstClose=0;a.native.close=()=>{firstClose++;throw Error('owned unknown close');};
 assert.doesNotThrow(()=>a.endpoint.revoke());await new Promise(resolve=>setTimeout(resolve,1));
 assert.equal(firstClose,1);assert.equal(b.calls.closes,1);assert.equal((await a.endpoint.dispatch(request(3)))?.error,'session closed');
});

test('unmatched, foreign, malformed and internal-looking cancellations have no review/open/publication',async()=>{
 for(const target of ['never-issued','hypergolic:init',null,{},0.5]){
  const h=setup();const result=await h.endpoint.dispatch({type:'cvm.request',id:'cancel',server,message:{jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:target}},options:{initialize:false}});
  assert.equal(result?.error,'invalid message');assert.equal(h.calls.reviews.length,0);assert.equal(h.calls.opens,0);assert.equal(h.calls.requests,0);h.endpoint.revoke();
 }
 const h=setup(),gate=deferred<McpMessage|null>();h.setRun(()=>gate.promise);const work=h.endpoint.dispatch(request(1));await new Promise(resolve=>setImmediate(resolve));
 for(const [peer,id]of [[server.pubkey,'1'],['5'.repeat(64),1]]as const){const result=await h.endpoint.dispatch({type:'cvm.request',id:'foreign',server:{pubkey:peer},message:{jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:id}}});assert.equal(result?.error,'invalid message');}
 assert.equal(h.calls.reviews.length,1);assert.equal(h.calls.requests,1);gate.resolve({jsonrpc:'2.0',id:1,result:{}});await work;h.endpoint.revoke();
});
test('own active cancellation keeps exact typed payload; a target finishing during review cannot be cancelled later',async()=>{
 const h=setup(),target=deferred<McpMessage|null>();h.setRun(message=>message.method==='ping'?target.promise:Promise.resolve(null));
 const work=h.endpoint.dispatch(request('own'));await new Promise(resolve=>setImmediate(resolve));
 const cancel={type:'cvm.request',id:'cancel',server,message:{jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:'own',reason:'stop'}},options:{initialize:false}};
 assert.deepEqual(await h.endpoint.dispatch(cancel),{type:'cvm.request.result',id:'cancel'});assert.equal(h.calls.requests,2);
 const held=deferred();h.ports.review=async review=>{h.calls.reviews.push(review);await held.promise;return{token:'later-cancel'};};
 const late=h.endpoint.dispatch({...cancel,id:'late'});await new Promise(resolve=>setImmediate(resolve));target.resolve({jsonrpc:'2.0',id:'own',result:{}});await work;held.resolve();
 assert.equal((await late)?.error,'invalid message');assert.equal(h.calls.requests,2);h.endpoint.revoke();
});

test('server-side cancellation retires only an outstanding request in the server direction',async()=>{
 const h=setup(),seen:unknown[]=[];h.endpoint.onEvent(value=>seen.push(value));await h.endpoint.dispatch(request());
 h.event({jsonrpc:'2.0',id:'server',method:'owned/ask'});h.event({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:'server'}});
 const result=await h.endpoint.dispatch({type:'cvm.request',id:'reply',server,message:{jsonrpc:'2.0',id:'server',result:{late:true}}});
 assert.equal(result?.error,'invalid message');assert.equal(h.calls.reviews.length,1);assert.equal(h.calls.requests,1);assert.equal(seen.length,2);h.endpoint.revoke();
});
