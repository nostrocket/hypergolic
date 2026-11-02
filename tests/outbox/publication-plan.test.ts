import assert from 'node:assert/strict';
import {test} from 'node:test';
import {finalizeEvent,getPublicKey} from 'nostr-tools/pure';
import {parseOutboxPublish,outboxPublishFailure} from '../../src/outbox/publication-contract.ts';
import {createOutboxPublicationPlanner} from '../../src/outbox/publication-plan.ts';
import {parseOutboxRelayList} from '../../src/outbox/relay-list.ts';
import type {OutboxAuthorResolver,OutboxAuthorResolution} from '../../src/outbox/author-resolver.ts';
const ownKey=new Uint8Array(32).fill(37),recipientKey=new Uint8Array(32).fill(38),user=getPublicKey(ownKey),recipient=getPublicKey(recipientKey);
function list(key:Uint8Array,tags:string[][]){const author=getPublicKey(key);return parseOutboxRelayList(JSON.parse(JSON.stringify(finalizeEvent({kind:10002,created_at:1,content:'',tags},key))),author);}
const own=list(ownKey,[['r','wss://own.nostr.net','write'],['r','wss://ownread.nostr.net','read']]);
const inbox=list(recipientKey,[['r','wss://inbox.nostr.net','read'],['r','wss://recipientwrite.nostr.net','write']]);
const event={kind:1,created_at:2,content:'review exactly',tags:[['p',recipient]]};
const request={type:'outbox.publish',id:'publish-1',event};
const signal=()=>new AbortController().signal;
function setup(resolve:OutboxAuthorResolver['resolve']=async(_user,author)=>({list:author===user?own:inbox,source:'cache',incomplete:false}),policy:'lookup'|'omit'='omit',timeoutMs=15000){
 const calls:string[]=[],network=['wss://fallback.nostr.net'];
 const planner=createOutboxPublicationPlanner({async resolve(...args){calls.push(args[1]);assert.equal(args[2],'publication');return resolve(...args);}},()=>({networkRelays:network,lookupRelays:['wss://lookup.nostr.net']}),{ancillaryWhenOutboxSkipped:policy},timeoutMs);
 return {planner,calls,network};
}
test('publication parser freezes exact template/options and never infers p-tag inbox recipients',()=>{
 const input={...request,event:{...event,tags:event.tags.map(tag=>[...tag])},options:{toInboxes:[recipient,recipient],relays:['wss://explicit.nostr.net']}};
 const parsed=parseOutboxPublish(input,user);input.event.tags[0]![1]='f'.repeat(64);input.event.content='changed';input.options.relays[0]='wss://changed.nostr.net';
 assert.deepEqual(parsed.options.toInboxes,[recipient]);assert.equal(parsed.event.content,event.content);assert.equal(parsed.event.tags[0]?.[1],recipient);assert.deepEqual(parsed.options.relays,['wss://explicit.nostr.net']);
 assert.ok(Object.isFrozen(parsed.event.tags[0]));assert.deepEqual(parseOutboxPublish(request,user).options.toInboxes,[]);
});
test('malformed publication options, guest authority, auth events and accessors fail before resolution',async()=>{
 const h=setup();let invoked=false;
 for(const input of [{...request,user},{...request,options:{toOutbox:1}},{...request,options:{toInboxes:[recipient.slice(1)]}},{...request,options:{relays:['wss://127.0.0.1']}},{...request,options:{relays:Array(1)}},{...request,event:{...event,pubkey:user}},{...request,event:{...event,kind:22242}},{...request,event:{...event,kind:24242}},{...request,options:{get relays(){invoked=true;return [];}}}])await assert.rejects(h.planner.plan(input,user,signal(),()=>{}));
 assert.equal(invoked,false);assert.equal(h.calls.length,0);
 assert.deepEqual(outboxPublishFailure(request,'required inbox unavailable'),{type:'outbox.publish.result',id:request.id,ok:false,error:'required inbox unavailable'});
});
test('complete own writes, required inbox reads and explicit union receive immutable source labels and separate exact ancillary event',async()=>{
 const h=setup(),plan=await h.planner.plan({...request,options:{toInboxes:[recipient],relays:['wss://own.nostr.net','wss://explicit.nostr.net']}},user,signal(),()=>{});
 assert.deepEqual(plan.event.destinations,['wss://own.nostr.net/','wss://inbox.nostr.net/','wss://explicit.nostr.net/']);assert.deepEqual(plan.requiredInboxes,['wss://inbox.nostr.net/']);
 assert.deepEqual(plan.destinations[0]?.sources,[{kind:'own',author:user},{kind:'explicit'}]);assert.equal(plan.ownSource,'nip65');assert.deepEqual(plan.ancillary,own.event);assert.notEqual(plan.ancillary?.id,plan.event.hash);assert.ok(Object.isFrozen(plan.ancillary?.tags));
});
test('missing or incomplete required inbox blocks review effects even when own/explicit destinations exist',async()=>{
 for(const result of [null,{list:inbox,source:'nip65' as const,incomplete:true},{list:list(recipientKey,[]),source:'cache' as const,incomplete:false}]){
  let signer=0,send=0;const h=setup(async(_u,author)=>{if(author===user)return {list:own,source:'cache',incomplete:false};if(!result)throw Error('offline');return result;});
  await assert.rejects(h.planner.plan({...request,options:{toInboxes:[recipient],relays:['wss://explicit.nostr.net']}},user,signal(),()=>{}).then(()=>{signer++;send++;}),/required inbox unavailable/);assert.equal(signer,0);assert.equal(send,0);
 }
});
test('required fanout overflow is a failure before review and is never silently truncated',async()=>{
 const many=list(recipientKey,Array.from({length:16},(_,i)=>['r',`wss://relay${i}.nostr.net`,'read']));const h=setup(async(_u,author)=>({list:author===user?own:many,source:'cache',incomplete:false}));
 await assert.rejects(h.planner.plan({...request,options:{toInboxes:[recipient]}},user,signal(),()=>{}),/policy denied/);
});
test('missing own list uses labelled Network fallback and does not invent an ancillary list',async()=>{
 const h=setup(async()=>{throw Error('offline');}),plan=await h.planner.plan(request,user,signal(),()=>{});
 assert.equal(plan.ownSource,'network-fallback');assert.deepEqual(plan.event.destinations,['wss://fallback.nostr.net/']);assert.deepEqual(plan.destinations[0]?.sources,[{kind:'network-fallback',author:user}]);assert.equal(plan.ancillary,null);
});
test('signed empty own list revokes older destinations and can be reviewed exactly with Network fallback',async()=>{
 const empty=list(ownKey,[]),h=setup(async()=>({list:empty,source:'cache',incomplete:false})),plan=await h.planner.plan(request,user,signal(),()=>{});
 assert.equal(plan.ownSource,'network-fallback');assert.deepEqual(plan.ancillary,empty.event);assert.deepEqual(plan.event.destinations,['wss://fallback.nostr.net/']);
});
test('explicit-only publication has no own routing requirement; app-only ancillary policy controls extra discovery',async()=>{
 const input={...request,options:{toOutbox:false,relays:['wss://explicit.nostr.net']}};
 for(const policy of ['omit','lookup'] as const){const h=setup(undefined,policy),plan=await h.planner.plan(input,user,signal(),()=>{});assert.equal(plan.ownSource,'skipped');assert.deepEqual(plan.event.destinations,['wss://explicit.nostr.net/']);assert.deepEqual(h.calls,policy==='omit'?[]:[user]);assert.equal(plan.ancillary?.id??null,policy==='omit'?null:own.event.id);}
});
test('skipping own outbox does not bypass a required inbox for the selected identity',async()=>{
 const h=setup(),plan=await h.planner.plan({...request,options:{toOutbox:false,toInboxes:[user]}},user,signal(),()=>{});
 assert.deepEqual(h.calls,[user]);assert.deepEqual(plan.requiredInboxes,['wss://ownread.nostr.net/']);assert.equal(plan.ancillary,null);assert.equal(plan.ownSource,'skipped');
});
test('empty explicit-only union and unavailable own fallback fail instead of pretending publication targets',async()=>{
 const h=setup(async()=>({list:null,source:'cache',incomplete:false}));
 await assert.rejects(h.planner.plan({...request,options:{toOutbox:false}},user,signal(),()=>{}),/no publication destinations/);h.network.length=0;
 await assert.rejects(h.planner.plan({...request,options:{relays:['wss://explicit.nostr.net']}},user,signal(),()=>{}),/own fallback unavailable/);
});
test('mutation while resolving cannot change captured event, options or fallback settings',async()=>{
 let finish!:(r:OutboxAuthorResolution)=>void;const h=setup(async()=>new Promise(resolve=>{finish=resolve;}));
 const input={...request,event:{...event,tags:event.tags.map(tag=>[...tag])},options:{relays:['wss://explicit.nostr.net']}};const pending=h.planner.plan(input,user,signal(),()=>{});
 input.event.content='changed';input.event.tags[0]![1]='f'.repeat(64);input.options.relays[0]='wss://changed.nostr.net';h.network[0]='wss://changed.nostr.net';finish({list:null,source:'nip65',incomplete:false});const plan=await pending;
 assert.equal(plan.event.event.content,event.content);assert.equal(plan.event.event.tags[0]?.[1],recipient);assert.deepEqual(plan.event.destinations,['wss://fallback.nostr.net/','wss://explicit.nostr.net/']);
});
test('discovered list is authenticated again before review; mutable resolver output cannot alter ancillary event',async()=>{
 const bad=JSON.parse(JSON.stringify(own));bad.event.content='forged';const h=setup(async()=>({list:bad,source:'cache',incomplete:false}));await assert.rejects(h.planner.plan(request,user,signal(),()=>{}));
});
test('total deadline and abort prevent late resolution from producing a review',async()=>{
 let finish!:(r:OutboxAuthorResolution)=>void;const h=setup(async()=>new Promise(resolve=>{finish=resolve;}),'omit',10);await assert.rejects(h.planner.plan(request,user,signal(),()=>{}),/cancelled/);finish({list:own,source:'cache',incomplete:false});
 const aborted=new AbortController();aborted.abort();await assert.rejects(h.planner.plan(request,user,aborted.signal,()=>{}),/cancelled/);
});
test('owner revocation after discovery prevents immutable review creation',async()=>{
 let active=true;const h=setup(async()=>{active=false;return {list:own,source:'cache',incomplete:false};});await assert.rejects(h.planner.plan(request,user,signal(),()=>{if(!active)throw Error('revoked');}),/revoked/);
});
test('metadata resolution uses at most two workers and rejects a third concurrent publication plan',async()=>{
 let pending=0,maximum=0;const authors=Array.from({length:7},(_,i)=>getPublicKey(new Uint8Array(32).fill(i+40)));
 const h=setup(async()=>{pending++;maximum=Math.max(maximum,pending);await new Promise(resolve=>setTimeout(resolve,3));pending--;return {list:null,source:'cache',incomplete:false};});
 await assert.rejects(h.planner.plan({...request,options:{toInboxes:authors}},user,signal(),()=>{}));assert.equal(maximum,2);assert.equal(h.calls.length,8);
 const slow=setup(async()=>new Promise(()=>{}),'omit',10);const first=slow.planner.plan(request,user,signal(),()=>{}),second=slow.planner.plan(request,user,signal(),()=>{});await assert.rejects(slow.planner.plan(request,user,signal(),()=>{}),/busy/);await Promise.all([assert.rejects(first),assert.rejects(second)]);
});

test('8 KiB EVENT frame boundary counts signature overhead, escaping and UTF-8 before discovery',async()=>{
 const base={kind:1,created_at:2,content:'',tags:[]},signed=finalizeEvent({...base,tags:[]},ownKey);
 const overhead=Buffer.byteLength(JSON.stringify(['EVENT',signed]));
 const exact={...request,event:{...base,content:'x'.repeat(8192-overhead)}};
 assert.equal(Buffer.byteLength(JSON.stringify(['EVENT',finalizeEvent({...exact.event,tags:[]},ownKey)])),8192);
 const h=setup();await h.planner.plan(exact,user,signal(),()=>{});
 for(const content of [exact.event.content+'x','🌱'.repeat(2100),'\\'.repeat(4200)]){
  const denied=setup();await assert.rejects(denied.planner.plan({...request,event:{...base,content}},user,signal(),()=>{}),/publication frame too large/);assert.deepEqual(denied.calls,[]);
 }
});
test('oversized existing signed relay list blocks review rather than silently dropping approved redistribution',async()=>{
 const event=finalizeEvent({kind:10002,created_at:1,content:'x'.repeat(8192),tags:[['r','wss://own.nostr.net','write']]},ownKey);
 const big=parseOutboxRelayList(JSON.parse(JSON.stringify(event)),user),h=setup(async()=>({list:big,source:'cache',incomplete:false}));
 await assert.rejects(h.planner.plan(request,user,signal(),()=>{}),/publication frame too large/);
});
