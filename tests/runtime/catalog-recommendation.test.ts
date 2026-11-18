import test from 'node:test';
import assert from 'node:assert/strict';
import {finalizeEvent, getPublicKey, type NostrEvent} from 'nostr-tools/pure';
import type {RelayQueryService, RelayQueryResult} from '../../src/network/native-relay-query.ts';
import {captureEventSnapshot, type UnsignedEventTemplate} from '../../src/security/event-snapshot.ts';
import {createCatalogRecommendations} from '../../src/napplets/catalog-recommendation.ts';

const secret = new Uint8Array(32).fill(41), account = getPublicKey(secret);
const other = getPublicKey(new Uint8Array(32).fill(42));
const coordinate = `35129:${other}:battleship`, previous = `35129:${other}:other`;
const signed = (tags: string[][] = [['d', 'napplets']], content = '', created_at = Math.floor(Date.now()/1000) - 10, signer = secret) =>
  JSON.parse(JSON.stringify(finalizeEvent({kind:30267, content, created_at, tags}, signer))) as NostrEvent;
const read = {type:'relay.catalogRecommendation', id:'read'};
function fixture(events: NostrEvent[] = []) {
  const state = {events, relays:['wss://relay.example.org'], incomplete:false, signing:true, active:true, calls:0,
    beforeQuery: null as null | (()=>Promise<void>), beforeSign: null as null | (()=>Promise<void>)};
  const queries: RelayQueryService = {
    catalog: {destinations:()=>state.relays, async read(){throw Error('Unexpected unscoped read');}},
    async query(){throw Error('Unexpected incomplete query');},
    async queryDetailed(filters, signal, active, options): Promise<RelayQueryResult> {
      state.calls++;
      assert.deepEqual(filters,[{kinds:[30267],authors:[account],'#d':['napplets'],limit:32}]);
      assert.deepEqual(options, {completeRelays: true});
      if(state.beforeQuery) await state.beforeQuery();
      active();
      assert.equal(signal.aborted,false);
      return {events:state.events.map(event=>({event})), incomplete:state.incomplete};
    },
  };
  const service = createCatalogRecommendations(account,queries,async()=>{if(state.beforeSign)await state.beforeSign();return state.signing;});
  const controller = new AbortController();
  const active = ()=>{if(!state.active)throw Error('Identity or generation revoked');};
  const dispatch = (input:unknown=read)=>service.dispatch(input,controller.signal,active) as Promise<Record<string,unknown>>;
  const prepare = (revision:string|null=state.events[0]?.id??null,target=coordinate, selected=account)=>dispatch({...read,id:'prepare',account:selected,revision,coordinate:target});
  const bind = (result:Record<string,unknown>)=>service.bind(captureEventSnapshot(result.event,account,result.relays));
  return {state,queries,service,controller,active,dispatch,prepare,bind};
}

test('complete own-list read selects newest signed event with lower-id tie and deduplicates coordinates',async()=>{
  const old=signed([['d','napplets'],['a',previous]],'old',100);
  const a=signed([['d','napplets'],['a',coordinate],['a',coordinate],['a','unsupported']], 'one',200);
  const b=signed([['d','napplets'],['a',previous]], 'two',200);
  const expected=a.id<b.id?a:b, f=fixture([old,b,a]);
  assert.deepEqual(await f.dispatch(),{status:'ready',account,revision:expected.id,recommended:expected===a?[coordinate]:[previous]});
});

test('empty complete network creates exact scoped list and exposes normalized configured destinations',async()=>{
  const f=fixture();f.state.relays=['wss://RELAY.example.org'];
  const result=await f.prepare();assert.equal(result.status,'prepared');
  assert.deepEqual(result.relays,['wss://relay.example.org/']);
  const event=result.event as UnsignedEventTemplate;
  assert.deepEqual(Object.keys(event).sort(),['content','created_at','kind','tags']);
  assert.equal(event.kind,30267);assert.equal(event.content,'');assert.deepEqual(event.tags,[['d','napplets'],['a',coordinate]]);
});

test('preparation preserves opaque content, unrelated tags and all prior recommendations',async()=>{
  const current=signed([['d','napplets'],['x','private-format','opaque'],['a',previous,'wss://hint.example.org','marker']], 'opaque encrypted or unknown content');
  const f=fixture([current]), result=await f.prepare();
  assert.equal(result.status,'prepared');
  const event=result.event as UnsignedEventTemplate;
  assert.equal(event.content,current.content);assert.deepEqual(event.tags,[...current.tags,['a',coordinate]]);assert.ok(event.created_at>current.created_at);
});

test('read-only, unavailable routes and incomplete network never produce replacement templates',async()=>{
  const f=fixture();f.state.signing=false;assert.deepEqual(await f.dispatch(),{status:'read-only'});assert.equal(f.state.calls,0);
  f.state.signing=true;f.state.relays=[];assert.deepEqual(await f.prepare(),{status:'unavailable'});
  f.state.relays=['wss://relay.example.org'];f.state.incomplete=true;assert.deepEqual(await f.prepare(),{status:'incomplete'});
  f.state.incomplete=false;f.state.relays=['wss://relay.example.org','wss://RELAY.example.org/'];assert.deepEqual(await f.prepare(),{status:'unavailable'});
});

test('absent detailed coverage fails closed instead of falling back to query',async()=>{
  const f=fixture();delete f.queries.queryDetailed;assert.deepEqual(await f.dispatch(),{status:'unavailable'});
});
test('an incomplete list exposes failed configured relays without producing a replacement',async()=>{
  const f=fixture();
  f.queries.queryDetailed=async()=>({events:[],incomplete:true,failedRelays:['wss://relay.example.org/']});
  assert.deepEqual(await f.dispatch(),{status:'incomplete',failedRelays:['wss://relay.example.org/']});
  assert.deepEqual(await f.prepare(),{status:'incomplete',failedRelays:['wss://relay.example.org/']});
  assert.equal(f.service.bind(captureEventSnapshot({kind:30267,created_at:1,content:'',tags:[['d','napplets']]},account,['wss://relay.example.org'])),null);
});

test('account mismatch, stale revision and duplicate recommendation are terminal without preparation',async()=>{
  const current=signed([['d','napplets'],['a',coordinate]]),f=fixture([current]);
  assert.deepEqual(await f.prepare(current.id,coordinate,other),{status:'account-changed'});
  assert.deepEqual(await f.prepare(null),{status:'stale'});
  assert.deepEqual(await f.prepare(),{status:'already-recommended'});
});

test('malformed or forged signed source never becomes the replacement base',async()=>{
  const cases=[signed([['d','napplets'],['d','other']]),signed([['d','napplets','extra']]),signed([['d','other']]),signed(undefined,'',undefined,new Uint8Array(32).fill(42))];
  const forged=signed();forged.content='altered';cases.push(forged);
  for(const current of cases)assert.deepEqual(await fixture([current]).prepare(),{status:'unavailable'});
});

test('future, same-second, oversized and unsupported tag-count sources fail closed',async()=>{
  const now=Math.floor(Date.now()/1000);
  assert.deepEqual(await fixture([signed(undefined,'',now+3600)]).prepare(),{status:'unavailable'});
  assert.deepEqual(await fixture([signed(undefined,'x'.repeat(8200))]).prepare(),{status:'unavailable'});
  assert.deepEqual(await fixture([signed([['d','napplets'],...Array.from({length:512},()=>['x'])])]).prepare(),{status:'unavailable'});
  const result=await fixture([signed(undefined,'',now)]).prepare();assert.ok(['stale','prepared'].includes(String(result.status)));
});

test('append exceeding native signed publication frame is refused without truncating original',async()=>{
  const current=signed(undefined,'x'.repeat(7750)),f=fixture([current]);
  assert.deepEqual(await f.prepare(),{status:'unavailable'});
  assert.equal(current.content.length,7750);
});

test('bind requires exact canonical account, event and ordered destinations; consumes once before review',async()=>{
  const f=fixture(),result=await f.prepare(), snapshot=captureEventSnapshot(result.event,account,result.relays);
  assert.equal(f.service.bind({...snapshot,hash:'0'.repeat(64)}),null);
  assert.equal(f.service.bind(captureEventSnapshot({...snapshot.event,content:'changed'},account,snapshot.destinations)),null);
  assert.equal(f.service.bind(captureEventSnapshot(snapshot.event,other,snapshot.destinations)),null);
  assert.equal(f.service.bind(captureEventSnapshot(snapshot.event,account,['wss://other.example.org'])),null);
  const hook=f.service.bind(snapshot);assert.equal(typeof hook,'function');assert.equal(f.service.bind(snapshot),null);
  await hook!(f.controller.signal,f.active);await hook!(f.controller.signal,f.active);
  await assert.rejects(hook!(f.controller.signal,f.active),/consumed/);
  assert.deepEqual(await f.prepare(),{status:'unavailable'});
});

test('bound hook rechecks latest list before signing and again before publishing',async()=>{
  const current=signed(),f=fixture([current]), result=await f.prepare(),hook=f.bind(result)!;
  await hook(f.controller.signal,f.active);
  f.state.events=[signed([['d','napplets'],['a',previous]],'changed')];
  await assert.rejects(hook(f.controller.signal,f.active),/stale/);
});

test('network changes during query or before hook fail closed',async()=>{
  const f=fixture();f.state.beforeQuery=async()=>{f.state.relays=['wss://other.example.org'];};
  assert.deepEqual(await f.prepare(),{status:'stale'});
  const g=fixture(),result=await g.prepare(),hook=g.bind(result)!;g.state.relays=['wss://other.example.org'];
  await assert.rejects(hook(g.controller.signal,g.active),/stale/);
});

test('revoked identity, cancellation and signer loss cannot pass bound preflight',async()=>{
  for(const change of ['identity','cancel','signer']){
    const f=fixture(),result=await f.prepare(),hook=f.bind(result)!;
    if(change==='identity')f.state.active=false;else if(change==='cancel')f.controller.abort();else f.state.signing=false;
    await assert.rejects(hook(f.controller.signal,f.active));
  }
});

test('overlapping dispatch is denied and a fresh preparation supersedes a lost host response',async()=>{
  const f=fixture();let release!:()=>void;
  f.state.beforeQuery=()=>new Promise<void>(resolve=>{release=resolve;});
  const first=f.prepare();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(await f.prepare(),{status:'unavailable'});release();
  const result=await first;assert.equal(result.status,'prepared');f.state.beforeQuery=null;
  const replacement=await f.prepare(null,previous);assert.equal(replacement.status,'prepared');
  assert.equal(f.bind(result),null);assert.equal(typeof f.bind(replacement),'function');
});

test('request decoding rejects extra fields, getters and invalid coordinates without querying',async()=>{
  const f=fixture();
  for(const input of [{...read,extra:true},{...read,coordinate:'35129:bad:app',account,revision:null},Object.defineProperty({...read},'coordinate',{get(){throw Error('Getter ran');},enumerable:true})]){
    assert.deepEqual(await f.dispatch(input),{status:'unavailable'});
  }
  assert.equal(f.state.calls,0);
});


test('a failed bound attempt cannot be revived after signer availability returns',async()=>{
  const f=fixture(),result=await f.prepare(),hook=f.bind(result)!;
  f.state.signing=false;await assert.rejects(hook(f.controller.signal,f.active),/read-only/);
  f.state.signing=true;await assert.rejects(hook(f.controller.signal,f.active),/consumed/);
});

test('an in-flight bound check cannot be duplicated or race a second write from its base',async()=>{
  const f=fixture(),result=await f.prepare(),hook=f.bind(result)!;
  let release!:()=>void;
  f.state.beforeSign=()=>new Promise<void>(resolve=>{release=resolve;});
  const checking=hook(f.controller.signal,f.active);
  await assert.rejects(hook(f.controller.signal,f.active),/consumed/);
  release();await checking;f.state.beforeSign=null;
  assert.deepEqual(await f.prepare(null,previous),{status:'unavailable'});
});


test('known-unsent decline and signer failure permit explicit retry on the same remote revision',async()=>{
  for(const stage of ['declined','signed-check','signer-failed']){
    const f=fixture(),result=await f.prepare(),hook=f.bind(result)!;
    if(stage==='signed-check')await hook(f.controller.signal,f.active);
    if(stage==='signer-failed'){
      f.state.signing=false;await assert.rejects(hook(f.controller.signal,f.active));f.state.signing=true;
    }
    hook.release(true);
    assert.deepEqual(await f.dispatch(),{status:'ready',account,revision:null,recommended:[]});
    const retry=await f.prepare();assert.equal(retry.status,'prepared');
    await assert.rejects(hook(f.controller.signal,f.active),/consumed/);
    const fresh=f.bind(retry)!;await fresh(f.controller.signal,f.active);
  }
});

test('sent or uncertain publication keeps the old-base lock until remote revision changes',async()=>{
  const f=fixture(),result=await f.prepare(),hook=f.bind(result)!;
  await hook(f.controller.signal,f.active);hook.release();
  assert.deepEqual(await f.prepare(),{status:'unavailable'});
  const current=signed([['d','napplets'],['a',coordinate]]);f.state.events=[current];
  const retry=await f.prepare(current.id,previous);assert.equal(retry.status,'prepared');
});

test('a malformed response after preparation does not trap a fresh explicit retry',async()=>{
  const f=fixture();await f.prepare();f.state.incomplete=true;
  assert.deepEqual(await f.prepare(),{status:'incomplete'});
  f.state.incomplete=false;const retry=await f.prepare(null,previous);assert.equal(retry.status,'prepared');
});

test('stale bound attempt can be released and retried against a fresh scoped read',async()=>{
  const f=fixture(),result=await f.prepare(),hook=f.bind(result)!;
  const current=signed([['d','napplets'],['a',previous]]);f.state.events=[current];
  await assert.rejects(hook(f.controller.signal,f.active),/stale/);hook.release(true);
  const readResult=await f.dispatch();assert.equal(readResult.revision,current.id);
  assert.equal((await f.prepare(current.id)).status,'prepared');
});
