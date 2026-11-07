import test from 'node:test';
import assert from 'node:assert/strict';
import {finalizeEvent,getPublicKey} from 'nostr-tools/pure';
import {nip19} from 'nostr-tools';
import {captureEventSnapshot} from '../../src/security/event-snapshot.ts';
import {createCommonSocialPlanner} from '../../src/common/social-plan.ts';
import {parseCommonRequest} from '../../src/common/common-contract.ts';
const key=new Uint8Array(32).fill(2),user=getPublicKey(key),other='3'.repeat(64),npub=nip19.npubEncode(other),relay='wss://relay.damus.io/';
const registration={sessionId:'session',generation:'generation',epoch:1,user,publisher:'4'.repeat(64),appId:'test',version:'5'.repeat(64),instanceId:'instance',fixture:'published',domains:['common','identity','relay'],commonProfile:'social-v1' as const};
const sign=(kind:number,tags:string[][],content='',created_at=1)=>JSON.parse(JSON.stringify(finalizeEvent({kind,tags,content,created_at},key))) as ReturnType<typeof finalizeEvent>;
function harness(initial=sign(3,[['p','6'.repeat(64),'wss://hint.example.org','Petname'],['t','keep']],'preserve')){
  let basis:ReturnType<typeof sign>|null=initial,partial=false,queryCount=0,publishCount=0;
  const target=sign(30023,[['d','article']],'target');
  const planner=createCommonSocialPlanner({async signer(){return true;},async query(filters,_r,_s,active){active();queryCount++;const rows=filters[0]?.ids?[target]:(basis?[basis]:[]);return {events:rows.map(event=>({event})),incomplete:partial};},
    async publication(event,id,_r,_s,active){active();publishCount++;const snapshot=captureEventSnapshot(event,user,[relay]);return {requestId:id,event:snapshot,destinations:[{relay,sources:[{kind:'network-fallback'}]}],requiredInboxes:[],ownSource:'network-fallback',ancillary:null};}},()=>2000);
  return {planner,target,setBasis(value:typeof basis){basis=value;},setPartial(){partial=true;},counts:()=>({queryCount,publishCount})};
}
const signal=()=>new AbortController().signal,active=()=>{};
test('follow preserves content, unrelated tags and p metadata; changed fresh basis cancels',async()=>{
  const h=harness(),plan=await h.planner.plan({type:'common.follow',id:'f',pubkeys:[npub,npub]},registration,signal(),active);
  assert.equal(plan.publication?.event.event.kind,3);assert.equal(plan.publication?.event.event.content,'preserve');
  assert.deepEqual(plan.publication?.event.event.tags,[['p','6'.repeat(64),'wss://hint.example.org','Petname'],['t','keep'],['p',other]]);
  await h.planner.revalidate(plan,signal(),active);h.setBasis(sign(3,[['p','7'.repeat(64)]],'changed',3));
  await assert.rejects(h.planner.revalidate(plan,signal(),active),/follow-list-changed/);h.planner.release(plan);
});
test('idempotent follow/unfollow and complete empty basis prepare no publication; partial basis cannot mutate',async()=>{
  const h=harness(sign(3,[['p',other,'wss://hint.example.org','Name']],'keep'));
  const plan=await h.planner.plan({type:'common.follow',id:'n',pubkeys:[npub]},registration,signal(),active);
  assert.equal(plan.publication,null);assert.equal(h.counts().publishCount,0);h.planner.release(plan);
  h.setBasis(null);const empty=await h.planner.plan({type:'common.unfollow',id:'u',pubkeys:[npub]},registration,signal(),active);
  assert.equal(empty.publication,null);h.planner.release(empty);h.setPartial();
  await assert.rejects(h.planner.plan({type:'common.follow',id:'p',pubkeys:[npub]},registration,signal(),active),/relay-timeout/);assert.equal(h.counts().publishCount,0);
});
test('reaction binds native signed target, address and one matching custom emoji tag',async()=>{
  const h=harness(),plan=await h.planner.plan({type:'common.react',id:'r',targetEventId:h.target.id,reaction:':wave:',customEmojiHref:'https://emoji.example.org/wave.png'},registration,signal(),active);
  assert.deepEqual(plan.publication?.event.event.tags,[['e',h.target.id],['p',user],['a',`30023:${user}:article`],['emoji','wave','https://emoji.example.org/wave.png']]);h.planner.release(plan);
  await assert.rejects(h.planner.plan({type:'common.react',id:'r2',targetEventId:h.target.id,reaction:'two words'},registration,signal(),active),/invalid-reaction/);
});
test('report resolves event author and rejects mismatch; caller relay never chooses destination',async()=>{
  const h=harness(),plan=await h.planner.plan({type:'common.report',id:'r',target:{type:'event',id:h.target.id,relay:'wss://guest.invalid'},reason:'spam',text:'report text'},registration,signal(),active);
  assert.deepEqual(plan.publication?.event.event.tags,[['e',h.target.id,'spam'],['p',user]]);assert.deepEqual(plan.publication?.event.destinations,[relay]);h.planner.release(plan);
  await assert.rejects(h.planner.plan({type:'common.report',id:'r2',target:{type:'event',id:h.target.id,pubkey:other},reason:'spam',text:''},registration,signal(),active),/author-unresolved/);
});
test('old grant and missing actual dependencies deny; user mutations serialize; stale authority cannot prepare',async()=>{
  const h=harness();for(const r of [{...registration,commonProfile:undefined},{...registration,domains:['common','relay']},{...registration,domains:['common','identity']}])await assert.rejects(h.planner.plan({type:'common.follow',id:'f',pubkeys:[npub]},r,signal(),active),/unsupported/);
  const p=await h.planner.plan({type:'common.follow',id:'f',pubkeys:[npub]},registration,signal(),active);
  await assert.rejects(h.planner.plan({type:'common.follow',id:'f2',pubkeys:[npub]},registration,signal(),active),/relay-timeout/);h.planner.release(p);
  await assert.rejects(h.planner.plan({type:'common.follow',id:'f3',pubkeys:[npub]},registration,signal(),()=>{throw Error('revoked');}),/revoked/);
});
test('complete larger list refuses unchanged8192 byte EVENT bound without truncating/preparing publication',async()=>{
  const h=harness(sign(3,[['t','x'.repeat(8100)]]));
  await assert.rejects(h.planner.plan({type:'common.follow',id:'big',pubkeys:[npub]},registration,signal(),active),/follow-list-too-large/);assert.equal(h.counts().publishCount,0);
});
test('parser preserves social fields and rejects empty/oversize lists and supplied event templates',()=>{
  assert.deepEqual(parseCommonRequest({type:'common.follow',id:'f',pubkeys:[npub]}),{type:'common.follow',id:'f',pubkeys:[npub]});
  for(const value of [[],Array(17).fill(npub),'npub'])assert.throws(()=>parseCommonRequest({type:'common.follow',id:'f',pubkeys:value}));
  assert.throws(()=>parseCommonRequest({type:'common.react',id:'r',targetEventId:'a'.repeat(64),reaction:'+',event:{kind:1}}));
});

test('same-second follow waits for a strictly later observed local second; future basis is refused',async()=>{
  const basis=sign(3,[['p','6'.repeat(64)]],'preserve',2);let clockCalls=0;
  const port={async signer(){return true;},async query(){return {events:[{event:basis}],incomplete:false};},async publication(event:unknown,id:string){const snapshot=captureEventSnapshot(event,user,[relay]);return {requestId:id,event:snapshot,destinations:[{relay,sources:[{kind:'network-fallback' as const}]}],requiredInboxes:[],ownSource:'network-fallback' as const,ancillary:null};}};
  const planner=createCommonSocialPlanner(port,()=>clockCalls++===0?2999:3000);
  const plan=await planner.plan({type:'common.follow',id:'same-second',pubkeys:[npub]},registration,signal(),active);
  assert.equal(plan.publication?.event.event.created_at,3);assert.ok(plan.publication!.event.event.created_at>basis.created_at);planner.release(plan);
  const future=createCommonSocialPlanner(port,()=>1000);
  await assert.rejects(future.plan({type:'common.follow',id:'future',pubkeys:[npub]},registration,signal(),active),/follow-list-in-future/);
});

test('invalid signature and invalid intent never prepare publication; emoji sequences stay one reaction',async()=>{
  const h=harness();const bad=sign(3,[['p',other]]);bad.sig='0'.repeat(128);h.setBasis(bad);
  await assert.rejects(h.planner.plan({type:'common.follow',id:'bad-sig',pubkeys:[npub]},registration,signal(),active));assert.equal(h.counts().publishCount,0);
  const valid=harness();for(const value of ['+','-','👍🏽','👩‍💻','🇦🇺','1️⃣']){
    const plan=await valid.planner.plan({type:'common.react',id:'emoji',targetEventId:valid.target.id,reaction:value},registration,signal(),active);assert.equal(plan.publication?.event.event.content,value);valid.planner.release(plan);
  }
  const before=valid.counts().queryCount;for(const reaction of ['😀😀','plain text',':missing:', '\u200d😀'])await assert.rejects(valid.planner.plan({type:'common.react',id:'invalid',targetEventId:valid.target.id,reaction},registration,signal(),active),/invalid-reaction/);
  assert.equal(valid.counts().queryCount,before);
});

test('aborted ignored read relinquishes user ownership; late completion cannot prepare or dispatch',async()=>{
  let finish!:()=>void,reads=0,prepared=0;
  const planner=createCommonSocialPlanner({async signer(){return true;},async query(){reads++;if(reads===1)await new Promise<void>(resolve=>{finish=resolve;});return {events:[],incomplete:false};},async publication(event,id){prepared++;const snapshot=captureEventSnapshot(event,user,[relay]);return {requestId:id,event:snapshot,destinations:[{relay,sources:[{kind:'network-fallback'}]}],requiredInboxes:[],ownSource:'network-fallback',ancillary:null};}},()=>2000);
  const controller=new AbortController(),pending=planner.plan({type:'common.follow',id:'cancel',pubkeys:[npub]},registration,controller.signal,active);
  while(!finish)await new Promise(resolve=>setTimeout(resolve,0));controller.abort();await assert.rejects(pending);
  const next=await planner.plan({type:'common.follow',id:'fresh',pubkeys:[npub]},registration,signal(),active);assert.equal(prepared,1);planner.release(next);
  finish();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(prepared,1);
});

test('no connected selected signer rejects even an idempotent modifying operation before any read or effect',async()=>{
  let reads=0;const planner=createCommonSocialPlanner({async signer(){return false;},async query(){reads++;throw Error('must not read');},async publication(){throw Error('must not prepare');}});
  await assert.rejects(planner.plan({type:'common.unfollow',id:'no-signer',pubkeys:[npub]},registration,signal(),active),/not-signed-in/);assert.equal(reads,0);
});
