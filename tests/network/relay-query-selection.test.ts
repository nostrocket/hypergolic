import test from 'node:test';
import assert from 'node:assert/strict';
import {finalizeEvent, type NostrEvent} from 'nostr-tools/pure';
import {createNativeRelayQuery} from '../../src/network/native-relay-query.ts';
import {QUERY_LIMITS, type QueryFilter} from '../../src/network/relay-query-contract.ts';
const secret = new Uint8Array(32); secret[31] = 1;
const peers = ['wss://one.example.com','wss://two.example.com','wss://three.example.com'];
const signed = (index:number, bytes=0, kind=1, time=index) => JSON.parse(JSON.stringify(finalizeEvent({
  kind,created_at:1000+time,content:`row-${index}`+'x'.repeat(bytes),tags:[['t','shared']],
},secret))) as NostrEvent;
const newest = (events:readonly NostrEvent[]) => [...events].sort((a,b)=>b.created_at-a.created_at||a.id.localeCompare(b.id));
function harness(batches:readonly (readonly NostrEvent[])[], outbox=true,
  change?:(frames:string[],index:number,sub:string)=>string[]) {
  let next=0; const calls:{relay:string;filters:unknown}[]=[];
  const port={newInstanceId:()=>`00000000-0000-4000-8000-${String(++next).padStart(12,'0')}`,
    cancelPublishedRelay(){},async queryPublishedRelay(_id:string,relay:string,wire:string,sub:string) {
      calls.push({relay,filters:JSON.parse(wire).slice(2)});
      const index=peers.indexOf(relay),frames=[...batches[index]!.map(e=>JSON.stringify(['EVENT',sub,e])),JSON.stringify(['EOSE',sub])];
      return change?change(frames,index,sub):frames;
    }};
  return {calls,service:createNativeRelayQuery(port,()=>peers,8000,outbox?{outbox:true,allowPartialOnLimit:true}:{})};
}
for(const mode of ['event-union','byte-union','four-filters','four-filters-bytes'] as const) {
  test(`complete narrow ${mode} selects requested rows before aggregate budgets`,async()=>{
    const four=mode.startsWith('four-filters'),bytes=mode.includes('byte');
    const perPeer=mode==='four-filters-bytes'?32:bytes?60:80,perFilter=mode==='four-filters-bytes'?8:25;
    const all=Array.from({length:perPeer*3},(_,i)=>signed(i,bytes?(four?7000:3500):0,four?1+i%4:1));
    const filters:QueryFilter[]=four?[1,2,3,4].map(kind=>({kinds:[kind],limit:perFilter})):[{kinds:[1],limit:80}];
    const h=harness(peers.map((_,i)=>all.slice(i*perPeer,(i+1)*perPeer)));
    const result=await h.service.queryDetailed(filters,new AbortController().signal,()=>{});
    const expected=four?newest(all.filter(e=>e.created_at>=1000+all.length-perFilter*4)):newest(all).slice(0,80);
    assert.equal(expected.length,four?perFilter*4:80);
    assert.deepEqual(result.events.map(r=>r.event.id),expected.map(e=>e.id));
    assert.equal(result.incomplete,false);assert.equal(h.calls.length,3);
    assert.ok(Buffer.byteLength(JSON.stringify(expected))<QUERY_LIMITS.resultBytes);
  });
}
test('selection keeps timestamp/id ties, overlapping filters and surviving relay hints exact',async()=>{
  const old=signed(0,0,1,0),ties=newest([signed(1,0,1,10),signed(2,0,1,10),signed(3,0,1,10)]);
  const h=harness([[old],[ties[0]!,ties[2]!],[ties[0]!,ties[1]!]]);
  const result=await h.service.queryDetailed([{kinds:[1],limit:2},{'#t':['shared'],limit:2}],new AbortController().signal,()=>{});
  assert.equal(result.incomplete,false);assert.deepEqual(result.events.map(r=>r.event.id),ties.slice(0,2).map(e=>e.id));
  assert.deepEqual(result.relayHints?.[ties[0]!.id],peers.slice(1));
  assert.deepEqual(result.relayHints?.[ties[1]!.id],[peers[2]]);
  assert.equal(result.relayHints?.[old.id],undefined);assert.equal(result.relayHints?.[ties[2]!.id],undefined);
});
test('strict raw Relay selection succeeds when requested output fits despite larger cross-peer union',async()=>{
  const all=Array.from({length:36},(_,i)=>signed(i)),h=harness(peers.map((_,i)=>all.slice(i*12,(i+1)*12)),false);
  const result=await h.service.query([{kinds:[1],limit:12}],new AbortController().signal,()=>{});
  assert.deepEqual(result.map(r=>r.event.id),newest(all).slice(0,12).map(e=>e.id));assert.equal(h.calls.length,3);
});
for(const mode of ['needed-count','needed-bytes','failed-peer','invalid-signature','missing-eose'] as const) {
 test(`selection preserves genuine partial result for ${mode}`,async()=>{
  const needed=mode.startsWith('needed');
  const all=Array.from({length:needed?240:80},(_,i)=>signed(i,mode==='needed-bytes'?3500:0,mode==='needed-count'?1+Math.floor(i/80):1));
  const batches=needed?peers.map((_,i)=>all.slice(i*80,(i+1)*80)):peers.map(()=>all);
  const h=harness(batches,true,(frames,i,sub)=>{
    if(i!==1)return frames;
    if(mode==='failed-peer')throw Error('controlled carrier failure');
    if(mode==='invalid-signature')return [JSON.stringify(['EVENT',sub,{...all[0],sig:'0'.repeat(128)}]),JSON.stringify(['EOSE',sub])];
    return mode==='missing-eose'?frames.slice(0,-1):frames;
  });
  const filters:QueryFilter[]=mode==='needed-count'?[1,2,3].map(kind=>({kinds:[kind],limit:80})):[{kinds:[1],limit:needed?200:80}];
  const result=await h.service.queryDetailed(filters,new AbortController().signal,()=>{});
  assert.equal(result.incomplete,true);assert.ok(result.events.length<=200);
  assert.ok(result.events.reduce((n,r)=>n+Buffer.byteLength(JSON.stringify(r.event)),0)<=QUERY_LIMITS.resultBytes);
  if(!needed)assert.deepEqual(result.events.map(r=>r.event.id),newest(all).map(e=>e.id));
  if(mode==='needed-count')assert.equal(result.events.length,200);
 });
}
