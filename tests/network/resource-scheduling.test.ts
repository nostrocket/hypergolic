import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
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
  const calls: {url:string;signal:AbortSignal;token:string;finish(value:Uint8Array<ArrayBuffer>):void;fail(error:Error):void}[] = [];
  let active = 0, peak = 0;
  const service = createResourceService({servers:()=>[],sha256:async()=>'',now,https:(url,signal,check,token)=>{
    check();active++;peak=Math.max(peak,active);
    let finished=false;
    return new Promise<Uint8Array<ArrayBuffer>>((resolve,reject)=>calls.push({url,signal,token,
      finish(value){if(finished)return;finished=true;active--;resolve(value);},
      fail(error){if(finished)return;finished=true;active--;reject(error);}}));
  }});
  const bind = (id: string, check = () => {}) => {
    const bound=service.bind(registration(id),check);
    return {revoke:bound.revoke,executeRequest:(request:Parameters<typeof bound.execute>[0],assertActive=check)=>bound.execute(request,{nativeToken:'exact-lease-'+request.id,assertActive}),execute:(id:string)=>bound.execute(request(id),{nativeToken:'exact-lease-'+id,assertActive:check}),
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

const sameURL=(id:string)=>parseResourceRequest({type:'resource.bytes',id,url:'https://assets.example.com/shared'});
test('queued duplicate reads reuse validated cache before slot release and each receive an isolated copy',async()=>{
  const h=harness(),s=h.bind('duplicates');
  const work=[s.executeRequest(sameURL('source')),s.execute('blocker'),s.executeRequest(sameURL('one')),s.executeRequest(sameURL('two'))];
  void Promise.allSettled(work);
  try{
    await turn();assert.equal(h.calls.length,2);h.calls[0]!.finish(body(32));await turn();
    assert.equal(h.calls.length,2,'Queued duplicate must see cache before another native fetch can start');
    assert.deepEqual(h.calls.map(call=>call.token),['exact-lease-source','exact-lease-blocker']);
    h.calls[1]!.finish(body());
    const rows=await Promise.all([work[0]!,work[2]!,work[3]!]) as {value:{bytes:Uint8Array}}[];
    rows[0]!.value.bytes[0]=0;rows[1]!.value.bytes[1]=0;
    assert.equal(rows[1]!.value.bytes[0],120);assert.equal(rows[2]!.value.bytes[1],120);
    const fresh=await s.executeRequest(sameURL('fresh')) as {value:{bytes:Uint8Array}};
    assert.deepEqual(fresh.value.bytes,body(32));assert.equal(h.calls.length,2);assert.equal(h.peak(),2);
  }finally{h.service.revokeAll();for(const call of h.calls)call.finish(body());await Promise.allSettled(work);}
});

test('concurrent repeated bulk URLs keep input order without redundant queued native fetches',async()=>{
  const h=harness(),s=h.bind('bulk-duplicates');
  const batch=(id:string,other:string)=>s.executeRequest(parseResourceRequest({type:'resource.bytesMany',id,
    urls:['https://assets.example.com/shared','https://assets.example.com/'+other]}));
  const work=[batch('first','first-other'),batch('second','second-other'),batch('third','third-other')];
  void Promise.allSettled(work);
  try{
    await turn();h.calls[0]!.finish(body(32));await turn();
    assert.equal(h.calls.length,3);assert.ok(h.calls[2]!.url.endsWith('/second-other'));
    h.calls[2]!.finish(body());await turn();assert.equal(h.calls.length,4);
    assert.ok(h.calls[3]!.url.endsWith('/third-other'));h.calls[3]!.finish(body());h.calls[1]!.finish(body());
    const rows=await Promise.all(work) as {items:{url:string;ok:boolean}[]}[];
    for(const [index,other]of ['first-other','second-other','third-other'].entries())assert.deepEqual(rows[index]!.items.map(row=>row.url),
      ['https://assets.example.com/shared','https://assets.example.com/'+other]);
    assert.ok(rows.every(row=>row.items.every(item=>item.ok)));assert.equal(h.peak(),2);
    assert.equal(h.calls.filter(call=>call.url.endsWith('/shared')).length,1);
  }finally{h.service.revokeAll();for(const call of h.calls)call.finish(body());await Promise.allSettled(work);}
});

test('revoked or expired queued request authority is denied even when its target just entered cache',async()=>{
  for(const mode of ['revoked','expired']){
    let clock=0,admitted=true;const h=harness(()=>clock),s=h.bind(mode);
    const check=()=>{if(!admitted)throw new ResourceError('blocked-by-policy');if(clock>=100)throw new ResourceError('timeout');};
    const work=[s.executeRequest(sameURL('source')),s.execute('blocker'),s.executeRequest(sameURL('stale'),check)];
    void Promise.allSettled(work);
    try{
      await turn();if(mode==='revoked')admitted=false;else clock=100;
      h.calls[0]!.finish(body(32));await assert.rejects(work[2]!,error=>error instanceof ResourceError&&error.code===(mode==='revoked'?'blocked-by-policy':'timeout'));
      assert.equal(h.calls.length,2);
      await s.executeRequest(sameURL('fresh'));assert.equal(h.calls.length,2,'Source cache exists but did not bypass stale authority');
      h.calls[1]!.finish(body());await Promise.all(work.slice(0,2));
    }finally{h.service.revokeAll();for(const call of h.calls)call.finish(body());await Promise.allSettled(work);}
  }
});

test('queued Blossom cache reuse still denies a replaced settings snapshot before delivery',async()=>{
  let servers=['https://one.example.com'];
  const digest=createHash('sha256').update(body(32)).digest('hex');
  const calls:{token:string;finish(value:Uint8Array<ArrayBuffer>):void}[]=[];
  const service=createResourceService({servers:()=>servers,sha256:async bytes=>createHash('sha256').update(bytes).digest('hex'),
    https:(_url,_signal,check,token)=>{check();return new Promise(resolve=>calls.push({token,finish:resolve}));}});
  const session=service.bind(registration('blossom-cache'),()=>{});
  const run=(id:string,url='blossom:'+digest)=>session.execute(parseResourceRequest({type:'resource.bytes',id,url}),{nativeToken:'exact-lease-'+id,assertActive(){}});
  const work=[run('source'),run('blocker','https://assets.example.com/blocker'),run('duplicate')];
  void Promise.allSettled(work);
  try{
    await turn();assert.equal(calls.length,2);servers=['https://two.example.com'];
    calls[0]!.finish(body(32));await work[0];
    await assert.rejects(work[2]!,error=>error instanceof ResourceError&&error.code==='blocked-by-policy');
    const fresh=await run('fresh') as {value:{bytes:Uint8Array}};
    assert.deepEqual(fresh.value.bytes,body(32));assert.equal(calls.length,2,'Cache exists under the fresh settings snapshot');
    assert.deepEqual(calls.map(call=>call.token),['exact-lease-source','exact-lease-blocker']);
    calls[1]!.finish(body());await work[1];
  }finally{service.revokeAll();for(const call of calls)call.finish(body());await Promise.allSettled(work);}
});

test('failed source retrieval or validation cannot seed the cache used by a queued duplicate',async()=>{
  for(const mode of ['network','validation']){
    const h=harness(),s=h.bind(mode);
    const work=[s.executeRequest(sameURL('source')),s.execute('blocker'),s.executeRequest(sameURL('duplicate'))];
    void Promise.allSettled(work);
    try{
      await turn();
      if(mode==='network')h.calls[0]!.fail(new ResourceError('network-error'));
      else h.calls[0]!.finish(new Uint8Array([137,80,78,71,13,10,26,10]));
      await assert.rejects(work[0]!,error=>error instanceof ResourceError&&error.code===(mode==='network'?'network-error':'decode-failed'));
      await turn();assert.equal(h.calls.length,3);assert.equal(h.calls[2]!.token,'exact-lease-duplicate');
      h.calls[2]!.finish(body(32));h.calls[1]!.finish(body());await Promise.all(work.slice(1));
      const fresh=await s.executeRequest(sameURL('fresh')) as {value:{bytes:Uint8Array}};
      assert.deepEqual(fresh.value.bytes,body(32));assert.equal(h.calls.length,3);
    }finally{h.service.revokeAll();for(const call of h.calls)call.finish(body());await Promise.allSettled(work);}
  }
});

test('aborted source retains its reservation until settlement and cannot cancel or populate a queued duplicate',async()=>{
  const h=harness(),s=h.bind('cancel-source');
  const work=[s.executeRequest(sameURL('source')),s.execute('blocker'),s.executeRequest(sameURL('duplicate'))];
  void Promise.allSettled(work);
  try{
    await turn();await s.cancel('source');await assert.rejects(work[0]!,timeout);
    assert.equal(h.calls.length,2);assert.equal(h.calls[0]!.signal.aborted,true);
    h.calls[0]!.finish(body(12));await turn();assert.equal(h.calls.length,3);
    assert.equal(h.calls[2]!.token,'exact-lease-duplicate');assert.equal(h.calls[2]!.signal.aborted,false);
    h.calls[2]!.finish(body(32));h.calls[1]!.finish(body());await Promise.all(work.slice(1));
    const fresh=await s.executeRequest(sameURL('fresh')) as {value:{bytes:Uint8Array}};
    assert.deepEqual(fresh.value.bytes,body(32));assert.equal(h.calls.length,3);assert.equal(h.peak(),2);
  }finally{h.service.revokeAll();for(const call of h.calls)call.finish(body());await Promise.allSettled(work);}
});

test('queued cache reuse still charges the existing delivered-byte budget',async()=>{
  const h=harness(),s=h.bind('delivery-budget');
  const work=[s.executeRequest(sameURL('source')),s.execute('blocker'),s.executeRequest(sameURL('one')),s.executeRequest(sameURL('two'))];
  void Promise.allSettled(work);
  try{
    await turn();h.calls[0]!.finish(body(1024*1024));await turn();h.calls[1]!.finish(body());await Promise.all(work);
    for(let index=0;index<46;index++)await s.executeRequest(sameURL('cached-'+index));
    await assert.rejects(s.executeRequest(sameURL('over-budget')),quota);
    assert.equal(h.calls.length,2);
  }finally{h.service.revokeAll();for(const call of h.calls)call.finish(body());await Promise.allSettled(work);}
});
