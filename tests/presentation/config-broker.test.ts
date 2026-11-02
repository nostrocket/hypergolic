import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ConfigBroker} from '../../src/presentation/config-broker.ts';
import {openConfigStore, type ConfigSecureStore} from '../../src/presentation/config-store.ts';
import type {NativeRegistration} from '../../src/runtime/capability-protocol.ts';
import type {RoutingNativeState} from '../../src/routing/routing-port.ts';
import {tick} from './harness.ts';
import {bindRoutingOwner} from '../../src/routing/routing-owner.ts';
import {IdentityTransition} from '../../src/security/identity-transition.ts';
import {Integrated, pubkey} from '../security/harness.ts';
import {setup as workspaceStore, deferred} from '../storage/harness.ts';
import {initialTestWorkspace, assertBundledWorkspace} from '../../src/shell/fixtures.ts';
const schema={type:'object',properties:{theme:{type:'string',enum:['dark','light'],default:'dark'},token:{type:'string','x-napplet-secret':true},nested:{type:'object',properties:{level:{type:'integer',minimum:1,maximum:3,default:2}}}},required:['theme']};
async function setup(t:{after(fn:()=>void):void}, assertAuthority:()=>void=()=>{}) {
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
 const broker=new ConfigBroker(capability,native,store);t.after(()=>broker.stop());
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
test('schema ACK and immediate subscription wait for persisted/defaulted registration; source scope is captured',async t=>{
 const h=await setup(t);h.gate();const registered=h.dispatch({type:'config.registerSchema',id:'r',schema}),subscribed=h.dispatch({type:'config.subscribe'}),get=h.dispatch({type:'config.get',id:'g'});await tick();assert.equal(registered.reply(),undefined);assert.equal(h.sent.length,0);h.unlock();await Promise.all([registered.promise,subscribed.promise,get.promise]);assert.deepEqual(registered.reply(),{type:'config.registerSchema.result',id:'r',ok:true});assert.deepEqual(get.reply().values,{theme:'dark',nested:{level:2}});assert.deepEqual(h.sent.map(row=>row.message),[{type:'config.values',values:{theme:'dark',nested:{level:2}}}]);assert.equal(h.sent[0]!.generation,h.source.generation);
});
test('no-schema produces error without fake values; invalid schemas give canonical negative ACK and preserve previous schema',async t=>{
 const h=await setup(t),before=h.dispatch({type:'config.get',id:'before'});await before.promise;assert.equal(before.reply(),null);assert.equal(h.sent[0]!.message.code,'no-schema');await h.register();
 const bad=h.dispatch({type:'config.registerSchema',id:'bad',schema:{type:'object',properties:{token:{type:'string','x-napplet-secret':true,default:'forbidden'}}}});await bad.promise;assert.equal(bad.reply().ok,false);assert.equal(bad.reply().code,'secret-with-default');assert.deepEqual(await h.get(),{theme:'dark',nested:{level:2}});
});
test('only focused trusted commit writes; secrets remain absent from UI and deliver only after explicit save',async t=>{
 const h=await setup(t);await h.register();await h.dispatch({type:'config.subscribe'}).promise;await h.broker.open(h.source.generation);const review=h.broker.getSnapshot().review!;assert.deepEqual(review.ordinary,{theme:'dark',nested:{level:2}});assert.equal(review.secretPresent['["token"]'],false);
 await assert.rejects(h.broker.commit(review.id,{theme:'other',nested:{level:2}},{'["token"]':'public-test-token'}));assert.equal(h.broker.getSnapshot().review?.id,review.id);assert.equal((await h.get()).token,undefined);
 await h.broker.commit(review.id,{theme:'light',nested:{level:3}},{'["token"]':'public-test-token'});assert.deepEqual(await h.get(),{theme:'light',token:'public-test-token',nested:{level:3}});assert.equal(h.broker.getSnapshot().review,null);assert.equal(h.sent.at(-1)!.message.values.token,'public-test-token');
 await h.broker.open(h.source.generation);const reopened=h.broker.getSnapshot().review!;assert.equal(reopened.secretPresent['["token"]'],true);assert.equal(JSON.stringify(reopened.ordinary).includes('public-test-token'),false);await h.broker.commit(reopened.id,{theme:'light',nested:{level:3}},{'["token"]':null});assert.equal((await h.get()).token,undefined);
});
test('schema changes immediately purge orphaned secrets; fresh hashes and identities receive defaults',async t=>{
 const h=await setup(t);await h.register();await h.broker.open(h.source.generation);await h.broker.commit(h.broker.getSnapshot().review!.id,{theme:'light',nested:{level:2}},{'["token"]':'public-test-token'});
 const peer={...h.source,generation:'peer-generation',sessionId:'peer-view',instanceId:'peer-view',version:'04'.repeat(32)};await h.register(schema,1,peer);assert.deepEqual(await h.get(peer),{theme:'dark',nested:{level:2}});
 await h.register({type:'object',properties:{theme:{type:'string',default:'dark'}}},2);assert.equal([...h.records.values()].some(raw=>raw.includes('public-test-token')),false);assert.deepEqual(await h.get(),{theme:'light'});
});
test('foreground switch keeps original subscriptions; unsubscribe/close/background/identity fence delivery and editor writes',async t=>{
 const h=await setup(t);await h.register();await h.dispatch({type:'config.subscribe'}).promise;h.focus('peer');assert.deepEqual(await h.get(),{theme:'dark',nested:{level:2}});await assert.rejects(h.broker.open(h.source.generation));h.focus(h.source.generation);await h.broker.open(h.source.generation);const id=h.broker.getSnapshot().review!.id;h.lifecycle({available:false,foreground:false});assert.equal(h.broker.getSnapshot().review,null);await assert.rejects(h.broker.commit(id,{theme:'light'},{}));const count=h.sent.length;await h.dispatch({type:'config.get',id:'background'}).promise;assert.equal(h.sent.length,count);h.lifecycle({available:true,foreground:true});await h.dispatch({type:'config.unsubscribe'}).promise;await h.broker.open(h.source.generation);await h.broker.commit(h.broker.getSnapshot().review!.id,{theme:'light',nested:{level:2}},{});assert.equal(h.sent.length,count);h.close();const closed=h.dispatch({type:'config.get',id:'closed'});await closed.promise;assert.equal(closed.reply(),null);
});
test('forged scope, missing domain, guest set, private wrapper replay and unmasked secret injection cannot mutate',async t=>{
 const h=await setup(t);await h.register();for(const patch of [{publisher:'04'.repeat(32)},{domains:[]}]){const denied=h.dispatch({type:'config.get',id:'forged'},h.source,patch);await denied.promise;assert.equal(denied.reply(),null);}
 const guest=h.dispatch({type:'config.set',values:{theme:'forged'}});await guest.promise;assert.equal(guest.reply(),null);assert.equal((await h.get()).theme,'dark');const first=h.dispatch({type:'config.get',id:'first'},h.source,{},'same'),second=h.dispatch({type:'config.get',id:'second'},h.source,{},'same');await Promise.all([first.promise,second.promise]);assert.equal(second.reply(),null);
 await h.broker.open(h.source.generation);await assert.rejects(h.broker.commit(h.broker.getSnapshot().review!.id,{theme:'light',token:'unmasked'},{}));assert.equal((await h.get()).token,undefined);
});

test('revoked subscribed peer cannot turn a confirmed own save into failure or receive secret values',async t=>{
 const h=await setup(t),peer={...h.source,generation:'same-scope-peer',sessionId:'same-scope-view',instanceId:'same-scope-view'};
 await h.register();await h.register(schema,1,peer);await h.dispatch({type:'config.subscribe'},peer).promise;h.revoke(peer.generation);
 await h.broker.open(h.source.generation);await h.broker.commit(h.broker.getSnapshot().review!.id,{theme:'light',nested:{level:2}},{'["token"]':'public-test-token'});
 assert.equal(h.broker.getSnapshot().review,null);assert.equal((await h.get()).token,'public-test-token');assert.equal(h.sent.filter(row=>row.generation===peer.generation).length,1);
});
test('duplicate Save is rejected while the native write is pending; only the first scoped write completes',async t=>{
 const h=await setup(t);await h.register();await h.broker.open(h.source.generation);const id=h.broker.getSnapshot().review!.id;h.gate();
 const first=h.broker.commit(id,{theme:'light',nested:{level:2}},{});await tick();await assert.rejects(h.broker.commit(id,{theme:'dark',nested:{level:3}},{}),(error:any)=>error.code==='BUSY');
 h.unlock();await first;assert.deepEqual(await h.get(),{theme:'light',nested:{level:2}});
});

test('rejected registrations deliver one canonical schema error to their captured requester and preserve ACK, values and peer isolation',async t=>{
 const h=await setup(t),peer={...h.source,generation:'schema-error-peer',sessionId:'schema-error-peer-view',instanceId:'schema-error-peer-view'};
 await h.register();await h.register(schema,1,peer);await h.dispatch({type:'config.subscribe'}).promise;await h.dispatch({type:'config.subscribe'},peer).promise;h.sent.length=0;
 const cases=[{code:'secret-with-default',schema:{type:'object',properties:{token:{type:'string','x-napplet-secret':true,default:'forbidden-public-default'}}}},{code:'pattern-not-allowed',schema:{type:'object',properties:{name:{type:'string',pattern:'^(a|a)*$'}}}}];
 for(const [index,invalid] of cases.entries()){
  const bad=h.dispatch({type:'config.registerSchema',id:'bad-schema-'+index,schema:invalid.schema});await bad.promise;const reply=bad.reply();
  assert.equal(reply.type,'config.registerSchema.result');assert.equal(reply.id,'bad-schema-'+index);assert.equal(reply.ok,false);assert.equal(reply.code,invalid.code);
  assert.deepEqual(h.sent,[{generation:h.source.generation,message:{type:'config.schemaError',code:invalid.code,error:reply.error}}]);
  assert.deepEqual(await h.get(),{theme:'dark',nested:{level:2}});assert.deepEqual(await h.get(peer),{theme:'dark',nested:{level:2}});h.sent.length=0;
 }
 const forged=h.dispatch({type:'config.registerSchema',id:'forged-schema',schema:cases[0]!.schema},h.source,{publisher:'04'.repeat(32)});await forged.promise;assert.equal(forged.reply(),null);assert.deepEqual(h.sent,[]);
 h.revoke(h.source.generation);const revoked=h.dispatch({type:'config.registerSchema',id:'revoked-schema',schema:cases[0]!.schema});await revoked.promise;assert.equal(revoked.reply(),null);assert.deepEqual(h.sent,[]);
});

test('cancelled saved identity selection retains configuration schema, values and subscription; confirmed selection revokes them',async t=>{
 const protectedStore=new Integrated();t.after(()=>protectedStore.sqlite.cleanup());
 const native=await protectedStore.owner();await native.vault.open();await native.vault.importNsec('nsec1fixture-2');await native.vault.select(pubkey(1));
 const storage=await workspaceStore(t);
 const identity=await IdentityTransition.open({vault:native.vault,database:storage.database,seed:initialTestWorkspace,assertAvailable:assertBundledWorkspace});
 const authority=identity.sessionAuthority(),h=await setup(t,authority.assertActive);t.after(bindRoutingOwner(identity,h));
 await h.register();await h.dispatch({type:'config.subscribe'}).promise;
 await h.broker.open(h.source.generation);
 const saved={theme:'light',nested:{level:3},token:'public-cancel-regression'};
 await h.broker.commit(h.broker.getSnapshot().review!.id,{theme:'light',nested:{level:3}},{'["token"]':saved.token});
 assert.deepEqual(await h.get(),saved);assert.equal(h.sent.length,2);
 const revision=h.state().revision,session=identity.getSnapshot().session;
 // Native Settings removes review focus independently of live endpoint ownership.
 h.focus('');await assert.rejects(h.broker.open(h.source.generation));
 const pending=identity.prepareSelect(pubkey(2));assert(pending);authority.assertActive();
 identity.cancel(pending);h.focus(h.source.generation);
 assert.deepEqual(await h.get(),saved);
 assert.equal(identity.getSnapshot().session,session);assert.equal(h.state().ownerAvailable,true);assert.equal(h.state().revision,revision);
 assert.equal(h.sent.length,2);
 // No schema re-registration or subscription retry is allowed to mask cancellation loss.
 await h.broker.open(h.source.generation);await h.broker.commit(h.broker.getSnapshot().review!.id,{theme:'dark',nested:{level:2}},{});
 assert.deepEqual(h.sent.map(row=>row.message),[
  {type:'config.values',values:{theme:'dark',nested:{level:2}}},
  {type:'config.values',values:saved},
  {type:'config.values',values:{theme:'dark',nested:{level:2},token:saved.token}},
 ]);
 const selected=identity.prepareSelect(pubkey(2));assert(selected);const switching=identity.confirm(selected);
 assert.equal(identity.getSnapshot().phase,'switching');assert.equal(h.state().ownerAvailable,false);
 assert.throws(authority.assertActive,{code:'STALE'});
 const blocked=h.dispatch({type:'config.get',id:'during-switch'});await blocked.promise;assert.equal(blocked.reply(),null);
 await switching;assert.equal(h.state().user,pubkey(2));assert.equal(h.state().epoch,session.epoch+1);assert.equal(h.state().ownerAvailable,true);
 assert.equal(await h.get(),undefined);assert.equal(h.sent.length,3);
});

test('expired native openSettings cannot present an editor after its pending storage read',async t=>{
 const h=await setup(t);await h.register();const gate=h.pauseRead();
 const request=h.dispatch({type:'config.openSettings'});
 try {await gate.entered;assert.equal(h.broker.getSnapshot().review,null);h.expire(request.token);}
 finally {gate.release();}
 await request.promise;assert.equal(request.reply(),null);assert.equal(h.broker.getSnapshot().review,null);
 const fresh=h.dispatch({type:'config.openSettings'});await fresh.promise;assert.ok(h.broker.getSnapshot().review);
});

test('two concurrent trusted editor opens preserve one review and its Save identity',async t=>{
 const h=await setup(t);await h.register();const gate=h.pauseRead(),reviews:string[]=[];
 const unsubscribe=h.broker.subscribe(()=>{const review=h.broker.getSnapshot().review;if(review)reviews.push(review.id);});t.after(unsubscribe);
 const first=h.broker.open(h.source.generation),second=h.broker.open(h.source.generation);
 try {await gate.entered;assert.equal(h.broker.getSnapshot().review,null);}finally{gate.release();}
 await Promise.all([first,second]);assert.equal(reviews.length,1);
 const review=h.broker.getSnapshot().review!;assert.equal(review.id,reviews[0]);
 await h.broker.commit(review.id,{theme:'light',nested:{level:3}},{});
 assert.deepEqual(await h.get(),{theme:'light',nested:{level:3}});
});

test('losing and regaining focus while opening cannot revive the earlier editor request',async t=>{
 const h=await setup(t);await h.register();const gate=h.pauseRead();
 const pending=h.broker.open(h.source.generation);const cancelled=assert.rejects(pending,{code:'REVOKED'});
 try {await gate.entered;h.focus('other-generation');h.focus(h.source.generation);}finally{gate.release();}
 await cancelled;assert.equal(h.broker.getSnapshot().review,null);
 await h.broker.open(h.source.generation);assert.ok(h.broker.getSnapshot().review);
});

test('a cancelled opening cannot release or overwrite a fresh opening after focus returns',async t=>{
 const h=await setup(t);await h.register();const gate=h.pauseRead();
 const first=h.broker.open(h.source.generation);const cancelled=assert.rejects(first,{code:'REVOKED'});
 await gate.entered;h.focus('other-generation');h.focus(h.source.generation);
 const fresh=h.broker.open(h.source.generation);gate.release();
 await Promise.all([cancelled,fresh]);assert.ok(h.broker.getSnapshot().review);
 const id=h.broker.getSnapshot().review!.id;await h.broker.commit(id,{theme:'light',nested:{level:3}},{});
 assert.deepEqual(await h.get(),{theme:'light',nested:{level:3}});
});

for (const fault of ['background', 'identity', 'close', 'stop'] as const) {
 test('pending editor cannot survive ' + fault + ' even when its storage read completes',async t=>{
  const h=await setup(t);await h.register();const gate=h.pauseRead();
  const pending=h.broker.open(h.source.generation),cancelled=assert.rejects(pending,{code:'REVOKED'});
  try {
   await gate.entered;
   if(fault==='background'){h.lifecycle({available:false,foreground:false});h.lifecycle({available:true,foreground:true});}
   else if(fault==='identity')h.synchronizeRoutingOwner('05'.repeat(32),1,true);
   else if(fault==='close')h.close();
   else h.broker.stop();
  }finally{gate.release();}
  await cancelled;assert.equal(h.broker.getSnapshot().review,null);assert.equal(h.sent.length,0);
 });
}

test('failed protected storage read releases editor ownership and preserves a later valid open',async t=>{
 const h=await setup(t);await h.register();const before=new Map(h.records);
 for(const key of h.records.keys())h.records.set(key,'malformed-config-record');
 await assert.rejects(h.broker.open(h.source.generation),{code:'CORRUPT_STORAGE'});
 assert.equal(h.broker.getSnapshot().review,null);
 for(const [key,value] of before)h.records.set(key,value);
 await h.broker.open(h.source.generation);const review=h.broker.getSnapshot().review!;
 assert.deepEqual(review.ordinary,{theme:'dark',nested:{level:2}});
 await h.broker.commit(review.id,{theme:'light',nested:{level:3}},{});
 assert.deepEqual(await h.get(),{theme:'light',nested:{level:3}});
});

test('native focus loss and return cancel a pending editor even before lifecycle events arrive',async t=>{
 const h=await setup(t);await h.register();const gate=h.pauseRead();
 const pending=h.broker.open(h.source.generation),cancelled=assert.rejects(pending,{code:'REVOKED'});
 try{await gate.entered;h.focus('other-generation',false);h.focus(h.source.generation,false);}finally{gate.release();}
 await cancelled;assert.equal(h.broker.getSnapshot().review,null);
 await h.broker.open(h.source.generation);assert.ok(h.broker.getSnapshot().review);
});

test('an existing editor cannot save after a native focus round trip with delayed events',async t=>{
 const h=await setup(t);await h.register();await h.dispatch({type:'config.subscribe'}).promise;
 await h.broker.open(h.source.generation);const id=h.broker.getSnapshot().review!.id;
 h.focus('other-generation',false);h.focus(h.source.generation,false);
 await assert.rejects(h.broker.commit(id,{theme:'light',nested:{level:3}},{}),{code:'REVOKED'});
 assert.equal(h.broker.getSnapshot().review,null);assert.deepEqual(await h.get(),{theme:'dark',nested:{level:2}});
 await h.broker.open(h.source.generation);await h.broker.commit(h.broker.getSnapshot().review!.id,{theme:'light',nested:{level:3}},{});
 assert.deepEqual(h.sent.map(row=>row.message.values),[{theme:'dark',nested:{level:2}},{theme:'light',nested:{level:3}}]);
});

test('expired subscribe cannot push its pending initial values',async t=>{
 const h=await setup(t);await h.register();const gate=h.pauseRead();
 const request=h.dispatch({type:'config.subscribe'});
 try{await gate.entered;h.expire(request.token);}finally{gate.release();}
 await request.promise;assert.equal(request.reply(),null);assert.equal(h.sent.length,0);
 const fresh=h.dispatch({type:'config.subscribe'});await fresh.promise;
 assert.deepEqual(h.sent.map(row=>row.message.values),[{theme:'dark',nested:{level:2}}]);
});

test('expired subscribe cannot retain a new subscription for a later secret Save',async t=>{
 const h=await setup(t);await h.register();const gate=h.pauseRead();
 const request=h.dispatch({type:'config.subscribe'});
 try{await gate.entered;h.expire(request.token);}finally{gate.release();}
 await request.promise;h.sent.length=0;
 await h.broker.open(h.source.generation);await h.broker.commit(h.broker.getSnapshot().review!.id,{theme:'light',nested:{level:3}},{'["token"]':'public-test-token'});
 assert.equal(h.sent.length,0);assert.equal((await h.get()).token,'public-test-token');
});

test('expired get cannot push a schema error after its pending validation read',async t=>{
 const h=await setup(t);await h.register({type:'object',properties:{name:{type:'string'}},required:['name']});
 const gate=h.pauseRead(),request=h.dispatch({type:'config.get',id:'expired-get'});
 try{await gate.entered;h.expire(request.token);}finally{gate.release();}
 await request.promise;assert.equal(request.reply(),null);assert.equal(h.sent.length,0);
 const fresh=h.dispatch({type:'config.get',id:'fresh-get'});await fresh.promise;assert.equal(h.sent.length,1);assert.equal(h.sent[0]!.message.code,'invalid-schema');
});

test('a failed subscribe read does not install a subscription after storage recovers',async t=>{
 const h=await setup(t);await h.register();const before=new Map(h.records);
 for(const key of h.records.keys())h.records.set(key,'malformed-config-record');
 const failed=h.dispatch({type:'config.subscribe'});await failed.promise;assert.equal(failed.reply(),null);
 for(const [key,value] of before)h.records.set(key,value);
 await h.broker.open(h.source.generation);await h.broker.commit(h.broker.getSnapshot().review!.id,{theme:'light',nested:{level:3}},{});
 assert.equal(h.sent.length,0);assert.deepEqual(await h.get(),{theme:'light',nested:{level:3}});
});

test('an expired repeated subscribe preserves only the previously admitted subscription',async t=>{
 const h=await setup(t);await h.register();await h.dispatch({type:'config.subscribe'}).promise;h.sent.length=0;
 const gate=h.pauseRead(),request=h.dispatch({type:'config.subscribe'});
 try{await gate.entered;h.expire(request.token);}finally{gate.release();}
 await request.promise;assert.equal(h.sent.length,0);
 await h.broker.open(h.source.generation);await h.broker.commit(h.broker.getSnapshot().review!.id,{theme:'light',nested:{level:3}},{});
 assert.deepEqual(h.sent.map(row=>row.message.values),[{theme:'light',nested:{level:3}}]);
});

test('expired schema registration cannot push values after its completed scoped write',async t=>{
 const h=await setup(t);await h.register();await h.dispatch({type:'config.subscribe'}).promise;h.sent.length=0;
 const gate=h.pauseRead(2),request=h.dispatch({type:'config.registerSchema',id:'next-schema',schema:{type:'object',properties:{theme:{type:'string',default:'light'}}},version:2});
 try{await gate.entered;h.expire(request.token);}finally{gate.release();}
 await request.promise;assert.equal(request.reply(),null);assert.equal(h.sent.length,0);
 assert.deepEqual(await h.get(),{theme:'dark'});
 await h.broker.open(h.source.generation);await h.broker.commit(h.broker.getSnapshot().review!.id,{theme:'light'},{});
 assert.deepEqual(h.sent.map(row=>row.message.values),[{theme:'light'}]);
});

test('a live subscription before schema registration receives later admitted schema values',async t=>{
 const h=await setup(t);const request=h.dispatch({type:'config.subscribe'});await request.promise;
 assert.equal(h.sent.length,1);assert.equal(h.sent[0]!.message.code,'no-schema');h.sent.length=0;
 await h.register();assert.deepEqual(h.sent.map(row=>row.message.values),[{theme:'dark',nested:{level:2}}]);
});

test('a failed repeated subscribe leaves its previously admitted subscription intact',async t=>{
 const h=await setup(t);await h.register();await h.dispatch({type:'config.subscribe'}).promise;h.sent.length=0;
 const before=new Map(h.records);for(const key of h.records.keys())h.records.set(key,'malformed-config-record');
 const failed=h.dispatch({type:'config.subscribe'});await failed.promise;assert.equal(failed.reply(),null);
 for(const [key,value] of before)h.records.set(key,value);
 await h.broker.open(h.source.generation);await h.broker.commit(h.broker.getSnapshot().review!.id,{theme:'light',nested:{level:3}},{});
 assert.deepEqual(h.sent.map(row=>row.message.values),[{theme:'light',nested:{level:3}}]);
});

test('unsubscribe during a pending broadcast prevents values and schema errors after admission ends',async t=>{
 const h=await setup(t);await h.register();await h.dispatch({type:'config.subscribe'}).promise;h.sent.length=0;
 await h.broker.open(h.source.generation);const gate=h.pauseRead(2);
 const saved=h.broker.commit(h.broker.getSnapshot().review!.id,{theme:'light',nested:{level:3}},{});
 try{await gate.entered;await h.dispatch({type:'config.unsubscribe'}).promise;}finally{gate.release();}
 await saved;assert.equal(h.sent.length,0);assert.deepEqual(await h.get(),{theme:'light',nested:{level:3}});
 await h.dispatch({type:'config.subscribe'}).promise;assert.deepEqual(h.sent.map(row=>row.message.values),[{theme:'light',nested:{level:3}}]);
});
