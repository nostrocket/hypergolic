import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { createCommunityRecommendations, loadCommunityRecommendations } from '../src/community-recommendations.ts';
import { parsePublication, verifySignedEvent, type Publication } from '../src/catalog.ts';
import type { Query } from '../src/pager.ts';
import { clock, manifest, profile } from './fixtures.ts';

const pubkey = (author: number) => getPublicKey(new Uint8Array(32).fill(author));
const app = (publisher = 1, identifier = 'app:one') => parsePublication(verifySignedEvent(manifest({publisher,d:identifier}),{kinds:[35129]},clock)!)!;
const coordinate = (publication: Publication) => `35129:${publication.publisher}:${publication.identifier}`;
const list = (author: number, tags: string[][], timestamp = clock, content = '') => finalizeEvent({kind:30267,created_at:timestamp,
  content,tags:[['d','napplets'],...tags]},new Uint8Array(32).fill(author));
const rows = (...events: unknown[]) => events.map(event => ({event}));
function queryWith(lists: unknown, profiles: unknown = [], failProfiles = false) {
  const calls: Parameters<Query>[0][] = [];
  const query: Query = async filters => {
    calls.push(filters);
    if (filters.every(filter => filter.kinds?.[0] === 35129)) return [];
    assert.equal(filters.length,1);
    if(filters[0]!.kinds?.[0]===30267) return lists;
    assert.deepEqual(filters[0]!.kinds,[0]);
    if(failProfiles)throw Error('profile read unavailable');
    return profiles;
  };
  return {query,calls};
}

test('matches exact signed named publications with signed recommender names using only bounded public reads',async()=>{
  const publication=app(), recommendation=list(3,[['a',coordinate(publication),'wss://ignored.example.org']]);
  const q=queryWith(rows(recommendation),rows(profile(3,clock,'{"display_name":"A\u202erjen\\n  Smith"}')));
  const result=await loadCommunityRecommendations([publication],q.query);
  assert.equal(result.partial,true);assert.equal(result.items.length,1);
  assert.equal(result.items[0]!.publication.signed.event.id,publication.signed.event.id);
  assert.deepEqual(result.items[0]!.recommender,{pubkey:pubkey(3),label:'Arjen Smith'});
  assert.equal(result.items[0]!.eventId,recommendation.id);
  assert.equal(result.items[0]!.createdAt,clock);
  assert.deepEqual(q.calls[0]![0]!.kinds,[30267]);assert.deepEqual(q.calls[0]![0]!['#d'],['napplets']);
  assert.equal(q.calls[0]![0]!.limit,32);
  assert.deepEqual(q.calls[1]![0]!.authors,[pubkey(3)]);assert.equal(q.calls[1]![0]!.limit,32);
});

test('empty and malformed newest replacements withdraw older recommendations without resurrecting them',async()=>{
  const publication=app(), old=list(3,[['a',coordinate(publication)]],clock-10);
  for(const replacement of [list(3,[]),list(3,[['d','other']]),list(3,[['d','napplets','unexpected']])]) {
    const q=queryWith(rows(old,replacement));
    assert.deepEqual((await loadCommunityRecommendations([publication],q.query)).items,[]);
    assert.equal(q.calls.length,1);
  }
});

test('forged, future, wrong-kind, wrong-list and unmatched reference rows never become recommendation cards',async()=>{
  const publication=app(), signed=list(3,[['a',coordinate(publication)]]);
  const cases=[
    {...signed,content:'altered after cached verification'},
    {...signed,sig:'0'.repeat(128)},
    list(3,[['a',coordinate(publication)]],Math.floor(Date.now()/1000)+3600),
    profile(3,clock,'{}'),
    finalizeEvent({kind:30267,created_at:clock,content:'',tags:[['d','other'],['a',coordinate(publication)]]},new Uint8Array(32).fill(3)),
    list(3,[['a',`35129:${pubkey(2)}:app:one`],['a',`35129:${publication.publisher}:unloaded`],['a','malformed']]),
    {kind:30267}, null,
  ];
  for(const event of cases)assert.deepEqual((await loadCommunityRecommendations([publication],queryWith(rows(event)).query)).items,[]);
});

test('a different named list does not withdraw an author’s napplets list',async()=>{
  const publication=app(), old=list(3,[['a',coordinate(publication)]],clock-10);
  const other=finalizeEvent({kind:30267,created_at:clock,content:'',tags:[['d','other']]},new Uint8Array(32).fill(3));
  assert.equal((await loadCommunityRecommendations([publication],queryWith(rows(old,other)).query)).items.length,1);
});

test('newest timestamps and lower-id ties select one list per author independent of relay order',async()=>{
  const publication=app(), older=list(3,[['a',coordinate(publication)]],clock-10);
  const one=list(3,[['a',coordinate(publication)]],clock,'one'),two=list(3,[],clock,'two');
  const expected=one.id<two.id?one:two;
  for(const events of [[one,older,two],[two,one,older]]){
    const result=await loadCommunityRecommendations([publication],queryWith(rows(...events)).query);
    assert.equal(result.items.length,expected===one?1:0);
    if(result.items.length)assert.equal(result.items[0]!.eventId,expected.id);
  }
});

test('keeps distinct genuine recommenders, deduplicates repeated coordinates and caps matches at eight',async()=>{
  const apps=Array.from({length:10},(_,i)=>app(1,'app-'+i));
  const repeated=list(3,[['a',coordinate(apps[0]!)],['a',coordinate(apps[0]!)]]);
  const other=list(4,[['a',coordinate(apps[0]!)]],clock-1);
  const two=await loadCommunityRecommendations(apps,queryWith(rows(other,repeated,repeated)).query);
  assert.deepEqual(two.items.map(item=>item.recommender.pubkey),[pubkey(3),pubkey(4)]);
  const q=queryWith(rows(list(3,apps.map(item=>['a',coordinate(item)]))));
  const many=await loadCommunityRecommendations(apps,q.query);
  assert.equal(many.items.length,8);assert.deepEqual(many.items.map(item=>item.publication.identifier),apps.slice(0,8).map(item=>item.identifier));
  assert.equal(q.calls.length,2);
});

test('profile metadata is same-author verified and a malformed newest profile falls back to the short key',async()=>{
  const publication=app(), recommendation=list(3,[['a',coordinate(publication)]]);
  const good=profile(3,clock-10,'{"name":"Old name"}');
  for(const profiles of [rows(profile(4,clock,'{"name":"Impostor"}')),rows({...good,content:'{"name":"forged"}'}),rows(good,profile(3,clock,'not JSON'))]){
    const result=await loadCommunityRecommendations([publication],queryWith(rows(recommendation),profiles).query);
    assert.equal(result.items[0]!.recommender.label,`${pubkey(3).slice(0,8)}…${pubkey(3).slice(-4)}`);
  }
  assert.equal((await loadCommunityRecommendations([publication],queryWith(rows(recommendation),[],true).query)).items.length,1);
});

test('never trusts altered catalog metadata and verifies only matching candidate publications',async()=>{
  const publication=app(), recommendation=list(3,[['a',coordinate(publication)]]);
  const mislabeled={...publication,title:'Invented title'};
  const result=await loadCommunityRecommendations([mislabeled],queryWith(rows(recommendation)).query);
  assert.equal(result.items[0]!.publication.title,publication.title);
  const forged={...publication,signed:{...publication.signed,event:{...publication.signed.event,content:'forged'}}};
  assert.deepEqual((await loadCommunityRecommendations([forged],queryWith(rows(recommendation)).query)).items,[]);
  const untouched={...app(2,'unmatched'),get signed(){throw Error('Unmatched metadata was inspected');}};
  assert.equal((await loadCommunityRecommendations([untouched,publication],queryWith(rows(recommendation)).query)).items.length,1);
});

test('pagination reuses the list sample and names, reading only newly matched authors',async()=>{
  const first=app(1,'first'),second=app(2,'second');
  const q=queryWith(rows(list(3,[['a',coordinate(first)]]),list(4,[['a',coordinate(second)]],clock-1)),rows(profile(3,clock,'{"name":"One"}'),profile(4,clock,'{"name":"Two"}')));
  const sampler=createCommunityRecommendations(q.query);
  assert.equal((await sampler.read([first])).items.length,1);
  assert.equal((await sampler.read([first,second])).items.length,2);
  await sampler.read([first,second]);
  assert.equal(q.calls.length,4);
  assert.deepEqual(q.calls[1]![0]!['#d'], ['second']);
  assert.deepEqual(q.calls[2]![0]!.authors,[pubkey(3)]);assert.deepEqual(q.calls[3]![0]!.authors,[pubkey(4)]);
});

test('unmatched apps can appear on a later page without refetching the lists',async()=>{
  const target=app(), q=queryWith(rows(list(3,[['a',coordinate(target)]])));
  const sampler=createCommunityRecommendations(q.query);
  assert.equal((await sampler.read([app(2)])).items.length,0);
  assert.equal((await sampler.read([target])).items.length,1);
  assert.equal(q.calls.length,3);
  assert.deepEqual(q.calls[1]![0]!['#d'],[target.identifier]);
});

test('thrown list reads retry once and rejected samples do not poison a later read',async()=>{
  let calls=0;
  const failed:Query=async filters=>{
    if(filters[0]!.kinds?.[0]===0)return [];
    if(++calls<=2)throw Error('unavailable');
    return rows(list(3,[['a',coordinate(app())]]));
  };
  const sampler=createCommunityRecommendations(failed);
  assert.deepEqual(await sampler.read([app()]),{items:[],partial:true});
  assert.equal(calls,2);
  assert.equal((await sampler.read([app()])).items.length,1);assert.equal(calls,3);
});

test('successful empty samples and malformed successful responses never trigger automatic retries',async()=>{
  let calls=0;
  const empty=createCommunityRecommendations(async()=>{calls++;return [];});
  await empty.read([app()]);await empty.read([app()]);assert.equal(calls,1);
  const event=list(3,[['a',coordinate(app())]]);
  const malformed=queryWith(rows(...Array(33).fill(event))),sampler=createCommunityRecommendations(malformed.query);
  assert.deepEqual((await sampler.read([app()])).items,[]);
  await sampler.read([app()]);assert.equal(malformed.calls.length,1);
});

test('concurrent readers share a transient failure and the same single successful retry',async()=>{
  let calls=0,finish!:(value:unknown)=>void;
  const query:Query=async filters=>{
    if(filters[0]!.kinds?.[0]===0)return [];
    if(++calls===1)throw Error('temporary read failure');
    return new Promise(resolve=>{finish=resolve;});
  };
  const sampler=createCommunityRecommendations(query);
  const first=sampler.read([app()]),second=sampler.read([app()]);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,2);
  finish(rows(list(3,[['a',coordinate(app())]])));
  assert.equal((await first).items.length,1);assert.equal((await second).items.length,1);assert.equal(calls,2);
});

test('a guest deadline never dispatches a retry while the original SDK transport remains in flight',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let calls=0,finish!:(value:unknown)=>void;
  const query:Query=async filters=>{
    if(filters[0]!.kinds?.[0]===0)return [];
    calls++;return new Promise(resolve=>{finish=resolve;});
  };
  const sampler=createCommunityRecommendations(query),first=sampler.read([app()]);
  t.mock.timers.tick(18_000);assert.deepEqual((await first).items,[]);assert.equal(calls,1);
  const second=sampler.read([app()]);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
  finish(rows(list(3,[['a',coordinate(app())]])));
  assert.equal((await second).items.length,1);assert.equal(calls,1);
});

test('an SDK timeout or navigation abort never automatically retries',async()=>{
  let calls=0;
  const timeout:Query=async()=>{calls++;throw Error('relay.query timed out');};
  assert.deepEqual((await createCommunityRecommendations(timeout).read([app()])).items,[]);assert.equal(calls,1);
  const controller=new AbortController();calls=0;
  const cancelled:Query=async()=>{calls++;controller.abort();throw Error('navigation');};
  assert.deepEqual((await createCommunityRecommendations(cancelled,controller.signal).read([app()])).items,[]);assert.equal(calls,1);
});

test('abort fences a pending sample and its late reply without starting profile reads',async()=>{
  const controller=new AbortController();let finish!:(value:unknown)=>void,calls=0;
  const query:Query=()=>{calls++;return new Promise(resolve=>{finish=resolve;});};
  const pending=loadCommunityRecommendations([app()],query,controller.signal);
  controller.abort();assert.deepEqual(await pending,{items:[],partial:true});
  finish(rows(list(3,[['a',coordinate(app())]])));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
  await loadCommunityRecommendations([app()],query,controller.signal);assert.equal(calls,1);
});

test('slow profiles keep a genuine card with its short key; list sampling is also time bounded',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const publication=app();
  const query:Query=async filters=>filters[0]!.kinds?.[0]===30267?rows(list(3,[['a',coordinate(publication)]])):new Promise(()=>{});
  let updates=0;
  const sampler=createCommunityRecommendations(query,undefined,()=>{updates++;});
  const result=await sampler.read([publication]);assert.equal(result.items.length,1);assert.match(result.items[0]!.recommender.label,/…/);
  t.mock.timers.tick(18_000);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(updates,0);
  assert.equal((await sampler.read([publication])).items.length,1);
  const unavailable=loadCommunityRecommendations([publication],async()=>new Promise(()=>{}));
  t.mock.timers.tick(18_000);assert.deepEqual(await unavailable,{items:[],partial:true});
});

test('a realistic slow profile response upgrades a visible fallback without replacing or moving the cards',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const first=app(1,'one'),second=app(2,'two');let calls=0,updates=0;
  const query:Query=async filters=>{
    calls++;
    if(filters[0]!.kinds?.[0]===30267)return rows(list(3,[['a',coordinate(first)],['a',coordinate(second)]]));
    await new Promise(resolve=>setTimeout(resolve,3500));
    return rows(profile(3,clock,'{"name":"Verified late name"}'));
  };
  const sampler=createCommunityRecommendations(query,undefined,()=>{updates++;});
  const initial=await sampler.read([first,second]);
  assert.equal(initial.items.length,2);assert.match(initial.items[0]!.recommender.label,/…/);assert.equal(updates,0);
  t.mock.timers.tick(3500);await new Promise(resolve=>setImmediate(resolve));
  const upgraded=await sampler.read([first,second]);
  assert.equal(updates,1);assert.equal(calls,2);
  assert.deepEqual(upgraded.items.map(item=>item.publication.address),initial.items.map(item=>item.publication.address));
  assert.deepEqual(upgraded.items.map(item=>item.eventId),initial.items.map(item=>item.eventId));
  assert.ok(upgraded.items.every(item=>item.recommender.label==='Verified late name'));
  await sampler.read([first,second]);assert.equal(updates,1);
});

test('abort fences a pending label upgrade and suppresses its notification',async()=>{
  const controller=new AbortController();let finish!:(value:unknown)=>void,updates=0;
  const query:Query=async filters=>filters[0]!.kinds?.[0]===30267?rows(list(3,[['a',coordinate(app())]])):
    new Promise(resolve=>{finish=resolve;});
  const sampler=createCommunityRecommendations(query,controller.signal,()=>{updates++;});
  assert.equal((await sampler.read([app()])).items.length,1);
  controller.abort();finish(rows(profile(3,clock,'{"name":"Too late"}')));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(updates,0);
  assert.deepEqual((await sampler.read([app()])).items,[]);
});

test('exact reads verify the referenced author, identifier, signature and newest eligible revision', async () => {
  const target = app(2, '工具:one');
  const reference = coordinate(target);
  const signedList = list(3, [
    ['a', reference, 'wss://unused.invalid'],
    ['a', '35129:' + target.publisher + ': bad'],
    ['a', '35129:' + target.publisher + ':' + 'é'.repeat(128)],
    ['a', '35129:' + target.publisher + ':\udfff'],
    ['a', '15129:' + target.publisher + ':wrong-kind'],
  ]);
  const newest = manifest({publisher:2, d:target.identifier, timestamp:clock, title:'Current release'});
  const lookup: Query = async filters => {
    if (filters[0]?.kinds?.[0] === 30267) return rows(signedList);
    if (filters[0]?.kinds?.[0] === 0) return [];
    assert.deepEqual(filters, [{kinds:[35129], authors:[target.publisher], '#d':[target.identifier],
      until:filters[0]?.until, limit:2}]);
    return rows(manifest({publisher:1,d:target.identifier}), manifest({publisher:2,d:'wrong'}),
      {...newest,content:'forged'}, target.signed.event, newest);
  };
  const result = await loadCommunityRecommendations([], lookup);
  assert.deepEqual(result.items.map(item => [item.publication.signed.event.id, item.recommender.pubkey]), [[newest.id,pubkey(3)]]);
});

test('two different latest revisions at the same timestamp withhold the exact recommendation', async () => {
  const target = app();
  const a = target.signed.event, b = manifest({d:target.identifier,title:'Second revision',timestamp:a.created_at});
  const signedList = list(5,[['a',coordinate(target)]]);
  for (const revisions of [[a,b],[b,a]]) {
    const q: Query = async filters => filters[0]?.kinds?.[0] === 30267 ? rows(signedList) : rows(...revisions);
    assert.deepEqual((await loadCommunityRecommendations([],q)).items,[]);
  }
});

test('missing coordinates share two bounded batches across readers and duplicates', async () => {
  const apps = Array.from({length:10},(_,i)=>app(1,'item-'+i));
  const refs = apps.flatMap(item=>[['a',coordinate(item)],['a',coordinate(item)]]);
  const endorsement = list(3,refs);
  const calls: Parameters<Query>[0][] = [];
  const sample = createCommunityRecommendations(async filters=>{
    if (filters[0]?.kinds?.[0] === 30267) return rows(endorsement);
    calls.push(filters);
    return [];
  });
  await Promise.all([sample.read([]),sample.read([])]);
  await sample.read([]);
  assert.deepEqual(calls.map(batch => batch.map(f=>f['#d']?.[0])),
    [apps.slice(0,4),apps.slice(4,8)].map(batch=>batch.map(item=>item.identifier)));
});

test('loaded cards stay available during a lookup and a refresh ignores its late result', async () => {
  const known = app(), missing = app(2,'off-page');
  const signedList = list(3,[['a',coordinate(known)],['a',coordinate(missing)]]);
  const controller = new AbortController();
  let complete!: (value:unknown)=>void, notifications=0;
  const sample = createCommunityRecommendations(async filters=>{
    if (filters[0]?.kinds?.[0] === 30267) return rows(signedList);
    if (filters[0]?.kinds?.[0] === 0) return [];
    return new Promise(resolve=>{complete=resolve;});
  },controller.signal,()=>{notifications++;});
  assert.deepEqual((await sample.read([known])).items.map(x=>x.publication.address),[known.address]);
  controller.abort();
  complete(rows(missing.signed.event));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(notifications,0);
});

test('a later page carrying an older revision cannot replace the newer exact result', async () => {
  const old = app(), fresh = manifest({d:old.identifier,title:'New',timestamp:clock});
  const signedList = list(3,[['a',coordinate(old)]]);
  const sample = createCommunityRecommendations(async filters=>{
    if (filters[0]?.kinds?.[0] === 30267) return rows(signedList);
    if (filters[0]?.kinds?.[0] === 35129) return rows(fresh);
    return [];
  });
  assert.equal((await sample.read([])).items[0]?.publication.signed.event.id, fresh.id);
  assert.equal((await sample.read([old])).items[0]?.publication.signed.event.id, fresh.id);
});
