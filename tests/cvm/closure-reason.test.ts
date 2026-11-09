import test from 'node:test';
import assert from 'node:assert/strict';
import {createCvmNativePort,type CvmHostModule,type CvmSignerModule} from '../../src/cvm/cvm-native-port.ts';
import {CvmEndpoint,type CvmNativeSession} from '../../src/cvm/cvm-session.ts';
import {CvmError} from '../../src/cvm/cvm-contract.ts';
const key='4'.repeat(64),scope={endpoint:'source',generation:'generation',sourceRevision:'source-revision',identity:key,epoch:1,publisher:key,appId:'owned',version:key,instance:'instance'};
const server={pubkey:key},message={jsonrpc:'2.0',id:'caller',method:'tools/call',params:{name:'owned',arguments:{}}}as const;
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function composed(initialize:boolean,held=false){
 let now=0,release!:(raw:string)=>void;const callbacks=new Map<string,(value:unknown)=>void>(),calls:string[]=[],purposes:string[]=[];
 const host:CvmHostModule={takeCvmRequest:()=>null,isCvmSourceCurrent:()=>true,approveCvmRequest:()=>null,rejectCvmRequest:()=>{},finishCvmRequest:()=>{calls.push('finish');},sendCvmEvent:()=>true,synchronizeCvmRelays:()=>{}};
 const signer:CvmSignerModule={openCvmSession:async()=>{calls.push('open');return'session';},prepareCvmMessage:async(_id,_permit,purpose)=>{
  calls.push('prepare');purposes.push(purpose);return held?await new Promise<string>(resolve=>{release=resolve;}):JSON.stringify({plan:'plan',innerEventId:key});
 },commitCvmMessage:async()=>{calls.push('commit');},closeCvmSession:()=>{calls.push('close');},addListener(event,fn){callbacks.set(event,fn);return{remove(){callbacks.delete(event);}};}};
 const port=createCvmNativePort(host,signer,()=>now,()=> '00000000-0000-4000-8000-000000000001');
 const endpoint=new CvmEndpoint(scope,{now:()=>now,assertCurrent(){},review:async()=>({token:'permit'}),open:(_review,permit,signal)=>port.open(permit,signal)});
 const work=endpoint.dispatch({type:'cvm.request',id:'outer',server,message,options:{timeoutMs:1000,initialize,payment:'deny'}},1000);
 return{work,endpoint,calls,purposes,setNow(v:number){now=v;},close(){callbacks.get('onCvmClosed')?.({session:'session',error:'session closed'});},release(){release(JSON.stringify({plan:'plan',innerEventId:key}));}};
}
for(const initialize of[true,false])for(const expired of[false,true])test(`actual adapter ${initialize?'initialization':'business'} generic close ${expired?'after':'before'} original deadline`,async()=>{
 const f=composed(initialize);for(let i=0;i<5;i++)await tick();f.setNow(expired?1001:999);f.close();
 const result=await f.work;assert.equal(result?.error,expired?'relay timeout':'session closed');assert.equal(result?.message,undefined);
 assert.deepEqual(f.purposes,[initialize?'initialize':'approved']);assert.deepEqual(f.calls.slice(0,3),['open','prepare','commit']);assert.equal(f.calls.filter(v=>v==='commit').length,1);
 f.endpoint.revoke();await tick();assert.ok(f.calls.includes('finish')&&f.calls.includes('close'));
});
test('late native prepare maps elapsed original budget and never commits a late plan',async()=>{
 const f=composed(true,true);for(let i=0;i<5;i++)await tick();f.setNow(1001);f.release();const result=await f.work;
 assert.equal(result?.error,'relay timeout');assert.deepEqual(f.purposes,['initialize']);assert.equal(f.calls.includes('commit'),false);f.endpoint.revoke();await tick();assert.ok(f.calls.includes('close'));
});
for(const expired of[false,true])test(`known initialization reason survives native closure ${expired?'after':'before'} deadline`,async()=>{
 let now=0,closed:((reason?:CvmError)=>void)|undefined;const reason=new CvmError('initialization failed');
 const native:CvmNativeSession={request:async()=>new Promise(()=>{}),onEvent:()=>()=>{},onClosed(fn){closed=fn;return()=>{};},close:async()=>{}};
 const endpoint=new CvmEndpoint(scope,{now:()=>now,assertCurrent(){},review:async()=>({token:'permit'}),open:async()=>native});
 const work=endpoint.dispatch({type:'cvm.request',id:'known',server,message,options:{timeoutMs:1000,initialize:true,payment:'deny'}},1000);
 for(let i=0;i<4;i++)await tick();now=expired?1001:999;closed!(reason);const result=await work;assert.equal(result?.error,'initialization failed');endpoint.revoke();
});
test('explicit endpoint close stays session closed when synchronous native cleanup reports another reason',async()=>{
 let notify:((reason?:CvmError)=>void)|undefined;
 const native:CvmNativeSession={request:async(_p,_m,_d,signal)=>{signal.addEventListener('abort',()=>notify?.(new CvmError('provider unavailable')),{once:true});return new Promise(()=>{});},onEvent:()=>()=>{},onClosed(fn){notify=fn;return()=>{};},close:async()=>{}};
 const endpoint=new CvmEndpoint(scope,{now:()=>0,assertCurrent(){},review:async()=>({token:'permit'}),open:async()=>native});
 const work=endpoint.dispatch({type:'cvm.request',id:'explicit',server,message,options:{timeoutMs:1000,initialize:true,payment:'deny'}},1000);
 for(let i=0;i<4;i++)await tick();await endpoint.close(server);assert.equal((await work)?.error,'session closed');endpoint.revoke();
});
