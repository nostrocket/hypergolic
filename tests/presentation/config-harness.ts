import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ConfigBroker} from '../../src/presentation/config-broker.ts';
import {openConfigStore, type ConfigSecureStore} from '../../src/presentation/config-store.ts';
import type {NativeRegistration} from '../../src/runtime/capability-protocol.ts';
import type {RoutingNativeState} from '../../src/routing/routing-port.ts';
import type {ReviewSlot} from '../../src/shell/review-slot.ts';
import {deferred} from '../storage/harness.ts';

export const schema={type:'object',properties:{theme:{type:'string',enum:['dark','light'],default:'dark'},token:{type:'string','x-napplet-secret':true},nested:{type:'object',properties:{level:{type:'integer',minimum:1,maximum:3,default:2}}}},required:['theme']};
export async function setup(t:{after(fn:()=>void):void}, assertAuthority:()=>void=()=>{}, slot?: ReviewSlot) {
 const source:NativeRegistration={user:'01'.repeat(32),publisher:'02'.repeat(32),appId:'configuration-source',version:'03'.repeat(32),epoch:0,sessionId:'source-view',generation:'source-generation',instanceId:'source-view',fixture:'published',domains:['config']};
 let state:RoutingNativeState={user:source.user,epoch:0,revision:1,available:true,ownerAvailable:true,foreground:true},focus=source.generation,counter=0,listener=()=>{};
 const reviewCounters=new Map<string,number>([[source.generation,1]]);
 const revoked=new Set<string>(),slots=new Map<string,string>(),live=new Set<string>(),replies=new Map<string,any>(),sent:{generation:string;message:any}[]=[],records=new Map<string,string>();
 let gate:Promise<void>|null=null,unlock=()=>{};
 const readGate:{current:{entered():void;wait:Promise<void>;remaining:number}|null}={current:null};
 const backend:ConfigSecureStore={isAvailableAsync:async()=>true,getItemAsync:async key=>{const paused=readGate.current;if(paused){if(paused.remaining>0)paused.remaining--;else{paused.entered();await paused.wait;}}return records.get(key)??null;},setItemAsync:async(key,value)=>{if(gate)await gate;records.set(key,value);}};
 const store=await openConfigStore(backend,async text=>createHash('sha256').update(text).digest('hex'),9);
 const native={reviewRevision(generation:string,revision:number){return this.mayReview(generation,revision)?reviewCounters.get(generation)??0:null;},state:()=>state,mayDeliver:(generation:string,revision:number,domain:string)=>state.available&&state.revision===revision&&domain==='config'&&!revoked.has(generation),mayReview:(generation:string,revision:number)=>state.available&&state.revision===revision&&focus===generation&&!revoked.has(generation),send(generation:string,revision:number,message:any){if(!this.mayDeliver(generation,revision,'config'))return false;sent.push({generation,message});return true;},subscribe(fn:()=>void){listener=fn;return()=>{};},newChannelId:()=>''};
 const capability={take(token:string){const value=slots.get(token)??null;slots.delete(token);return value;},isActive:(token:string)=>live.has(token),finish(token:string,result:string|null){live.delete(token);replies.set(token,result===null?null:JSON.parse(result).response);}};
 const broker=new ConfigBroker(capability,native,store,slot);t.after(()=>broker.stop());
 function dispatch(message:unknown,registration=source,patch:Partial<NativeRegistration>={},wrapperId?:string){const token='token-'+ ++counter;live.add(token);slots.set(token,JSON.stringify({registration:{...registration,...patch},request:JSON.stringify({type:'routing.call',id:wrapperId??'call-'+counter,message,revision:state.revision})}));return{token,promise:broker.dispatch(token,{registration,assertActive(){assertAuthority();if(revoked.has(registration.generation))throw Error('Revoked');}}),reply:()=>replies.get(token)};}
 async function register(value:unknown=schema,version=1,registration=source){const request=dispatch({type:'config.registerSchema',id:'register-'+ ++counter,schema:value,version},registration);await request.promise;assert.equal(request.reply().ok,true);}
 async function get(registration=source){const request=dispatch({type:'config.get',id:'get-'+ ++counter},registration);await request.promise;return request.reply()?.values;}
 return {broker,source,store,records,sent,dispatch,register,get,state:()=>state,
 expire(token:string){live.delete(token);},
 pauseRead(afterReads=0){const entered=deferred(),released=deferred();readGate.current={entered:entered.resolve,wait:released.promise,remaining:afterReads};return{entered:entered.promise,release(){readGate.current=null;released.resolve();}};},
 synchronizeRoutingOwner(user:string,epoch:number,available:boolean){
  if(state.user===user&&state.epoch===epoch&&state.ownerAvailable===available)return;
  state={...state,user,epoch,ownerAvailable:available,available:available&&state.foreground,revision:state.revision+1};listener();
 },gate(){gate=new Promise(resolve=>{unlock=resolve;});},unlock(){gate=null;unlock();},focus(value:string,refresh=true){if(focus!==value){reviewCounters.set(focus,(reviewCounters.get(focus)??0)+1);reviewCounters.set(value,(reviewCounters.get(value)??0)+1);focus=value;}if(refresh)broker.refresh();},lifecycle(patch:Partial<RoutingNativeState>){state={...state,...patch,revision:state.revision+1};listener();},revoke(generation:string){revoked.add(generation);},close(){revoked.add(source.generation);broker.close(source.generation);}};
}
