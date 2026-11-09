import assert from 'node:assert/strict';
import {test} from 'node:test';
import {finalizeEvent,generateSecretKey,type NostrEvent} from 'nostr-tools/pure';
import {encodeBytes,nsecEncode,nprofileEncode,npubEncode} from 'nostr-tools/nip19';
import {commonFailure,parseCommonRequest} from '../../src/common/common-contract.ts';
import {decodeCommonNip19,encodeCommonNip19} from '../../src/common/common-codec.ts';
import {createNativeRelayQuery} from '../../src/network/native-relay-query.ts';
import {readCommon} from '../../src/common/common-service.ts';
import type {NativeRegistration} from '../../src/runtime/capability-protocol.ts';
import {createOutboxReadService,type OutboxReadService} from '../../src/outbox/read-service.ts';
import {parseOutboxRelayList} from '../../src/outbox/relay-list.ts';

const key = generateSecretKey();
const profile:NostrEvent = JSON.parse(JSON.stringify(finalizeEvent({kind:0,created_at:10,tags:[],
  content:JSON.stringify({name:'Profile name',display_name:'Published name',picture:'https://image.nostr.net/picture.jpg'})},key)));
const publisher = profile.pubkey;
const signal = () => new AbortController().signal;
const active = () => {};
function registration(domains:readonly string[]):NativeRegistration {
  return {sessionId:'session',generation:'generation',epoch:1,user:'1'.repeat(64),publisher:'2'.repeat(64),
    appId:'common-test',version:'3'.repeat(64),instanceId:'instance',fixture:'published',domains};
}
function request(type:string,fields:Record<string,unknown> = {}) {
  return parseCommonRequest({type,id:'request',...fields});
}

test('Common public NIP-19 helpers round trip all six types without using a secret', () => {
  const variants = [
    {type:'npub',hex:publisher},{type:'note',hex:profile.id},
    {type:'nprofile',pubkey:publisher,relays:['wss://nos.lol']},
    {type:'nevent',eventId:profile.id,author:publisher,kind:0,relays:['wss://nos.lol']},
    {type:'naddr',identifier:'profile pointer',pubkey:publisher,kind:30000,relays:['wss://nos.lol']},
    {type:'nrelay',relay:'wss://nos.lol'},
  ];
  for (const variant of variants) {
    const encoded = encodeCommonNip19(variant);
    assert.equal(encoded.ok,true);
    const decoded = decodeCommonNip19((encoded as {value:string}).value);
    assert.equal(decoded.ok,true);
    assert.equal(decoded.nip19Type,variant.type);
    if (variant.type === 'npub') {assert.equal(decoded.hex,publisher);assert.equal(decoded.pubkey,publisher);}
    if (variant.type === 'nrelay') assert.equal(decoded.relay,'wss://nos.lol');
  }
  assert.deepEqual(encodeCommonNip19({type:'nsec',hex:publisher}),{ok:false,error:'unsupported-nip19-type'});
  assert.deepEqual(decodeCommonNip19(nsecEncode(key)),{ok:false,error:'unsupported-nip19-type'});
});

test('Common codecs bound identifiers and reject malformed public TLVs while ignoring unknown types', () => {
  assert.equal(decodeCommonNip19('x'.repeat(5001)).ok,false);
  assert.equal(encodeCommonNip19({type:'nprofile',pubkey:publisher,relays:Array(17).fill('wss://nos.lol')}).ok,false);
  assert.equal(encodeCommonNip19({type:'naddr',pubkey:publisher,identifier:'a'.repeat(256),kind:30000}).ok,false);
  const bytes = Uint8Array.from(Buffer.from(publisher,'hex'));
  const unknown = encodeBytes('nprofile',Uint8Array.from([0,32,...bytes,99,2,255,255]));
  assert.equal(decodeCommonNip19(unknown).pubkey,publisher);
  const invalidUtf8 = encodeBytes('nprofile',Uint8Array.from([0,32,...bytes,1,1,255]));
  assert.equal(decodeCommonNip19(invalidUtf8).ok,false);
  const duplicateRelay = encodeBytes('nrelay',Uint8Array.from([0,1,97,0,1,98]));
  assert.equal(decodeCommonNip19(duplicateRelay).ok,false);
  assert.equal(decodeCommonNip19(encodeBytes('nrelay',Uint8Array.from([0,10,97]))).ok,false);
  for (const relay of ['https://nos.lol','wss://user@nos.lol','wss://nos.lol/#part','wss://n\u00f6s.lol']) {
    assert.equal(encodeCommonNip19({type:'nrelay',relay}).ok,false);
    assert.equal(encodeCommonNip19({type:'nprofile',pubkey:publisher,relays:[relay]}).ok,false);
  }
  const relayBytes = new TextEncoder().encode('wss://nos.lol');
  const withUnknown = encodeBytes('nrelay',Uint8Array.from([99,1,255,0,relayBytes.length,...relayBytes]));
  assert.equal(decodeCommonNip19(withUnknown).relay,'wss://nos.lol');
  const rawRelay = encodeBytes('nrelay',relayBytes);
  assert.equal(decodeCommonNip19(rawRelay).ok,false);
  assert.equal(decodeCommonNip19(withUnknown.slice(0,-1)+(withUnknown.endsWith('q')?'p':'q')).ok,false);
});

test('Common alone provides codecs and explicit unsupported operations without implicit read grants', async () => {
  const owner = registration(['common']);
  const services = {token:'exact-lease'};
  assert.equal((await readCommon(request('common.encodeNip19',{input:{type:'npub',hex:publisher}}),owner,signal(),active,services)).ok,true);
  const denied = await readCommon(request('common.getProfile',{target:publisher}),owner,signal(),active,services);
  assert.deepEqual(denied,{type:'common.getProfile.result',id:'request',ok:false,pubkey:publisher,error:'unsupported'});
  assert.equal((await readCommon(request('common.follows'),owner,signal(),active,services)).error,'unsupported');
  for (const type of ['common.follow','common.unfollow','common.react','common.report']) {
    assert.deepEqual(await readCommon(request(type,type==='common.follow'||type==='common.unfollow'?{pubkeys:[npubEncode(publisher)]}:type==='common.react'?{targetEventId:profile.id,reaction:'+'}:{target:{type:'pubkey',pubkey:publisher},reason:'spam',text:''}),owner,signal(),active,services),{type:type+'.result',id:'request',ok:false,error:'unsupported'});
  }
  await assert.rejects(readCommon(request('common.follows'),registration(['identity']),signal(),active,services));
});

test('Common profile lookup uses the actual Relay grant and verified foreign data without identity cache writes', async () => {
  let reads = 0;
  const target = nprofileEncode({pubkey:publisher,relays:['wss://not-selected.nostr.net']});
  const result = await readCommon(request('common.getProfile',{target}),registration(['common','relay']),signal(),active,{
    token:'lease',queries:{async query() {assert.fail('Common needs completion detail');},async queryDetailed(filters) {
      reads++;assert.deepEqual(filters,[{authors:[publisher],kinds:[0],limit:4}]);
      return {events:[{event:profile}],incomplete:false};
    }},identity:{async read() {assert.fail('foreign profile must not enter own identity cache');}},
  });
  assert.equal(reads,1);
  assert.equal(result.pubkey,publisher);
  assert.deepEqual(result.profile,{name:'Profile name',displayName:'Published name',picture:'https://image.nostr.net/picture.jpg'});
  assert.deepEqual(result.result,{event:profile});
});

test('Common profile lookup borrows the actual Outbox grant without making raw Relay available', async () => {
  let calls = 0;
  const outbox:OutboxReadService = {
    async query(input,user,_signal,check,token) {
      check();calls++;assert.equal(token,'original-common-token');assert.equal(user,'1'.repeat(64));
      assert.deepEqual(input,{type:'outbox.query',id:'request',filters:[{authors:[publisher],kinds:[0],limit:4}],options:{authors:[publisher],limit:4}});
      return {events:[{event:profile}],incomplete:false,plan:{relays:['wss://nos.lol'],source:'nip65',missingAuthors:[],incomplete:false}};
    },async resolveRelays() {assert.fail('Common never exposes relay resolution');},
  };
  const result = await readCommon(request('common.getProfile',{target:publisher}),registration(['common','outbox']),signal(),active,{
    token:'original-common-token',outbox,queries:{async query() {assert.fail('no raw Relay grant');}},
  });
  assert.equal(calls,1);assert.equal(result.ok,true);assert.equal(result.pubkey,publisher);
});

test('Common profile lookup does not opt into partial oversized Outbox routes', async () => {
  const tags = Array.from({length:19},(_,i)=>['r',`wss://relay${i}.nostr.net`,'write']);
  const signed = finalizeEvent({kind:10002,created_at:1,content:'',tags},key);
  const list = parseOutboxRelayList(JSON.parse(JSON.stringify(signed)),publisher);
  let sent = 0;
  const outbox = createOutboxReadService({async resolve(){return {list,source:'nip65',incomplete:false};}},{
    newInstanceId:()=> '00000000-0000-4000-8000-000000000001',
    async queryOutboxRelay(_token,_id,_url,_wire,sub){sent++;return [JSON.stringify(['EVENT',sub,profile]),JSON.stringify(['EOSE',sub])];},
    cancelPublishedRelay(){},
  },()=>({networkRelays:['wss://network.nostr.net'],lookupRelays:[]}));
  const result = await readCommon(request('common.getProfile',{target:publisher}),registration(['common','outbox']),signal(),active,
    {token:'original-common-token',outbox});
  assert.equal(sent,0);
  assert.deepEqual(result,{type:'common.getProfile.result',id:'request',ok:false,pubkey:publisher,error:'relay-timeout'});
});

test('Common distinguishes an observed empty profile from failure and rechecks revocation before returning', async () => {
  const owner = registration(['common','relay']);
  const lookup = request('common.getProfile',{target:publisher});
  const empty = await readCommon(lookup,owner,signal(),active,{token:'lease',queries:{async query(){assert.fail();},async queryDetailed(){return {events:[],incomplete:false};}}});
  assert.deepEqual(empty,{type:'common.getProfile.result',id:'request',ok:true,pubkey:publisher,profile:null});
  for (const event of [{...profile,content:'changed'},{...profile,sig:'0'.repeat(128)}]) {
    const result = await readCommon(lookup,owner,signal(),active,{token:'lease',queries:{async query(){assert.fail();},async queryDetailed(){return {events:[{event}],incomplete:false};}}});
    assert.equal(result.ok,false);assert.equal(result.profile,undefined);
  }
  let live = true;
  await assert.rejects(readCommon(lookup,owner,signal(),()=>{if(!live)throw Error('revoked');},{token:'lease',queries:{
    async query(){assert.fail();},async queryDetailed(){live=false;return {events:[{event:profile}],incomplete:false};},
  }}),/revoked/);
  assert.equal((await readCommon(request('common.getProfile',{target:nsecEncode(key)}),owner,signal(),active,{token:'lease'})).error,'invalid-profile-target');
});

test('Common follows uses only the current native account and keeps canonical wire correlation', async () => {
  const owner = registration(['common','identity']);
  const result = await readCommon(request('common.follows'),owner,signal(),active,{token:'lease',identity:{
    async read(input,captured) {
      assert.deepEqual(input,{type:'identity.getFollows',id:'request'});assert.equal(captured,owner);
      return {type:'identity.getFollows.result',id:input.id,pubkeys:[publisher]};
    },
  }});
  assert.deepEqual(result,{type:'common.follows.result',id:'request',ok:true,pubkeys:[publisher]});
  assert.equal(commonFailure({type:'common.getProfile',id:'é'.repeat(65)}),null);
  assert.throws(()=>parseCommonRequest({type:'common.follows',id:'test',target:publisher}));
  assert.throws(()=>parseCommonRequest({type:'common.decodeNip19',id:'test',get value(){throw Error('getter');}}));
});


test('Common retains actual native Relay completion and never reports a partial empty lookup as absent', async () => {
  for (const mode of ['empty','failed-peer','found-partial'] as const) {
    let counter = 0;
    const calls:string[] = [];
    const queries = createNativeRelayQuery({
      newInstanceId:()=>`00000000-0000-4000-8000-${String(++counter).padStart(12,'0')}`,
      cancelPublishedRelay:()=>{},
      async queryPublishedRelay(_id,url,_wire,sub) {
        calls.push(url);
        if (url === 'wss://second.example.com' && mode !== 'empty') throw Error('offline');
        return [...(mode === 'found-partial' ? [JSON.stringify(['EVENT',sub,profile])] : []),JSON.stringify(['EOSE',sub])];
      },
    },()=>['wss://first.example.com','wss://second.example.com']);
    const result = await readCommon(request('common.getProfile',{target:publisher}),registration(['common','relay']),signal(),active,{token:'lease',queries});
    assert.equal(calls.length,2);
    if (mode === 'empty') assert.deepEqual(result,{type:'common.getProfile.result',id:'request',ok:true,pubkey:publisher,profile:null});
    else if (mode === 'failed-peer') assert.equal(result.error,'relay-timeout');
    else {assert.equal(result.ok,true);assert.equal((result.profile as {displayName:string}).displayName,'Published name');}
  }
});

test('Common defers only public profile and own follows reads under the existing safe-read profile', async () => {
  const {canDeferCapability} = await import('../../src/runtime/capability-protocol.ts');
  for (const type of ['common.getProfile','common.follows']) assert.equal(canDeferCapability(type),true);
  for (const type of ['common.encodeNip19','common.decodeNip19','common.follow','common.unfollow','common.react','common.report']) {
    assert.equal(canDeferCapability(type),false);
  }
});

test('queued Common-only reads return correlated unsupported without querying or reading identity', async t => {
  const {setup,deferred} = await import('../storage/harness.ts');
  const {NativeLeases} = await import('./native-leases.ts');
  const {createCapabilityBroker} = await import('../../src/runtime/capability-broker.ts');
  const {database} = await setup(t), native = new NativeLeases();
  const owner = registration(['common','relay']);
  const blocked = deferred();
  let calls = 0;
  const broker = createCapabilityBroker(database,native,{registration:owner,assertActive(){}},{
    async query(){assert.fail('Common needs detailed completion');},
    async queryDetailed(){calls++;await blocked.promise;return {events:[],incomplete:false};},
  });
  const tokens = Array.from({length:4},(_,index)=>native.add(owner,{type:'common.getProfile',id:`profile-${index}`,target:publisher}));
  const pending = tokens.map(token=>broker.dispatch(token));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,2);
  blocked.resolve();await Promise.all(pending);
  assert.equal(calls,4);
  const common = registration(['common']);
  const staticBroker = createCapabilityBroker(database,native,{registration:common,assertActive(){}},{
    async query(){assert.fail('Common-only never queries');},async queryDetailed(){assert.fail('Common-only never queries');},
  },undefined,undefined,{async read(){assert.fail('Common-only never reads Identity');}});
  const denied = Array.from({length:4},(_,index)=>index%2===0
    ? {type:'common.getProfile',id:`profile-denied-${index}`,target:publisher}
    : {type:'common.follows',id:`follows-denied-${index}`});
  const deniedTokens = denied.map(request=>native.add(common,request));
  await Promise.all(deniedTokens.map(token=>staticBroker.dispatch(token)));
  for(const [index,request] of denied.entries()) {
    assert.deepEqual(native.results.get(deniedTokens[index]!),{type:request.type+'.result',id:request.id,ok:false,
      ...(request.type==='common.getProfile'?{pubkey:publisher}:{pubkeys:[]}),error:'unsupported'});
  }
});
