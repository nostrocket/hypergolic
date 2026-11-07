import test from 'node:test';
import assert from 'node:assert/strict';
import { createResourceService } from '../../src/resources/resource-service.ts';
import { parseResourceRequest, ResourceError } from '../../src/resources/resource-contract.ts';
import type { NativeRegistration } from '../../src/runtime/capability-protocol.ts';
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const body = (size = 20) => new TextEncoder().encode('x'.repeat(size));
const request = (id: string) => parseResourceRequest({type:'resource.bytes',id,url:'https://assets.example.com/'+id});
const registration = (generation: string): NativeRegistration => ({sessionId:generation,generation,epoch:1,
  user:'a'.repeat(64),publisher:'b'.repeat(64),appId:'map',version:'c'.repeat(64),instanceId:generation,fixture:'published',domains:['resource']});
const quota = (e: unknown) => e instanceof ResourceError && e.code === 'quota-exceeded';
const timeout = (e: unknown) => e instanceof ResourceError && e.code === 'timeout';
function harness(now?: () => number) {
  const calls: {url:string;signal:AbortSignal;token:string;finish(value:Uint8Array<ArrayBuffer>):void}[] = [];
  let active = 0, peak = 0;
  const service = createResourceService({servers:()=>[],sha256:async()=>'',now,https:(url,signal,check,token)=>{
    check();active++;peak=Math.max(peak,active);
    let finished=false;
    return new Promise<Uint8Array<ArrayBuffer>>(resolve=>calls.push({url,signal,token,finish(value){if(finished)return;finished=true;active--;resolve(value);}}));
  }});
  const bind = (id: string, check = () => {}) => {
    const bound=service.bind(registration(id),check);
    return {revoke:bound.revoke,executeRequest:(request:Parameters<typeof bound.execute>[0])=>bound.execute(request,{nativeToken:'exact-lease-'+request.id,assertActive:check}),execute:(id:string)=>bound.execute(request(id),{nativeToken:'exact-lease-'+id,assertActive:check}),
      cancel:(id:string)=>bound.execute(parseResourceRequest({type:'resource.cancel',id}),{nativeToken:'exact-lease',assertActive:check})};
  };
  return {service,bind,calls,peak:()=>peak};
}
test('three concurrent small Mapplets resources wait rather than fail at the two-fetch cap', async () => {
  const h=harness(),s=h.bind('map');const work=[s.execute('first'),s.execute('second')];let thirdState='pending';
  const third=s.execute('third').then(v=>{thirdState='success';return v;},e=>{thirdState='failed';throw e;});
  void third.catch(()=>{});
  try {
    await turn();assert.equal(h.calls.length,2);assert.equal(thirdState,'pending');
    h.calls[0]!.finish(body(123812));h.calls[1]!.finish(body(107043));await turn();
    assert.equal(h.calls.length,3);h.calls[2]!.finish(body());
    const results=await Promise.all([...work,third]);assert.equal(results.length,3);assert.equal(thirdState,'success');assert.equal(h.peak(),2);
  } finally {h.service.revokeAll();for(const c of h.calls)c.finish(body());await Promise.allSettled([...work,third]);}
});

test('process admission rotates waiting realms and preserves each realm FIFO', async () => {
  const h=harness(),a=h.bind('a'),b=h.bind('b'),c=h.bind('c');
  const tasks=[a.execute('a1'),a.execute('a2'),b.execute('b1'),b.execute('b2'),a.execute('a3'),a.execute('a4'),b.execute('b3'),c.execute('c1')];
  try {
    await turn();assert.deepEqual(h.calls.map(x=>x.url.split('/').at(-1)),['a1','a2','b1','b2']);
    h.calls[0]!.finish(body());await turn();assert.ok(h.calls[4]!.url.endsWith('/a3'));
    h.calls[2]!.finish(body());await turn();assert.ok(h.calls[5]!.url.endsWith('/b3'));
    h.calls[1]!.finish(body());await turn();assert.ok(h.calls[6]!.url.endsWith('/c1'));
    h.calls[4]!.finish(body());await turn();assert.ok(h.calls[7]!.url.endsWith('/a4'));
    for(const call of h.calls)call.finish(body());await Promise.all(tasks);assert.equal(h.peak(),4);
  } finally {h.service.revokeAll();for(const call of h.calls)call.finish(body());await Promise.allSettled(tasks);}
});

test('queue is bounded at six waiting targets per realm and cancellation immediately frees room', async () => {
  const h=harness(),s=h.bind('realm');const tasks=Array.from({length:8},(_,i)=>s.execute('a'+i));
  void Promise.allSettled(tasks);
  try {
    await turn();assert.equal(h.calls.length,2);
    await assert.rejects(s.execute('overflow'),quota);assert.equal(h.calls.length,2);
    await s.cancel('a2');await assert.rejects(tasks[2]!,timeout);
    const replacement=s.execute('replacement');tasks.push(replacement);void replacement.catch(()=>{});
    h.calls[0]!.finish(body());await turn();assert.ok(h.calls[2]!.url.endsWith('/a3'));
    assert.ok(!h.calls.some(c=>c.url.endsWith('/a2')||c.url.endsWith('/overflow')));
  } finally {h.service.revokeAll();for(const c of h.calls)c.finish(body());await Promise.allSettled(tasks);}
});

test('process queue bound is independent of per-realm bounds and removed waiters retain no admission', async () => {
  const h=harness(),a=h.bind('a'),b=h.bind('b'),c=h.bind('c'),d=h.bind('d');
  const tasks=[...Array.from({length:8},(_,i)=>a.execute('a'+i)),...Array.from({length:8},(_,i)=>b.execute('b'+i)),...Array.from({length:4},(_,i)=>c.execute('c'+i))];void Promise.allSettled(tasks);
  try {
    await turn();assert.equal(h.calls.length,4);
    await assert.rejects(d.execute('overflow'),quota);
    c.revoke();await Promise.all(tasks.slice(-4).map(p=>assert.rejects(p,timeout)));
    const admitted=d.execute('d0');tasks.push(admitted);void admitted.catch(()=>{});
    assert.equal(h.calls.length,4);h.calls[0]!.finish(body());await turn();assert.equal(h.calls.length,5);
  } finally {h.service.revokeAll();for(const call of h.calls)call.finish(body());await Promise.allSettled(tasks);}
});

test('cancelled uncooperative active resolvers keep actual process slots until settlement', async () => {
  const h=harness(),a=h.bind('a'),b=h.bind('b'),c=h.bind('c');const tasks=[a.execute('a1'),a.execute('a2'),b.execute('b1'),b.execute('b2')];void Promise.allSettled(tasks);
  const queued=c.execute('c1');void queued.catch(()=>{});
  try {
    await turn();a.revoke();b.revoke();await Promise.all(tasks.map(p=>assert.rejects(p,timeout)));await turn();assert.equal(h.calls.length,4);
    assert.ok(h.calls.every(call=>call.signal.aborted));
    h.calls[0]!.finish(body());await turn();assert.equal(h.calls.length,5);assert.ok(h.calls[4]!.url.endsWith('/c1'));
    h.calls[4]!.finish(body());await queued;assert.equal(h.peak(),4);
  } finally {h.service.revokeAll();for(const call of h.calls)call.finish(body());await Promise.allSettled([...tasks,queued]);}
});

test('promotion rechecks exact request authority and never fetches a revoked queued target', async () => {
  const h=harness();let active=true;const s=h.bind('same-generation',()=>{if(!active)throw new ResourceError('blocked-by-policy');});
  const tasks=[s.execute('first'),s.execute('second'),s.execute('stale')];void Promise.allSettled(tasks);
  try {
    await turn();active=false;h.calls[0]!.finish(body());
    await assert.rejects(tasks[2]!,e=>e instanceof ResourceError&&e.code==='blocked-by-policy');assert.equal(h.calls.length,2);
    assert.deepEqual(h.calls.map(c=>c.token),['exact-lease-first','exact-lease-second']);
    s.revoke();await Promise.all(tasks.slice(0,2).map(p=>assert.rejects(p)));
  } finally {h.service.revokeAll();for(const c of h.calls)c.finish(body());await Promise.allSettled(tasks);}
});

test('revoking queued work then binding a fresh generation cannot revive an old request', async () => {
  const h=harness(),old=h.bind('old');const tasks=[old.execute('old1'),old.execute('old2'),old.execute('old3')];void Promise.allSettled(tasks);
  try {
    await turn();old.revoke();await Promise.all(tasks.map(p=>assert.rejects(p,timeout)));
    const fresh=h.bind('fresh').execute('fresh');void fresh.catch(()=>{});tasks.push(fresh);await turn();
    assert.equal(h.calls.length,3);assert.ok(h.calls[2]!.url.endsWith('/fresh'));assert.ok(!h.calls.some(c=>c.url.endsWith('/old3')));
    h.calls[2]!.finish(body());await fresh;
  } finally {h.service.revokeAll();for(const c of h.calls)c.finish(body());await Promise.allSettled(tasks);}
});

test('original root deadline includes waiting even when active resolvers never cooperate', async t => {
  t.mock.timers.enable({apis:['setTimeout','setInterval']});let clock=0;
  const h=harness(()=>clock),s=h.bind('slow');const tasks=[s.execute('slow1'),s.execute('slow2'),s.execute('waiting')];void Promise.allSettled(tasks);
  try {
    await turn();clock=19999;t.mock.timers.tick(19999);await turn();assert.equal(h.calls.length,2);
    clock=20000;t.mock.timers.tick(1);await Promise.all(tasks.map(p=>assert.rejects(p,timeout)));
    for(const c of h.calls)c.finish(body());await turn();assert.equal(h.calls.length,2);
  } finally {h.service.revokeAll();for(const c of h.calls)c.finish(body());await Promise.allSettled(tasks);t.mock.timers.reset();}
});

test('absolute deadline blocks promotion before a delayed timer callback can execute', async () => {
  let clock=0;const h=harness(()=>clock),s=h.bind('late');const tasks=[s.execute('one'),s.execute('two'),s.execute('late')];void Promise.allSettled(tasks);
  try {
    await turn();clock=20000;h.calls[0]!.finish(body());await assert.rejects(tasks[2]!,timeout);assert.equal(h.calls.length,2);
  } finally {h.service.revokeAll();for(const c of h.calls)c.finish(body());await Promise.allSettled(tasks);}
});

test('four accepted bulk calls fit the queue while their two workers preserve ordered siblings', async () => {
  const h=harness(),s=h.bind('bulk');
  const work=Array.from({length:4},(_,i)=>s.executeRequest(parseResourceRequest({type:'resource.bytesMany',id:'bulk'+i,
    urls:Array.from({length:4},(_,j)=>'https://assets.example.com/'+i+'-'+j)})));void Promise.allSettled(work);
  try {
    await turn();assert.equal(h.calls.length,2);
    for(let index=0;index<16;index++){
      assert.ok(h.calls[index], 'Each completed target admits another bounded target');h.calls[index]!.finish(body());await turn();
    }
    const rows=await Promise.all(work) as {items:{url:string;ok:boolean}[]}[];
    assert.equal(h.calls.length,16);assert.equal(h.peak(),2);
    for(let i=0;i<4;i++)assert.deepEqual(rows[i]!.items.map(x=>[x.url,x.ok]),Array.from({length:4},(_,j)=>['https://assets.example.com/'+i+'-'+j,true]));
  } finally {h.service.revokeAll();for(const c of h.calls)c.finish(body());await Promise.allSettled(work);}
});

test('URL timeout starts at admission while original root still limits the whole request', async t => {
  t.mock.timers.enable({apis:['setTimeout','setInterval']});let clock=0;const h=harness(()=>clock),s=h.bind('timing');
  const tasks=[s.execute('one'),s.execute('two'),s.execute('wait')];void Promise.allSettled(tasks);
  try {
    await turn();clock=14000;t.mock.timers.tick(14000);h.calls[0]!.finish(body());await turn();assert.equal(h.calls.length,3);
    clock=19000;t.mock.timers.tick(5000);h.calls[2]!.finish(body());await tasks[2];assert.equal(h.calls[2]!.signal.aborted,false);
  } finally {h.service.revokeAll();for(const c of h.calls)c.finish(body());await Promise.allSettled(tasks);t.mock.timers.reset();}
});

test('queued Blossom work cannot fetch from a replaced or disabled settings snapshot', async () => {
  let servers=['https://cdn.example.com'];const calls:string[]=[];const finish:((bytes:Uint8Array<ArrayBuffer>)=>void)[]=[];
  const service=createResourceService({servers:()=>servers,sha256:async()=> 'a'.repeat(64),https:async url=>{calls.push(url);return new Promise(resolve=>finish.push(resolve));}});
  const s=service.bind(registration('settings'),()=>{}),run=(id:string,url:string)=>s.execute(parseResourceRequest({type:'resource.bytes',id,url}),{nativeToken:id,assertActive(){}});
  const work=[run('one','https://assets.example.com/one'),run('two','https://assets.example.com/two'),run('hash','blossom:'+'a'.repeat(64))];void Promise.allSettled(work);
  try {
    await turn();servers=[];finish[0]!(body());await assert.rejects(work[2]!,e=>e instanceof ResourceError&&e.code==='blocked-by-policy');
    assert.equal(calls.length,2);assert.ok(calls.every(url=>url.startsWith('https://assets.example.com/')));
  } finally {service.revokeAll();for(const resolve of finish)resolve(body());await Promise.allSettled(work);}
});
