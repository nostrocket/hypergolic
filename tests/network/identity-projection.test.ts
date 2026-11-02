import assert from 'node:assert/strict';
import test from 'node:test';
import {finalizeEvent, getPublicKey, type NostrEvent} from 'nostr-tools/pure';
import {identityProjection, IDENTITY_COLLECTION_LIMIT} from '../../src/identity/identity-projection.ts';
import {acceptedBadges, BADGE_BUNDLE_FILTERS, fetchAcceptedBadges, BADGE_LIMITS} from '../../src/identity/identity-badges.ts';
import {verifiedIdentityEvents, type IdentityRequest} from '../../src/identity/identity-contract.ts';
import {queryMatches, type QueryFilter} from '../../src/network/relay-query-contract.ts';
const secret = new Uint8Array(32); secret[31] = 1;
const issuerSecret = new Uint8Array(32); issuerSecret[31] = 2;
const user = getPublicKey(secret), issuer = getPublicKey(issuerSecret);
function signed(kind: number, tags: string[][], key = secret, created_at = 10, content = 'encrypted content stays private'): NostrEvent {
  return JSON.parse(JSON.stringify(finalizeEvent({kind, tags, content, created_at}, key))) as NostrEvent;
}
function project(type: IdentityRequest['type'], kind: number, tags: string[][], listType?: string) {
  const spec = identityProjection({type, id: 'read', ...(listType === undefined ? {} : {listType})}, user);
  return spec.project(verifiedIdentityEvents([signed(kind, tags)], spec.filters));
}
test('public relay directions preserve URLs as data, combine duplicate directions and never substitute bootstrap settings', () => {
  assert.deepEqual(project('identity.getRelays', 10002, [['r', 'wss://127.0.0.1'], ['r', 'wss://relay.example/read', 'read'], ['r', 'wss://relay.example/read', 'write'], ['r', 'ws://public.example', 'write']]), {
    'wss://127.0.0.1': {read: true, write: true}, 'wss://relay.example/read': {read: true, write: true}, 'ws://public.example': {read: false, write: true}});
  assert.deepEqual(identityProjection({type:'identity.getRelays',id:'empty'},user).project([]), {});
  assert.throws(() => project('identity.getRelays',10002,[['r','javascript:alert(1)']]));
  assert.throws(() => project('identity.getRelays',10002,[['r','wss://relay.example','unknown']]));
});
test('follows and public mutes expose only exact hex p values, in order, with no hints or encrypted content', () => {
  const tags = [['p', issuer, 'wss://unconfigured.example', 'nickname'], ['p', user], ['p', issuer], ['e', 'a'.repeat(64)], ['word', 'never returned'], ['constructor', 'never returned'], ['__proto__', 'never returned']];
  assert.deepEqual(project('identity.getFollows',3,tags), [issuer,user]); assert.deepEqual(project('identity.getMutes',10000,tags), [issuer,user]);
  assert.throws(() => project('identity.getFollows',3,[['p','invalid']]));
});
test('exact selected global list mappings keep public references literal and do not expand named collections', () => {
  const address = '30023:' + issuer + ':雪';
  assert.deepEqual(project('identity.getList',10003,[['e','a'.repeat(64)],['a',address],['r','https://ignored.example']],'bookmarks'), ['a'.repeat(64),address]);
  assert.deepEqual(project('identity.getList',10001,[['e','b'.repeat(64)],['a',address]],'pins'), ['b'.repeat(64)]);
  assert.deepEqual(project('identity.getList',10015,[['t','<literal>'],['a',address],['p',issuer]],'interests'), ['<literal>',address]);
  assert.throws(() => identityProjection({type:'identity.getList',id:'x',listType:'named:bookmarks'},user), /unsupported/);
  assert.throws(() => project('identity.getList',10003,[['a','1:'+issuer+':bad']],'bookmarks'));
});
test('list resource limits reject excess rather than silently truncate, and unsupported blocks/zaps stay explicit', () => {
  assert.throws(() => project('identity.getFollows',3,Array.from({length:IDENTITY_COLLECTION_LIMIT+1},()=>['p',issuer])), /limits|invalid identity data/);
  assert.throws(() => identityProjection({type:'identity.getBlocked',id:'b'},user), /unsupported/);
  assert.throws(() => identityProjection({type:'identity.getZaps',id:'z'},user), /deferred/);
});
function badge(name = 'bravery') {
  const address = '30009:'+issuer+':'+name;
  const definition = signed(30009,[['d',name],['name','<literal> '+name],['description','Public badge'],['image','https://images.example/'+name],['thumb','https://images.example/thumb']],issuerSecret);
  const award = signed(8,[['a',address],['p',user]],issuerSecret);
  return {address,definition,award};
}
function expected(value: ReturnType<typeof badge>) {return {id:value.definition.id,awardedBy:issuer,name:'<literal> '+value.definition.tags[0]![1],description:'Public badge',image:'https://images.example/'+value.definition.tags[0]![1],thumbs:['https://images.example/thumb']};}
function verified(events: NostrEvent[]) {return verifiedIdentityEvents(events,BADGE_BUNDLE_FILTERS);}
test('accepted badge output verifies definition/issuer/award/recipient and preserves selected public display order', () => {
  const a=badge('A'),b=badge('B'),unsolicited=badge('Unsolicited');
  const root=signed(10008,[['a',b.address],['e',b.award.id],['a',a.address],['e',a.award.id]]);
  assert.deepEqual(acceptedBadges(verified([root,a.definition,a.award,b.definition,b.award,unsolicited.definition,unsolicited.award]),user),[expected(b),expected(a)]);
  assert.deepEqual(acceptedBadges(verified([unsolicited.definition,unsolicited.award]),user),[]);
});
test('accepted public badge-set references expand once in place, with exact set author/d identifier binding', () => {
  const a=badge(), reference='30008:'+user+':favorites';
  const set=signed(30008,[['d','favorites'],['a',a.address],['e',a.award.id]]);
  const root=signed(10008,[['a',reference]]);
  assert.deepEqual(acceptedBadges(verified([root,set,a.definition,a.award]),user),[expected(a)]);
  const nested=signed(30008,[['d','favorites'],['a',reference]]);
  assert.throws(()=>acceptedBadges(verified([root,nested,a.definition,a.award]),user),/nested/);
});
for (const scenario of ['wrong-issuer','wrong-recipient','wrong-award-definition','missing-award','missing-definition','bad-signature','partial-pair','bad-metadata','duplicate-d'] as const) test(`accepted badge rejects ${scenario}`,()=> {
  const value=badge();let definition=value.definition,award=value.award;
  let root=signed(10008,[['a',value.address],['e',award.id]]);
  if(scenario==='wrong-issuer')award=signed(8,[['a',value.address],['p',user]],secret);
  if(scenario==='wrong-recipient')award=signed(8,[['a',value.address],['p',issuer]],issuerSecret);
  if(scenario==='wrong-award-definition')award=signed(8,[['a','30009:'+issuer+':another'],['p',user]],issuerSecret);
  if(scenario.startsWith('wrong-'))root=signed(10008,[['a',value.address],['e',award.id]]);
  if(scenario==='partial-pair')root=signed(10008,[['a',value.address]]);
  if(scenario==='bad-signature')award={...award,sig:'0'.repeat(128)};
  if(scenario==='bad-metadata')definition=signed(30009,[['d','bravery'],['name','x'.repeat(257)]],issuerSecret);
  if(scenario==='duplicate-d')definition=signed(30009,[['d','bravery'],['d','another']],issuerSecret);
  const events=[root,...scenario==='missing-definition'?[]:[definition],...scenario==='missing-award'?[]:[award]];
  assert.throws(()=>acceptedBadges(verified(events),user));
});
test('legacy accepted profile, newest signed empty acceptance and badge bounds do not resurrect older awards',()=> {
  const value=badge(),legacy=signed(30008,[['d','profile_badges'],['a',value.address],['e',value.award.id]]);
  assert.deepEqual(acceptedBadges(verified([legacy,value.definition,value.award]),user),[expected(value)]);
  assert.deepEqual(acceptedBadges(verified([legacy,signed(10008,[],secret,20),value.definition,value.award]),user),[]);
  const tags=Array.from({length:BADGE_LIMITS.badges+1},()=>[['a',value.address],['e',value.award.id]]).flat();
  assert.throws(()=>acceptedBadges(verified([signed(10008,tags),value.definition,value.award]),user),/limits/);
});
test('fixed bounded badge joins ask only for acceptance-selected signed references and retain original cryptographic definition IDs',async()=> {
  const value=badge(),root=signed(10008,[['a',value.address],['e',value.award.id]]),source=[root,value.award,value.definition];
  const calls: (readonly QueryFilter[])[]=[];
  const query={async query(filters:readonly QueryFilter[]) {calls.push(filters);return source.filter(event=>filters.some(filter=>queryMatches(event,filter))).map(event=>({event}));}};
  const bundle=await fetchAcceptedBadges(user,null,query,new AbortController().signal,()=>{});
  assert.equal(bundle.observedRoot,true);assert.deepEqual(acceptedBadges(bundle.events,user),[expected(value)]);assert.equal(calls.length,3);
  assert.deepEqual(calls[1]![0]!['#p'],[user]);assert.deepEqual(calls[1]![0]!.ids,[value.award.id]);assert.deepEqual(calls[2]![0]!.authors,[issuer]);
});
