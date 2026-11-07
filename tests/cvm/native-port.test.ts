import test from 'node:test';import assert from 'node:assert/strict';
import {createCvmNativePort,captureCvmIngress,captureCvmEventCarrier,type CvmHostModule,type CvmSignerModule} from '../../src/cvm/cvm-native-port.ts';
import type {CvmAuthenticated} from '../../src/cvm/cvm-client.ts';
const hash='4'.repeat(64),scope={endpoint:'source',generation:'generation',sourceRevision:'source-revision',identity:hash,epoch:1,publisher:hash,appId:'owned',version:hash,instance:'instance'};
function fixture(){
 const callbacks=new Map<string,(value:unknown)=>void>(),calls:string[]=[];let prepare:()=>Promise<string>=async()=>JSON.stringify({plan:'plan',innerEventId:hash});
 const host:CvmHostModule={takeCvmRequest:()=>null,isCvmSourceCurrent:()=>true,approveCvmRequest:()=>null,rejectCvmRequest:()=>{},finishCvmRequest:()=>{},sendCvmEvent:()=>true,synchronizeCvmRelays:()=>{}};
 const signer:CvmSignerModule={openCvmSession:async()=>{calls.push('open');return 'session';},prepareCvmMessage:async()=>{calls.push('prepare');return prepare();},commitCvmMessage:async()=>{
  calls.push('commit');callbacks.get('onCvmMessage')?.({session:'session',message:JSON.stringify({jsonrpc:'2.0',id:-3,result:{owned:true}}),eventId:'5'.repeat(64),references:[hash]});
 },closeCvmSession:()=>{calls.push('close');},addListener:(event,handler)=>{callbacks.set(event,handler);return{remove(){callbacks.delete(event);}};}};
 return{port:createCvmNativePort(host,signer),calls,callbacks,hold(value:()=>Promise<string>){prepare=value;}};
}
test('actual module adapter prepares before commit and correlates a synchronous native authenticated response',async()=>{
 const f=fixture(),session=await f.port.open({token:'permit'},new AbortController().signal);
 const result=await session.request({token:'permit'},{jsonrpc:'2.0',id:-3,method:'owned',params:{fraction:-0.5,text:'\ud800'}},Date.now()+5000,new AbortController().signal,{timeoutMs:5000,initialize:false,payment:'deny'});
 assert.deepEqual(result,{jsonrpc:'2.0',id:-3,result:{owned:true}});assert.deepEqual(f.calls,['open','prepare','commit']);await session.close();
});
test('abort while native prepare is held closes immediately; a late plan never commits',async()=>{
 const f=fixture();let release!:(raw:string)=>void;f.hold(()=>new Promise(resolve=>{release=resolve;}));const session=await f.port.open({token:'permit'},new AbortController().signal),abort=new AbortController();
 const work=session.request({token:'permit'},{jsonrpc:'2.0',id:-3,method:'owned'},Date.now()+5000,abort.signal,{timeoutMs:5000,initialize:false,payment:'deny'});
 abort.abort();await assert.rejects(work);release(JSON.stringify({plan:'late',innerEventId:hash}));await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls.includes('commit'),false);assert.equal(f.calls.includes('close'),true);
});
test('strict native ingress capture keeps exact opaque MCP and rejects authority fields/unknown profile data',()=>{
 const raw={token:'token',scope,requestId:'wire',server:{pubkey:hash},message:JSON.stringify({jsonrpc:'2.0',id:-1,method:'owned',params:{fraction:0.25,text:'\ud800'}}),operation:'owned',progressTokenJSON:null,options:{timeoutMs:120000,initialize:true,payment:'prompt'},remainingMs:119000};
 const captured=captureCvmIngress(JSON.stringify(raw),'token');assert.equal(captured.message,raw.message);assert.equal(Object.isFrozen(captured.scope),true);
 for(const bad of [{...raw,scope:{...scope,secret:'no'}},{...raw,token:'other'},{...raw,remainingMs:120001},{...raw,message:'{}'}])assert.throws(()=>captureCvmIngress(JSON.stringify(bad),'token'));
});

test('inconsistent private carrier labels/tokens never reach review or native dispatch',async()=>{
 let approvals=0,rejections=0,opens=0;
 const base={token:'token',scope,requestId:'wire',server:{pubkey:hash},message:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{_meta:{progressToken:'actual'},arguments:{text:'\ud800'}}}),operation:'tools/call',progressTokenJSON:'"actual"',options:{timeoutMs:120000,initialize:true,payment:'deny'},remainingMs:10000};
 for(const bad of [{...base,operation:'tools/list'},{...base,progressTokenJSON:'"different"'},{...base,progressTokenJSON:null}]){
  const host:CvmHostModule={takeCvmRequest:()=>JSON.stringify(bad),isCvmSourceCurrent:()=>true,approveCvmRequest:()=>{approvals++;return'permit';},rejectCvmRequest:()=>{rejections++;},finishCvmRequest:()=>{},sendCvmEvent:()=>true,synchronizeCvmRelays:()=>{}};
  const signer:CvmSignerModule={openCvmSession:async()=>{opens++;return'session';},prepareCvmMessage:async()=>'',commitCvmMessage:async()=>{},closeCvmSession:()=>{},addListener:()=>({remove(){}})};
  const {CvmService}=await import('../../src/cvm/cvm-service.ts');const service=new CvmService(createCvmNativePort(host,signer));await service.receive('token');assert.equal(service.getSnapshot().current,null);service.dispose();
 }
 assert.equal(approvals,0);assert.equal(opens,0);assert.equal(rejections,3);
});

test('opaque event carrier derives provider from independently captured event and preserves original notification bytes',()=>{
 const response=JSON.stringify({type:'cvm.event',server:{pubkey:hash},message:{jsonrpc:'2.0',method:'notifications/progress',params:{data:'\ud800',fraction:-0.5}}});
 const carrier=JSON.parse(captureCvmEventCarrier(response));assert.equal(carrier.provider,hash);assert.equal(carrier.message,response);assert.equal(JSON.parse(carrier.message).message.params.data,'\ud800');
 for(const bad of [{type:'cvm.event',provider:hash,server:{pubkey:'5'.repeat(64)},message:{jsonrpc:'2.0',method:'ping'}},{type:'cvm.event',server:{pubkey:'bad'},message:{jsonrpc:'2.0',method:'ping'}},{type:'cvm.event',server:{pubkey:hash},message:{jsonrpc:'2.0',id:null,result:{}}}])assert.throws(()=>captureCvmEventCarrier(JSON.stringify(bad)));
});
