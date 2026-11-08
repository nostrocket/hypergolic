import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent } from 'nostr-tools/pure';
import { createRelaySubscriptions, type NativeRelayStreamPort } from '../../src/network/relay-subscriptions.ts';
import { parseRelaySubscribe, parseRelayClose, SUBSCRIPTION_LIMITS, type RelaySubscriptionMessage } from '../../src/network/relay-subscription-contract.ts';
import type { NativeRegistration } from '../../src/runtime/capability-protocol.ts';

const secret=new Uint8Array(32);secret[31]=1;
const signed=(content='known',kind=1,tags:string[][]=[])=>JSON.parse(JSON.stringify(finalizeEvent({kind,created_at:100,content,tags},secret)));
const request=(subId='caller')=>({type:'relay.subscribe',id:'request-'+subId,subId,filters:[{kinds:[1],limit:2}]});
const close=(subId='caller')=>({type:'relay.close',id:'close-'+subId,subId});
const registration=(generation='generation-1'):NativeRegistration=>({sessionId:generation,generation,epoch:0,user:'1'.repeat(64),publisher:'2'.repeat(64),appId:'feed-lab',version:'3'.repeat(64),instanceId:generation,fixture:'feed-lab',domains:['relay']});
function harness(relays=['wss://one.example.org'], owner = registration(), domain: 'relay' | 'outbox' = 'relay') {
  let sequence=0,clock=0;
  const calls:{id:string;url:string;wire:string;sub:string;frame:(text:string)=>void;failed:()=>void;stopped:number}[]=[];
  const port:NativeRelayStreamPort={newInstanceId:()=>`00000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`,
    open(id,url,wire,sub,frame,failed){const call={id,url,wire,sub,frame,failed,stopped:0};calls.push(call);return()=>{call.stopped++;};}};
  const manager=createRelaySubscriptions(port,()=>relays,{domain,now:()=>clock,retryMs:[1,1,1,1,1]});
  let active=true;
  const messages:RelaySubscriptionMessage[]=[];
  const session=manager.session({registration:owner,assertActive(){if(!active)throw new Error('identity changed');}});
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
test('wide signed-guest filter shapes are bounded before native subscription', () => {
  const h = harness();
  const author = 'a'.repeat(64);
  const filters = [
    { kinds: [1, 1111, 7, 6, 16, 9735], '#p': [author], limit: 200 },
    { kinds: [1111], '#P': [author], limit: 200 },
  ];
  h.session.subscribe({ ...request(), filters }, h.send);
  assert.deepEqual(JSON.parse(h.calls[0]!.wire).slice(2), filters.map(filter => ({ ...filter, limit: 32 })));
  assert.deepEqual(filters.map(filter => filter.limit), [200, 200]);
  h.eose();
  assert.deepEqual(h.messages, [{ type: 'relay.eose', subId: 'caller' }]);
  h.session.revoke();
});
test('multi-relay duplicate events merge and aggregate EOSE waits for initial outcomes',()=> {
  const h=harness(['wss://one.example.org','wss://two.example.org']);h.session.subscribe(request(),h.send);
  h.event(0);h.event(1);h.eose(0);assert.equal(h.messages.filter(m=>m.type==='relay.eose').length,0);
  h.eose(1);h.eose(1);assert.deepEqual(h.messages.map(m=>m.type),['relay.event','relay.eose']);
});
test('zero-limit filters match live after their own relay EOSE while another relay is still backfilling', () => {
  const h = harness(['wss://one.example.org', 'wss://two.example.org']);
  const filters = [{kinds: [1], limit: 0}, {kinds: [2], limit: 1}];
  h.session.subscribe({...request(), filters}, h.send);
  assert.deepEqual(JSON.parse(h.calls[0]!.wire).slice(2), filters);
  const stored = signed('stored on second relay', 2);
  h.event(1, stored);
  h.eose(0);
  const early = signed('live on first relay');
  h.event(0, early);
  assert.deepEqual(h.messages, [
    {type: 'relay.event', subId: 'caller', result: {event: stored}},
    {type: 'relay.event', subId: 'caller', live: true, result: {event: early}},
  ]);
  h.eose(1);
  assert.deepEqual(h.messages.at(-1), {type: 'relay.eose', subId: 'caller'});
  const later = signed('live on second relay');
  h.event(1, later);
  assert.deepEqual(h.messages.at(-1), {type: 'relay.event', subId: 'caller', live: true, result: {event: later}});
  h.session.revoke();
});
test('zero-limit history, live signature failures and signed mismatches cannot reach the guest', () => {
  for (const mode of ['before-eose', 'after-reconnect', 'wrong-signature', 'wrong-filter']) {
    const h = harness();
    h.session.subscribe({...request(), filters: [{kinds: [1], limit: 0}]}, h.send);
    if (mode !== 'before-eose') h.eose();
    if (mode === 'after-reconnect') {
      h.manager.setForeground(false);
      h.manager.setForeground(true);
      h.event(0, signed('stale callback'));
    }
    const candidate = mode === 'wrong-signature' ? {...signed(), sig: '0'.repeat(128)}
      : mode === 'wrong-filter' ? signed('wrong kind', 2) : signed();
    h.event(mode === 'after-reconnect' ? 1 : 0, candidate);
    assert.deepEqual(h.messages.map(message => message.type),
      mode === 'before-eose' ? ['relay.closed'] : ['relay.eose', 'relay.closed']);
    h.session.revoke();
  }
});
test('zero-limit raw stream resumes only after new EOSE and cannot reconnect after explicit close', () => {
  const h = harness();
  const filters = [{kinds: [1], limit: 0}];
  h.session.subscribe({...request(), filters}, h.send);
  h.eose();
  h.event(0, signed('initial live delivery'));
  h.manager.setForeground(false);
  h.manager.setForeground(true);
  assert.deepEqual(JSON.parse(h.calls[1]!.wire).slice(2), filters);
  h.event(0, signed('stale generation'));
  h.eose(1);
  h.event(1, signed('resumed live delivery'));
  assert.deepEqual(h.messages.map(message => message.type), ['relay.eose', 'relay.event', 'relay.eose', 'relay.event']);
  assert(h.messages.every(message => message.type !== 'relay.event' || message.live === true));
  h.session.close(close());
  h.event(1, signed('closed generation'));
  h.manager.setForeground(false);
  h.manager.setForeground(true);
  assert.equal(h.calls.length, 2);
  assert.equal(h.messages.length, 4);
  h.session.revoke();
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
test('signed long video tags leave history and live delivery intact, while a bad signature is terminal', () => {
  const h = harness();
  const proof = signed('proof',34236,[['proofmode','p'.repeat(10_959)]]);
  const alt = signed('description',34235,[['alt','é'.repeat(1539)]]);
  const later = signed('later',34236);
  h.session.subscribe({...request(),filters:[{kinds:[34235,34236],limit:32}]},h.send);
  h.event(0,proof); h.event(0,alt); h.event(0,later); h.eose();
  const live = signed('live',34236,[['alt','a'.repeat(3000)]]);
  h.event(0,live);
  assert.deepEqual(h.messages,[
    ...[proof,alt,later].map(event=>({type:'relay.event',subId:'caller',result:{event}})),
    {type:'relay.eose',subId:'caller'},{type:'relay.event',subId:'caller',result:{event:live}},
  ]);
  assert.equal(h.calls[0]?.stopped,0);
  h.event(0,{...signed('forged',34236,[['proofmode','p'.repeat(10_959)]]),sig:'0'.repeat(128)});
  h.event(0,signed('ignored after close',34236));
  assert.deepEqual(h.messages.slice(5),[{type:'relay.closed',subId:'caller',reason:'invalid or excessive relay stream'}]);
  assert.equal(h.calls[0]?.stopped,1);
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
  h.session.subscribe(request('third'),h.send);
  assert.throws(()=>h.session.subscribe(request('fourth'),h.send));
  for (const [index, count] of [[2, 3], [3, 2]] as const) {
    const session=h.manager.session({registration:registration('generation-'+index),assertActive(){}});
    for (let slot=0; slot<count; slot++) session.subscribe(request('caller-'+slot),()=>true);
  }
  const fourth=h.manager.session({registration:registration('generation-4'),assertActive(){}});
  assert.throws(()=>fourth.subscribe(request(),()=>true));
  h.session.revoke();fourth.subscribe(request(),()=>true);
  assert.equal(h.calls.length,SUBSCRIPTION_LIMITS.process+1);
  assert.throws(()=>h.manager.session({registration:registration('generation-4'),assertActive(){}}));
  h.manager.revokeAll();assert.ok(h.calls.every(call=>call.stopped===1));
});
test('raw and planned stream managers reject crossover and enforce their own caps', () => {
  const relays = ['wss://one.example.org'];
  const raw = harness(relays, {...registration(), domains: ['outbox', 'relay']});
  assert.throws(() => raw.session.subscribePlanned(request(), raw.send, 'token', relays, 1));
  assert.equal(raw.calls.length, 0);
  raw.session.revoke();

  assert.throws(() => harness(relays, registration(), 'outbox'));
  const planned = harness(relays, {...registration(), domains: ['outbox']}, 'outbox');
  assert.throws(() => planned.session.subscribe(request(), planned.send));
  assert.equal(planned.calls.length, 0);
  const subscribe = (id: string) => planned.session.subscribePlanned(request(id), planned.send, 'token', relays, 1);
  subscribe('one');
  subscribe('two');
  assert.throws(() => subscribe('three'));
  planned.session.close(close('one'));
  subscribe('three');
  assert.equal(planned.calls.length, 3);
  planned.session.revoke();
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

test('signed contact-list history with about 900 tags reaches the stream and real EOSE', () => {
  const h=harness();
  const tags=Array.from({length:880},(_,index)=>['p',index.toString(16).padStart(64,'0')]);
  const contact=signed('',3,tags);
  h.session.subscribe({...request(),filters:[{kinds:[3],'#p':[tags[0]![1]!]}]},h.send);
  h.event(0,contact);h.eose();
  assert.deepEqual(h.messages,[{type:'relay.event',subId:'caller',result:{event:contact}},
    {type:'relay.eose',subId:'caller'}]);
  assert.equal(h.calls[0]!.stopped,0);h.session.revoke();
});

test('invalid or excessive peer input is quarantined without cancelling verified history from a healthy peer', () => {
  for(const mode of ['signature','filter','foreign','malformed','bytes','event-bytes','rate','closed']) {
    const h=harness(['wss://one.example.org','wss://two.example.org']);
    h.session.subscribe(request(),h.send);
    const history=signed('healthy history');h.event(1,history);
    if(mode==='signature')h.event(0,{...signed(),sig:'0'.repeat(128)});
    else if(mode==='filter')h.event(0,signed('wrong kind',2));
    else if(mode==='foreign')h.calls[0]!.frame(JSON.stringify(['EVENT','foreign',signed()]));
    else if(mode==='malformed')h.calls[0]!.frame('{');
    else if(mode==='bytes')h.calls[0]!.frame('x'.repeat(66*1024+1));
    else if(mode==='event-bytes')h.event(0,signed('x'.repeat(64*1024)));
    else if(mode==='closed')h.calls[0]!.frame(JSON.stringify(['CLOSED',h.calls[0]!.sub,'denied']));
    else for(let index=0;index<=64;index++)h.calls[0]!.frame(JSON.stringify(['NOTICE','bounded']));
    assert.equal(h.calls[0]!.stopped,1,mode);assert.equal(h.calls[1]!.stopped,0,mode);
    h.event(0,signed('stale quarantined callback'));h.eose(0);h.calls[0]!.failed();
    assert.deepEqual(h.messages,[{type:'relay.event',subId:'caller',result:{event:history}}],mode);
    h.eose(1);const live=signed('healthy live');h.event(1,live);
    assert.deepEqual(h.messages.map(message=>message.type),['relay.event','relay.eose','relay.event'],mode);
    assert.equal(h.calls.length,2,mode);h.session.revoke();
  }
});

test('quarantine after the healthy peer EOSE preserves a single genuine aggregate EOSE', () => {
  const h=harness(['wss://one.example.org','wss://two.example.org']);h.session.subscribe(request(),h.send);
  h.eose(1);assert.equal(h.messages.length,0);
  h.calls[0]!.frame('{');h.eose(1);h.event(1);
  assert.deepEqual(h.messages.map(message=>message.type),['relay.eose','relay.event']);
  h.session.revoke();
});

test('all quarantined peers close without synthetic EOSE and release subscription capacity', () => {
  const h=harness(['wss://one.example.org','wss://two.example.org']);h.session.subscribe(request(),h.send);
  h.calls[0]!.frame('{');assert.deepEqual(h.messages,[]);
  h.calls[1]!.frame('{');h.eose(0);h.eose(1);
  assert.deepEqual(h.messages,[{type:'relay.closed',subId:'caller',reason:'invalid or excessive relay stream'}]);
  h.session.subscribe(request('replacement'),h.send);assert.equal(h.calls.length,4);
  h.session.revoke();
});

test('quarantine does not consume a healthy peer transport retry budget or permit stale retry callbacks', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const h=harness(['wss://one.example.org','wss://two.example.org']);h.session.subscribe(request(),h.send);
  h.calls[0]!.frame('{');
  for(let attempt=0;attempt<=SUBSCRIPTION_LIMITS.retries;attempt++) {
    h.calls[attempt+1]!.failed();
    if(attempt<SUBSCRIPTION_LIMITS.retries)t.mock.timers.tick(1);
  }
  assert.equal(h.calls.length,7);
  assert.deepEqual(h.messages,[{type:'relay.closed',subId:'caller',reason:'relay connection failed'}]);
  h.calls[0]!.failed();t.mock.timers.tick(30_000);h.eose(6);
  assert.equal(h.calls.length,7);assert.equal(h.messages.length,1);h.session.revoke();
});

test('synchronous malformed peer input cancels its returned handle while the other peer can complete', () => {
  let sequence=0;
  const stopped:number[]=[],frames:{sub:string;frame:(text:string)=>void}[]=[];
  const port:NativeRelayStreamPort={
    newInstanceId:()=>`00000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`,
    open(_id,_url,_wire,sub,frame){const index=frames.length;frames.push({sub,frame});
      if(index===0)frame('{');return()=>{stopped.push(index);};},
  };
  const manager=createRelaySubscriptions(port,()=>['wss://one.example.org','wss://two.example.org']);
  const session=manager.session({registration:registration(),assertActive(){}}),messages:RelaySubscriptionMessage[]=[];
  session.subscribe(request(),message=>{messages.push(message);return true;});
  assert.deepEqual(stopped,[0]);assert.equal(frames.length,2);
  frames[1]!.frame(JSON.stringify(['EOSE',frames[1]!.sub]));
  assert.deepEqual(messages,[{type:'relay.eose',subId:'caller'}]);
  session.revoke();assert.deepEqual(stopped,[0,1]);
});

test('ordinary raw initial deadline keeps genuine EOSE with a silent peer and closes all-silent or bad-plus-silent reads', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  for(const mode of ['eose','silent','events','bad']) {
    const h=harness(['wss://one.example.org','wss://two.example.org']);h.session.subscribe(request(),h.send);
    if(mode==='eose'){h.event(0);h.eose(0);}else if(mode==='bad')h.calls[0]!.frame('{');else if(mode==='events')h.event(0);
    const before=h.messages.length;t.mock.timers.tick(14_999);assert.equal(h.messages.length,before);
    t.mock.timers.tick(1);
    assert.deepEqual(h.messages.map(message=>message.type),mode==='eose'?['relay.event','relay.eose']:
      mode==='events'?['relay.event','relay.closed']:['relay.closed']);
    if(mode!=='eose')assert.equal((h.messages.at(-1) as {reason:string}).reason,'relay timeout');
    assert.equal(h.calls[1]!.stopped,1);h.event(1,signed('after deadline'));h.eose(1);
    assert.equal(h.messages.length,before+1);
    if(mode==='eose'){h.event(0,signed('still live'));assert.equal(h.messages.at(-1)!.type,'relay.event');}
    h.session.revoke();
  }
});

test('ordinary raw deadline is suspended in background and refreshed on resume with stale replies rejected', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const h=harness(['wss://one.example.org','wss://two.example.org']);h.session.subscribe(request(),h.send);
  t.mock.timers.tick(14_000);h.manager.setForeground(false);t.mock.timers.tick(60_000);
  h.event();h.eose();assert.equal(h.messages.length,0);assert.equal(h.calls.length,2);
  h.manager.setForeground(true);assert.equal(h.calls.length,4);
  h.event(0,signed('old document'));h.eose(1);h.calls[0]!.failed();
  h.event(2,signed('fresh history'));h.eose(2);
  t.mock.timers.tick(14_999);assert.deepEqual(h.messages.map(message=>message.type),['relay.event']);
  t.mock.timers.tick(1);assert.deepEqual(h.messages.map(message=>message.type),['relay.event','relay.eose']);
  h.session.revoke();t.mock.timers.tick(30_000);h.event(2,signed('revoked'));
  assert.equal(h.messages.length,2);assert.equal(h.calls.length,4);
});

test('owner revocation or explicit close invalidates ordinary raw deadline without stale lifecycle delivery', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  for(const mode of ['identity','close','revoke']) {
    const h=harness();h.session.subscribe(request(),h.send);
    if(mode==='identity')h.setActive(false);else if(mode==='close')h.session.close(close());else h.session.revoke();
    t.mock.timers.tick(15_000);h.event();h.eose();h.calls[0]!.failed();
    h.manager.setForeground(false);h.manager.setForeground(true);
    assert.deepEqual(h.messages,[],mode);assert.equal(h.calls.length,1,mode);assert.equal(h.calls[0]!.stopped,1,mode);
    h.session.revoke();
  }
});
