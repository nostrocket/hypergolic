import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent } from 'nostr-tools/pure';
import { createRelaySubscriptions, type NativeRelayStreamPort } from '../../src/network/relay-subscriptions.ts';
import { parseRelaySubscribe, parseRelayClose, SUBSCRIPTION_LIMITS, type RelaySubscriptionMessage } from '../../src/network/relay-subscription-contract.ts';
import type { NativeRegistration } from '../../src/runtime/capability-protocol.ts';

const secret=new Uint8Array(32);secret[31]=1;
const signed=(content='known',kind=1)=>JSON.parse(JSON.stringify(finalizeEvent({kind,created_at:100,content,tags:[]},secret)));
const request=(subId='caller')=>({type:'relay.subscribe',id:'request-'+subId,subId,filters:[{kinds:[1],limit:2}]});
const close=(subId='caller')=>({type:'relay.close',id:'close-'+subId,subId});
const registration=(generation='generation-1'):NativeRegistration=>({sessionId:generation,generation,epoch:0,user:'1'.repeat(64),publisher:'2'.repeat(64),appId:'feed-lab',version:'3'.repeat(64),instanceId:generation,fixture:'feed-lab',domains:['relay']});
function harness(relays=['wss://one.example.org']) {
  let sequence=0,clock=0;
  const calls:{id:string;url:string;wire:string;sub:string;frame:(text:string)=>void;failed:()=>void;stopped:number}[]=[];
  const port:NativeRelayStreamPort={newInstanceId:()=>`00000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`,
    open(id,url,wire,sub,frame,failed){const call={id,url,wire,sub,frame,failed,stopped:0};calls.push(call);return()=>{call.stopped++;};}};
  const manager=createRelaySubscriptions(port,()=>relays,{now:()=>clock,retryMs:[1,1,1,1,1]});
  let active=true;
  const messages:RelaySubscriptionMessage[]=[];
  const session=manager.session({registration:registration(),assertActive(){if(!active)throw new Error('identity changed');}});
  const send=(message:RelaySubscriptionMessage)=>{messages.push(message);return true;};
  const event=(index=0,value=signed())=>calls[index]!.frame(JSON.stringify(['EVENT',calls[index]!.sub,value]));
  const eose=(index=0)=>calls[index]!.frame(JSON.stringify(['EOSE',calls[index]!.sub]));
  return {manager,session,messages,calls,send,event,eose,setActive:(value:boolean)=>{active=value;},tick:(value:number)=>{clock=value;}};
}
test('selected subscription and close parse exact canonical fields with immutable core filters',()=> {
  const value=parseRelaySubscribe({...request(),relay:'wss://one.example.org'});
  assert.equal(value.subId,'caller');assert.ok(Object.isFrozen(value.filters[0]!.kinds));
  assert.deepEqual(parseRelayClose(close()),close());
  for(const wire of [{...request(),user:'forged'},{...request(),subId:''},{...request(),filters:[{search:'extended'}]},
    {...request(),relay:'wss://127.0.0.1'},{...request(),filters:[{kinds:[4]}]},{...request(),filters:[{kinds:[1059]}]}])assert.throws(()=>parseRelaySubscribe(wire));
  assert.throws(()=>parseRelaySubscribe({...request(),get filters(){throw new Error('Getter executed');}}));
  assert.throws(()=>parseRelayClose({...close(),filters:[]}));
});
test('stored and live verified events retain caller subId; EOSE does not close or impose initial limit on live delivery',()=> {
  const h=harness();h.session.subscribe(request(),h.send);
  assert.deepEqual(JSON.parse(h.calls[0]!.wire),['REQ',h.calls[0]!.sub,{kinds:[1],limit:2}]);
  assert.notEqual(h.calls[0]!.sub,'caller');
  h.event();h.eose();h.event(0,signed('live'));h.event(0,signed('later'));
  assert.deepEqual(h.messages.map(m=>m.type),['relay.event','relay.eose','relay.event','relay.event']);
  assert.ok(h.messages.every(m=>m.subId==='caller'));assert.equal(h.calls[0]!.stopped,0);
});
test('multi-relay duplicate events merge and aggregate EOSE waits for initial outcomes',()=> {
  const h=harness(['wss://one.example.org','wss://two.example.org']);h.session.subscribe(request(),h.send);
  h.event(0);h.event(1);h.eose(0);assert.equal(h.messages.filter(m=>m.type==='relay.eose').length,0);
  h.eose(1);h.eose(1);assert.deepEqual(h.messages.map(m=>m.type),['relay.event','relay.eose']);
});
test('invalid signature, signed mismatch and foreign subscription fail closed',()=> {
  for(const mode of ['signature','filter','foreign']) {
    const h=harness();h.session.subscribe(request(),h.send);
    if(mode==='signature')h.event(0,{...signed(),sig:'0'.repeat(128)});
    else if(mode==='filter')h.event(0,signed('wrong',2));
    else h.calls[0]!.frame(JSON.stringify(['EVENT','foreign',signed()]));
    assert.deepEqual(h.messages,[{type:'relay.closed',subId:'caller',reason:'invalid or excessive relay stream'}]);
    assert.equal(h.calls[0]!.stopped,1);h.event();h.eose();assert.equal(h.messages.length,1);
  }
});
test('explicit close invalidates callbacks before stopping and rejects caller-ID reuse',()=> {
  const h=harness();h.session.subscribe(request(),h.send);h.session.close(close());
  h.event();h.eose();h.calls[0]!.failed();assert.deepEqual(h.messages,[]);assert.equal(h.calls[0]!.stopped,1);
  assert.throws(()=>h.session.subscribe(request(),h.send));
});
test('native owner revocation or rejected native push ends work without stale lifecycle delivery',()=> {
  const h=harness();h.session.subscribe(request(),h.send);h.setActive(false);h.event();h.eose();
  assert.deepEqual(h.messages,[]);assert.equal(h.calls[0]!.stopped,1);
  const rejected=harness();rejected.session.subscribe(request(),()=>false);rejected.event();
  assert.equal(rejected.calls[0]!.stopped,1);rejected.event();assert.deepEqual(rejected.messages,[]);
});
test('background stops sockets, retains intent, resumes with new IDs and deduplicated recent history',()=> {
  const h=harness();h.session.subscribe(request(),h.send);h.event();h.eose();
  h.manager.setForeground(false);assert.equal(h.calls[0]!.stopped,1);h.event(0,signed('late'));assert.equal(h.messages.length,2);
  h.manager.setForeground(true);assert.equal(h.calls.length,2);assert.notEqual(h.calls[0]!.id,h.calls[1]!.id);
  h.event(0,signed('old connection'));h.event(1);h.event(1,signed('new'));h.eose(1);
  assert.deepEqual(h.messages.map(m=>m.type),['relay.event','relay.eose','relay.event','relay.eose']);
  assert.equal((h.messages[2] as {result:{event:{content:string}}}).result.event.content,'new');
});
test('close and identity change while suspended remove intent before foreground reconnect',()=> {
  for(const mode of ['close','identity','revoke']) {
    const h=harness();h.session.subscribe(request(),h.send);h.manager.setForeground(false);
    if(mode==='close')h.session.close(close());else if(mode==='identity')h.setActive(false);else h.session.revoke();
    h.manager.setForeground(true);assert.equal(h.calls.length,1);assert.deepEqual(h.messages,[]);
  }
});
test('equal caller IDs across native sessions remain isolated and process/session bounds recover after revoke',()=> {
  const h=harness();h.session.subscribe(request(),h.send);h.session.subscribe(request('second'),h.send);
  assert.throws(()=>h.session.subscribe(request('third'),h.send));
  for(let index=2;index<=4;index++) {
    const session=h.manager.session({registration:registration('generation-'+index),assertActive(){}});
    session.subscribe(request(),()=>true);session.subscribe(request('second'),()=>true);
  }
  const fifth=h.manager.session({registration:registration('generation-5'),assertActive(){}});
  assert.throws(()=>fifth.subscribe(request(),()=>true));
  h.session.revoke();fifth.subscribe(request(),()=>true);
  assert.equal(h.calls.length,SUBSCRIPTION_LIMITS.process+1);
  assert.throws(()=>h.manager.session({registration:registration('generation-5'),assertActive(){}}));
  h.manager.revokeAll();assert.ok(h.calls.every(call=>call.stopped===1));
});
test('scoped destinations must be in trusted snapshot and pool selection stays bounded',()=> {
  const h=harness(['wss://one.example.org','wss://two.example.org','wss://three.example.org']);
  assert.throws(()=>h.session.subscribe({...request(),relay:'wss://untrusted.example.org'},h.send));assert.equal(h.calls.length,0);
  h.session.subscribe({...request(),relay:'wss://two.example.org'},h.send);assert.equal(h.calls[0]!.url,'wss://two.example.org');
  h.session.subscribe(request('pool'),h.send);assert.equal(h.calls.length,3);
});
test('frame/byte flood is terminal; rate windows are bounded and no invalid event is rendered',()=> {
  for(const mode of ['frames','bytes']) {
    const h=harness();h.session.subscribe(request(),h.send);
    if(mode==='frames')for(let i=0;i<=SUBSCRIPTION_LIMITS.framesPerSecond;i++)h.calls[0]!.frame(JSON.stringify(['NOTICE','bounded']));
    else h.calls[0]!.frame('x'.repeat(67*1024));
    assert.deepEqual(h.messages.map(m=>m.type),['relay.closed']);assert.equal(h.calls[0]!.stopped,1);
  }
  const h=harness();h.session.subscribe(request(),h.send);
  for(let i=0;i<64;i++)h.calls[0]!.frame(JSON.stringify(['NOTICE','bounded']));
  h.tick(1000);h.event();assert.deepEqual(h.messages.map(m=>m.type),['relay.event']);
});
test('disconnect retries are bounded and explicit close prevents pending retry or late failure reopening',async()=> {
  const h=harness();h.session.subscribe(request(),h.send);
  for(let i=0;i<=SUBSCRIPTION_LIMITS.retries;i++) {h.calls[i]!.failed();if(i<SUBSCRIPTION_LIMITS.retries)await new Promise(resolve=>setTimeout(resolve,5));}
  assert.equal(h.calls.length,6);assert.deepEqual(h.messages,[{type:'relay.closed',subId:'caller',reason:'relay connection failed'}]);
  const stopped=harness();stopped.session.subscribe(request(),stopped.send);stopped.calls[0]!.failed();stopped.session.close(close());
  await new Promise(resolve=>setTimeout(resolve,5));assert.equal(stopped.calls.length,1);assert.deepEqual(stopped.messages,[]);
});


test('optional AUTH announcements do not close or authenticate a public stream and retain frame quotas', () => {
  const h = harness(); h.session.subscribe(request(), h.send);
  h.calls[0]!.frame(JSON.stringify(['AUTH', 'first']));
  h.calls[0]!.frame(JSON.stringify(['AUTH', 'rotated']));
  assert.equal(h.messages.length, 0); assert.equal(h.calls[0]!.stopped, 0);
  h.event(); h.eose();
  assert.deepEqual(h.messages.map(m => m.type), ['relay.event', 'relay.eose']);
  assert.equal(h.calls.length, 1); assert.equal(JSON.parse(h.calls[0]!.wire)[0], 'REQ');
  h.session.close(close());
  const flood = harness(); flood.session.subscribe(request(), flood.send);
  for (let i = 0; i <= SUBSCRIPTION_LIMITS.framesPerSecond; i++) flood.calls[0]!.frame(JSON.stringify(['AUTH', 'challenge']));
  assert.deepEqual(flood.messages, [{type:'relay.closed',subId:'caller',reason:'invalid or excessive relay stream'}]);
  assert.equal(flood.calls[0]!.stopped, 1);
});
