import assert from 'node:assert/strict';
import {test} from 'node:test';
import {finalizeEvent} from 'nostr-tools/pure';
import {createOutboxSubscriptions} from '../../src/outbox/subscriptions.ts';
import {parseOutboxSubscribe,parseOutboxClose,type OutboxSubscriptionMessage} from '../../src/outbox/subscription-contract.ts';
import type {NativeRelayStreamPort} from '../../src/network/relay-subscriptions.ts';
import type {NativeRegistration} from '../../src/runtime/capability-protocol.ts';
import type {OutboxReadService} from '../../src/outbox/read-service.ts';
const key=new Uint8Array(32);key[31]=7;
const signed=(content:string)=>JSON.parse(JSON.stringify(finalizeEvent({kind:1,created_at:1,tags:[],content},key)));
const owner=(generation='outbox-1'):NativeRegistration=>({sessionId:generation,generation,epoch:0,user:'1'.repeat(64),publisher:'2'.repeat(64),appId:'feed-lab',version:'3'.repeat(64),instanceId:generation,fixture:'feed-lab',domains:['outbox','relay']});
const input=(subId='live',limit=1)=>({type:'outbox.subscribe',id:'request-'+subId,subId,filters:{kinds:[1],limit:8},options:{limit,timeoutMs:1000}});
const close=(subId='live')=>({type:'outbox.close',id:'close-'+subId,subId});
const flush=()=>new Promise(resolve=>setTimeout(resolve,5));
function harness(relays=['wss://one.nostr.net']) {
  let sequence=0,active=true,routes=relays;
  const calls:{url:string;sub:string;id:string;stopped:number;frame:(text:string)=>void}[]=[],messages:OutboxSubscriptionMessage[]=[],plans:{refresh:boolean;signal:AbortSignal}[]=[];
  const port:NativeRelayStreamPort={newInstanceId:()=>`00000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`,open(id,url,_wire,sub,frame){const call={url,sub,id,frame,stopped:0};calls.push(call);return()=>{call.stopped++;};}};
  const reads:OutboxReadService={async query(){throw Error('wrong service');},async plan(_input,user,signal,assertActive,refresh){assert.equal(user,owner().user);assertActive();plans.push({refresh:!!refresh,signal});return {relays:routes,source:'cache',missingAuthors:[],incomplete:false};}};
  const manager=createOutboxSubscriptions(port,reads),session=manager.session({registration:owner(),assertActive(){if(!active)throw Error('identity changed');}});
  const send=(message:OutboxSubscriptionMessage)=>{messages.push(message);return true;};
  const event=(index:number,content:string)=>calls[index]!.frame(JSON.stringify(['EVENT',calls[index]!.sub,signed(content)]));
  const eose=(index:number)=>calls[index]!.frame(JSON.stringify(['EOSE',calls[index]!.sub]));
  return {manager,session,reads,calls,messages,plans,send,event,eose,setRoutes(value:string[]){routes=value;},setActive(value:boolean){active=value;}};
}
test('Outbox subscription parsers preserve bounded options and reject authority, encrypted kinds and forged close fields',()=> {
  const request=parseOutboxSubscribe(input());assert.equal(request.options.limit,1);assert.ok(Object.isFrozen(request.filters));
  assert.deepEqual(parseOutboxClose(close()),close());
  for(const patch of [{user:'1'.repeat(64)},{subId:''},{options:{relays:['wss://127.0.0.1']}},{filters:{kinds:[1059]}},{filters:{kinds:[4]}}])assert.throws(()=>parseOutboxSubscribe({...input(),...patch}));
  assert.throws(()=>parseOutboxClose({...close(),epoch:1}));
});
test('planned fanout retains every validated relay, globally caps backfill and keeps delivering after private EOSE',async()=> {
  const h=harness(['wss://one.nostr.net','wss://two.nostr.net','wss://three.nostr.net']);
  try {
    h.session.subscribe(input(),h.send,'native-token');await flush();assert.equal(h.calls.length,3);
    h.event(0,'stored');h.event(1,'stored');h.event(1,'second stored');
    assert.equal(h.messages.filter(m=>m.type==='outbox.event').length,1);
    for(let i=0;i<3;i++)h.eose(i);
    h.event(1,'future one');h.event(2,'future two');
    assert.deepEqual(h.messages.map(m=>m.type),['outbox.event','relay.eose','outbox.event','outbox.event']);
    const first=h.messages[0];assert.ok(first?.type==='outbox.event');assert.deepEqual(first.result.sidecar?.relayHints,['wss://one.nostr.net']);
    assert.ok(h.messages.every(m=>!m.type.startsWith('outbox.eose')));
  }finally{h.manager.revokeAll();}
});
test('zero stored backfill still permits future signed events including a filter with limit zero',async()=> {
  const h=harness();try {
    h.session.subscribe({...input('live',0),filters:{kinds:[1],limit:0}},h.send,'native-token');await flush();
    h.event(0,'stored');assert.equal(h.messages.length,0);h.eose(0);h.event(0,'live');
    assert.deepEqual(h.messages.map(m=>m.type),['relay.eose','outbox.event']);
  }finally{h.manager.revokeAll();}
});
test('native background stops sockets and return refreshes metadata before reconnecting new destinations under the same handle',async()=> {
  const h=harness();try {
    h.session.subscribe(input(),h.send,'native-token');await flush();h.event(0,'stored');h.eose(0);
    h.manager.setForeground(false);assert.equal(h.calls[0]!.stopped,1);h.event(0,'late background');
    h.setRoutes(['wss://replacement.nostr.net']);h.manager.setForeground(true);await flush();
    assert.equal(h.calls.length,2);assert.equal(h.calls[1]!.url,'wss://replacement.nostr.net');assert.notEqual(h.calls[0]!.id,h.calls[1]!.id);
    assert.deepEqual(h.plans.map(p=>p.refresh),[false,true]);h.event(0,'stale socket');h.event(1,'stored');h.eose(1);h.event(1,'new live');
    assert.equal(h.messages.filter(m=>m.type==='outbox.event').length,2);assert.ok(h.messages.every(m=>m.subId==='live'));
  }finally{h.manager.revokeAll();}
});
test('close, identity change and owner revoke while suspended prevent fresh discovery and reconnect',async()=> {
  for(const mode of ['close','identity','revoke']) {
    const h=harness();h.session.subscribe(input(),h.send,'native-token');await flush();h.manager.setForeground(false);
    if(mode==='close')h.session.close(close());else if(mode==='identity')h.setActive(false);else h.session.revoke();
    h.manager.setForeground(true);await flush();assert.equal(h.calls.length,1);h.manager.revokeAll();
  }
});
test('revocation during pending metadata never opens a socket; reused caller IDs and route overflow fail before transport',async()=> {
  const h=harness();let complete!:()=>void;
  h.reads.plan=async (_input,_user,_signal,active)=>{await new Promise<void>(resolve=>{complete=resolve;});active();return {relays:['wss://one.nostr.net'],source:'cache',missingAuthors:[],incomplete:false};};
  h.session.subscribe(input(),h.send,'native-token');await flush();h.session.close(close());complete();await flush();assert.equal(h.calls.length,0);
  assert.throws(()=>h.session.subscribe(input(),h.send,'native-token'));h.manager.revokeAll();
  const many=harness(Array.from({length:17},(_,i)=>`wss://relay${i}.nostr.net`));many.session.subscribe(input(),many.send,'native-token');await flush();
  assert.equal(many.calls.length,0);assert.equal(many.messages[0]?.type,'outbox.closed');many.manager.revokeAll();
});
test('initial transport timeout closes explicitly without inventing an Outbox EOSE',async()=> {
  const h=harness();try {
    h.session.subscribe({...input(),options:{limit:1,timeoutMs:25}},h.send,'native-token');await flush();await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(h.messages.at(-1)?.type,'outbox.closed');assert.equal(h.calls[0]?.stopped,1);
  }finally{h.manager.revokeAll();}
});

test('several owners share two metadata slots; close removes queued intent without opening a socket',async()=> {
  const h=harness();const resolvers:{complete:()=>void;signal:AbortSignal}[]=[];
  h.reads.plan=async (_input,_user,signal,active)=>{await new Promise<void>((resolve,reject)=>{resolvers.push({complete:resolve,signal});signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});});active();return {relays:['wss://one.nostr.net'],source:'cache',missingAuthors:[],incomplete:false};};
  const second=h.manager.session({registration:owner('outbox-2'),assertActive(){}});
  try {
    h.session.subscribe(input('first'),h.send,'token-first');h.session.subscribe(input('second'),h.send,'token-second');second.subscribe(input('queued'),h.send,'token-queued');
    await flush();assert.equal(resolvers.length,2);second.close(close('queued'));resolvers[0]!.complete();resolvers[1]!.complete();await flush();
    assert.equal(resolvers.length,2);assert.equal(h.calls.length,2);
  }finally{h.manager.revokeAll();}
});
