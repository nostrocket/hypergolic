import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finalizeEvent, getPublicKey, type NostrEvent } from 'nostr-tools/pure';
import { createOutboxAuthorResolver } from '../../src/outbox/author-resolver.ts';
import { openOutboxRelayListCache } from '../../src/outbox/relay-list-cache.ts';
import { OUTBOX_LIST_LIMITS } from '../../src/outbox/relay-list.ts';
import { RelayQueryDataError, RelayQueryError } from '../../src/network/relay-query-contract.ts';
import type { DetailedRelayQueryService } from '../../src/network/native-relay-query.ts';
import { DiskSQLite, hex } from '../storage/harness.ts';
const key = new Uint8Array(32).fill(35), author = getPublicKey(key), user = hex(41);
const signed = JSON.parse(JSON.stringify(finalizeEvent({kind: 10002, created_at: 1, content: '', tags: [['r','wss://nos.lol']]}, key))) as NostrEvent;
const signal = () => new AbortController().signal;
async function setup(t: {after(fn: () => void): void}, query: DetailedRelayQueryService['queryDetailed'], clock: () => number) {
  const sqlite = new DiskSQLite(); t.after(() => sqlite.cleanup());
  const cache = await openOutboxRelayListCache(sqlite, 'android');
  const resolver = createOutboxAuthorResolver(cache, {queryDetailed: query, async query(filters, signal, active) {return (await query(filters, signal, active)).events;}}, clock);
  return {cache, resolver};
}
test('successful author discovery caches by identity and avoids further fresh lookups', async t => {
  let calls = 0;
  const {resolver} = await setup(t, async filters => {calls++; assert.deepEqual(filters[0]!.authors, [author]); return {events: [{event: signed}], incomplete: false};}, () => 1000);
  assert.equal((await resolver.resolve(user, author, 'read', signal(), () => {})).source, 'nip65');
  assert.equal((await resolver.resolve(user, author, 'read', signal(), () => {})).source, 'cache');
  assert.equal(calls, 1);
  await resolver.resolve(hex(42), author, 'read', signal(), () => {});
  assert.equal(calls, 2);
});
test('stale outage can serve bounded reads but publication cannot use an expired list', async t => {
  const {cache, resolver} = await setup(t, async () => {throw new RelayQueryError();}, () => OUTBOX_LIST_LIMITS.freshMs + 1);
  await cache.write(user, author, {event: signed, fetchedAt: 0}, () => {}, signal());
  const read = await resolver.resolve(user, author, 'read', signal(), () => {});
  assert.equal(read.list?.event.id, signed.id); assert.equal(read.incomplete, true);
  await assert.rejects(resolver.resolve(user, author, 'publication', signal(), () => {}));
});
test('seven-day expired list cannot satisfy an offline read', async t => {
  const {cache, resolver} = await setup(t, async () => {throw new RelayQueryError();}, () => OUTBOX_LIST_LIMITS.staleReadMs);
  await cache.write(user, author, {event: signed, fetchedAt: 0}, () => {}, signal());
  await assert.rejects(resolver.resolve(user, author, 'read', signal(), () => {}));
});
test('incomplete discovery is disclosed and never marks old metadata fresh or authorizes publication', async t => {
  const {cache, resolver} = await setup(t, async () => ({events: [{event: signed}], incomplete: true}), () => 1000);
  assert.equal((await resolver.resolve(user, author, 'read', signal(), () => {})).incomplete, true);
  assert.equal(await cache.read(user, author, () => {}, signal()), null);
  await assert.rejects(resolver.resolve(user, author, 'publication', signal(), () => {}));
});
test('empty lookup does not refresh a previous signed list or permit stale publication', async t => {
  const {cache, resolver} = await setup(t, async () => ({events: [], incomplete: false}), () => OUTBOX_LIST_LIMITS.freshMs);
  await cache.write(user, author, {event: signed, fetchedAt: 0}, () => {}, signal());
  const result = await resolver.resolve(user, author, 'publication', signal(), () => {});
  assert.equal(result.list, null); assert.equal(result.incomplete, true);
  assert.equal((await cache.read(user, author, () => {}, signal()))?.fetchedAt, 0);
});
test('forged discovery cannot silently fall back to good cached metadata', async t => {
  const {cache, resolver} = await setup(t, async () => {throw new RelayQueryDataError();}, () => OUTBOX_LIST_LIMITS.freshMs);
  await cache.write(user, author, {event: signed, fetchedAt: 0}, () => {}, signal());
  await assert.rejects(resolver.resolve(user, author, 'read', signal(), () => {}));
});
test('revocation after discovery prevents cache write and caller result', async t => {
  let live = true;
  const {cache, resolver} = await setup(t, async () => {live = false; return {events: [{event: signed}], incomplete: false};}, () => 1000);
  await assert.rejects(resolver.resolve(user, author, 'read', signal(), () => {if (!live) throw Error('revoked');}));
  assert.equal(await cache.read(user, author, () => {}, signal()), null);
});

test('native return can force fresh signed discovery inside the cache interval without permitting an outage to extend freshness',async t=> {
  let calls=0,offline=false;
  const {resolver,cache}=await setup(t,async()=>{calls++;if(offline)throw new RelayQueryError();return {events:[{event:signed}],incomplete:false};},()=>1000);
  await resolver.resolve(user,author,'read',signal(),()=>{});await resolver.resolve(user,author,'read',signal(),()=>{});assert.equal(calls,1);
  assert.equal((await resolver.resolve(user,author,'read',signal(),()=>{},true)).source,'nip65');assert.equal(calls,2);
  offline=true;const result=await resolver.resolve(user,author,'read',signal(),()=>{},true);assert.equal(result.incomplete,true);assert.equal(result.list?.event.id,signed.id);
  assert.equal((await cache.read(user,author,()=>{},signal()))?.fetchedAt,1000);
});

test('wide author discovery uses independent filters and caches only exact verified latest lists', async t => {
  const keys = Array.from({length:22},(_,index) => new Uint8Array(32).fill(index+1));
  const authors = keys.map(getPublicKey);
  const create = (key: Uint8Array, createdAt: number, hostname: string): NostrEvent =>
    JSON.parse(JSON.stringify(finalizeEvent({kind:10002,created_at:createdAt,content:'',tags:[['r',`wss://${hostname}.nostr.net`,'write']]},key)));
  const first = create(keys[0]!,12,'first'), tied = create(keys[0]!,12,'tie');
  const winner = first.id < tied.id ? first : tied;
  const second = create(keys[1]!,5,'second'), unrelated = create(key,20,'unrelated');
  let mode: 'forged' | 'unrelated' | 'partial' | 'complete' = 'forged', calls = 0;
  const {cache,resolver} = await setup(t,async (filters,_signal,_active,options) => {
    calls++;
    assert.deepEqual(filters,authors.map(pubkey=>({authors:[pubkey],kinds:[10002],limit:1})));
    assert.deepEqual(options,{maximumFilters:32,timeoutMs:5900,allowPartialOnLimit:true});
    const entries = [first,tied,create(keys[0]!,11,'old'),second];
    if (mode === 'forged') entries.push({...second,content:'forged'});
    if (mode === 'unrelated') entries.push(unrelated);
    return {events:entries.map(event=>({event})),incomplete:mode==='partial'};
  },()=>1000);
  for (const invalid of ['forged','unrelated'] as const) {
    mode = invalid;
    await assert.rejects(resolver.resolveReadBatch!(user,authors,signal(),()=>{},6000));
    assert.equal(await cache.read(user,authors[0]!,()=>{},signal()),null);
  }
  mode = 'partial';
  let result = await resolver.resolveReadBatch!(user,authors,signal(),()=>{},6000);
  assert.equal(result.get(authors[0]!)?.list?.event.id,winner.id);
  assert.equal(result.get(authors[0]!)?.incomplete,true);
  assert.equal(await cache.read(user,authors[0]!,()=>{},signal()),null);
  mode = 'complete';
  result = await resolver.resolveReadBatch!(user,authors,signal(),()=>{},6000);
  assert.equal(result.get(authors[0]!)?.list?.event.id,winner.id);
  assert.equal(result.get(authors[1]!)?.list?.event.id,second.id);
  assert.equal(result.get(authors[2]!)?.list,null);
  assert.equal(result.get(authors[2]!)?.incomplete,true);
  assert.equal((await cache.read(user,authors[0]!,()=>{},signal()))?.event?.id,winner.id);
  assert.equal(await cache.read(user,authors[2]!,()=>{},signal()),null);
  assert.equal((await resolver.resolveReadBatch!(user,authors.slice(0,2),signal(),()=>{},6000)).get(authors[0]!)?.source,'cache');
  assert.equal(calls,4);
});
