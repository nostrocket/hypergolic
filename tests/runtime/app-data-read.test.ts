import test from 'node:test';
import assert from 'node:assert/strict';
import {finalizeEvent,getPublicKey} from 'nostr-tools/pure';
import {createOutboxReadService} from '../../src/outbox/read-service.ts';
import {deriveAppDataScope,dataTags} from '../../src/app-data/app-data-contract.ts';
import type {AppDataContext} from '../../src/app-data/app-data-context.ts';
import {deferred} from '../storage/harness.ts';
const key=new Uint8Array(32).fill(43),author=getPublicKey(key),publisher='2'.repeat(64),scope=deriveAppDataScope({publisher,kind:35129,identifier:'read-app'});
const peers=['wss://one.example.com','wss://two.example.com'];
const context:AppDataContext={sourceKind:35129,policy:{profile:'soy.app-data/1',scope,maxContentBytes:3072,relays:peers,defaultRelays:[peers[0]!]}};
const event=finalizeEvent({kind:30078,created_at:1,tags:dataTags(scope,'levels','foreign-public-record','example.level',1).map(row=>[...row]),content:JSON.stringify({schema:'example.level',version:1,title:'Public',previous:null,deleted:false,data:{}})},key);
const list={type:'outbox.query',id:'list',filters:[{kinds:[30078],'#s':[scope],'#c':['levels'],'#L':['soy.app-data/1'],limit:40}],options:{relays:[peers[0]],timeoutMs:1000}};
function harness(){let seq=0,network=peers.slice(),partial=false,gate:Promise<void>|null=null;const calls:string[]=[],cancelled:string[]=[];let discoveries=0;
  const service=createOutboxReadService({async resolve(){discoveries++;throw Error('NIP65 discovery must not replace app-data storage targets');}},
    {newInstanceId:()=>`00000000-0000-4000-8000-${String(++seq).padStart(12,'0')}`,async queryOutboxRelay(token,_id,relay,_wire,sub){assert.equal(token,'actual-outbox-token');calls.push(relay);if(gate)await gate;
      return [JSON.stringify(['EVENT',sub,event]),...(partial&&relay===peers[0]?[]:[JSON.stringify(['EOSE',sub])])];},cancelPublishedRelay(id){cancelled.push(id);}},
    ()=>({networkRelays:network,lookupRelays:['wss://lookup.example.com']}));
  return {service,calls,cancelled,discoveries:()=>discoveries,setNetwork(value:string[]){network=value;},setPartial(){partial=true;},setGate(value:Promise<void>){gate=value;}};
}
const signal=()=>new AbortController().signal;
test('profile list and foreign-author exact-address reads use only explicit configured storage peers with existing Outbox token',async()=>{
  const h=harness();const rows=await h.service.query(list,author,signal(),()=>{},'actual-outbox-token',{appData:context});assert.equal(rows.events.length,1);assert.equal(rows.incomplete,false);assert.deepEqual(h.calls,[peers[0]]);assert.equal(h.discoveries(),0);
  const exact={...list,id:'get-record',filters:[{authors:[author],kinds:[30078],'#d':[event.tags[0]![1]!],limit:1}],options:{relays:[peers[1]],timeoutMs:1000}};
  const got=await h.service.query(exact,'3'.repeat(64),signal(),()=>{},'actual-outbox-token',{appData:context});assert.equal(got.events[0]?.event.pubkey,author);assert.deepEqual(h.calls,peers);assert.equal(h.discoveries(),0);
});
test('profile routing rejects unconfigured targets/current Network drift before native admission',async()=>{
  const h=harness();await assert.rejects(h.service.query({...list,options:{...list.options,relays:['wss://foreign.example.com']}},author,signal(),()=>{},'actual-outbox-token',{appData:context}));assert.equal(h.calls.length,0);
  h.setNetwork([peers[1]!,peers[0]!]);await assert.rejects(h.service.query(list,author,signal(),()=>{},'actual-outbox-token',{appData:context}));assert.equal(h.calls.length,0);
});
test('missing EOSE is incomplete and a mid-await settings change cancels instead of returning stale profile data',async()=>{
  const partial=harness();partial.setPartial();const rows=await partial.service.query({...list,options:{...list.options,relays:peers}},author,signal(),()=>{},'actual-outbox-token',{appData:context});assert.equal(rows.incomplete,true);
  const h=harness(),gate=deferred();h.setGate(gate.promise);const work=h.service.query(list,author,signal(),()=>{},'actual-outbox-token',{appData:context});await new Promise(resolve=>setImmediate(resolve));h.setNetwork([peers[1]!,peers[0]!]);gate.resolve();await assert.rejects(work);assert.deepEqual(h.calls,[peers[0]]);
});
test('ordinary queries retain original routing and never gain profile authority from arbitrary kind30078 content',async()=>{
  const h=harness();const query={...list,filters:[{authors:[author],kinds:[30078],limit:1}]};const result=await h.service.query(query,author,signal(),()=>{},'actual-outbox-token',{appData:context});
  assert.equal(h.discoveries(),1);assert.equal(result.incomplete,true);assert.deepEqual(h.calls,peers);
});
