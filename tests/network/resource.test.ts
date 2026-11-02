import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { finalizeEvent } from 'nostr-tools/pure';
import { noteEncode, neventEncode } from 'nostr-tools/nip19';
import { createResourceService, type ResourceResolvers } from '../../src/resources/resource-service.ts';
import { parseResourceRequest, parseResourceURL, publicResourceHttps, ResourceError,
  RESOURCE_LIMITS, resourceFailure } from '../../src/resources/resource-contract.ts';
import { classifyResourceBytes } from '../../src/resources/resource-mime.ts';
import type { NativeRegistration } from '../../src/runtime/capability-protocol.ts';

const encoder = new TextEncoder();
const text = (value = 'hello') => encoder.encode(value);
const scope = (generation = 'generation'): NativeRegistration => ({ sessionId: 'session', generation,
  epoch: 1, user: 'a'.repeat(64), publisher: 'b'.repeat(64), appId: 'app', version: 'c'.repeat(64),
  instanceId: 'instance', fixture: 'published', domains: ['theme'] });
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const error = (code: string) => (value: unknown) => value instanceof ResourceError && value.code === code;
const png = () => { const value = new Uint8Array(24); value.set([137,80,78,71,13,10,26,10]); value.set(text('IHDR'),12);
  const view = new DataView(value.buffer); view.setUint32(16,1); view.setUint32(20,1); return value; };
function setup(overrides: Partial<ResourceResolvers> = {}) {
  let calls = 0;
  const service = createResourceService({ https: async () => { calls++; return text(); },
    servers: () => ['https://cdn.example.com'], sha256: async bytes => hash(bytes), ...overrides });
  return { service, calls: () => calls, bind: (generation = 'generation', active = () => {}) => {
    const bound = service.bind(scope(generation), active);
    return { revoke: bound.revoke, execute: (request: Parameters<typeof bound.execute>[0]) => bound.execute(request, {nativeToken:'controlled-lease',assertActive:active}) };
  } };
}
const bytes = (id: string, url = 'https://assets.example.com/a') => parseResourceRequest({type:'resource.bytes',id,url});

test('strict current wire rejects extra authority, getters, sparse and altered arrays', () => {
  assert.deepEqual(parseResourceRequest({type:'resource.info',id:'info'}),{type:'resource.info',id:'info'});
  for (const value of [
    {type:'resource.bytes',id:'a',url:'https://a.example.com',scope:'other'},
    {type:'resource.bytes',id:'a',url:'https://a.example.com',init:{headers:{Authorization:'x'}}},
    {type:'resource.bytes',id:'a',get url(){throw Error('getter executed');}},
    {type:'resource.bytesMany',id:'a',urls:new Array(1)},
    {type:'resource.bytesMany',id:'a',urls:[]},
    {type:'resource.chunk',id:'a',handle:'foreign'},
    {type:'resource.bytes',requestId:'legacy',url:'https://a.example.com'},
  ]) assert.throws(() => parseResourceRequest(value), error('invalid-request'));
  const urls = ['https://a.example.com']; Object.setPrototypeOf(urls,{map(){throw Error('custom map');}});
  assert.throws(() => parseResourceRequest({type:'resource.bytesMany',id:'a',urls}),error('invalid-request'));
  assert.throws(() => parseResourceRequest({type:'resource.bytesMany',id:'a',urls:Array(9).fill('a')}),error('too-large'));
  assert.equal(resourceFailure({type:'resource.cancel',id:'a'},'timeout'),null);
});
test('public URL preflight rejects private spellings, credentials, fragments and unknown schemes', () => {
  for (const url of ['https://127.0.0.1/a','https://2130706433/a','https://[::1]/a','https://localhost/a',
    'https://a.local/a','https://a.home.arpa/a','https://user:pass@a.example.com/a','https://@a.example.com/a',
    'https://a.example.com/a#secret','https://a.example.com/\\evil','https://a.example.com/\n']) assert.throws(() => publicResourceHttps(url));
  assert.equal(publicResourceHttps('https://assets.example.com/a?b=1'),'https://assets.example.com/a?b=1');
  assert.throws(() => parseResourceURL('http://assets.example.com/a'),error('unsupported-scheme'));
  assert.throws(() => parseResourceURL('htree://root'),error('unsupported-scheme'));
  assert.throws(() => parseResourceURL('blossom:sha256:'+'a'.repeat(64)+'?xs=foreign'),error('invalid-request'));
});
test('classification ignores headers and rejects active, malformed and oversized bytes', () => {
  assert.equal(classifyResourceBytes(png()),'image/png');
  assert.equal(classifyResourceBytes(text('{"a":1}')),'application/json');
  assert.equal(classifyResourceBytes(text('ordinary attachment')),'text/plain');
  assert.equal(classifyResourceBytes(new Uint8Array()),'text/plain');
  for(const value of [text('  <svg xmlns="http://www.w3.org/2000/svg"/>'),text('\ufeff<?xml version="1.0"?><svg/>'),
    text('<!doctype html><script>bad()</script>'),new Uint8Array([0,255]),text('{broken')]) assert.throws(() => classifyResourceBytes(value),error('decode-failed'));
  const giant=png();new DataView(giant.buffer).setUint32(16,99999);assert.throws(() => classifyResourceBytes(giant),error('decode-failed'));
  assert.throws(() => classifyResourceBytes(new Uint8Array(RESOURCE_LIMITS.fileBytes+1)),error('too-large'));
});
test('cache is isolated, exact-keyed and protected from returned-byte mutation', async () => {
  const h=setup(), a=h.bind(), b=h.bind('other');
  const first=await a.execute(bytes('a')) as {value:{bytes:Uint8Array}};first.value.bytes[0]=0;
  const second=await a.execute(bytes('b')) as {value:{bytes:Uint8Array}};
  assert.equal(new TextDecoder().decode(second.value.bytes),'hello');assert.equal(h.calls(),1);
  await b.execute(bytes('c'));assert.equal(h.calls(),2);
  await a.execute(bytes('d','https://assets.example.com/a?x=1'));assert.equal(h.calls(),3);
  a.revoke();await assert.rejects(a.execute(bytes('e')),error('timeout'));h.service.revokeAll();
});
test('bulk keeps order and siblings while local data is classified by bytes', async () => {
  const h=setup(), session=h.bind();
  const result=await session.execute(parseResourceRequest({type:'resource.bytesMany',id:'bulk',urls:[
    'data:application/false,%7B%22a%22%3A1%7D','htree://root','https://assets.example.com/a','data:text/plain,%3Csvg%2F%3E']})) as {items:{url:string;ok:boolean;error?:string;value?:{mime:string}}[]};
  assert.deepEqual(result.items.map(x=>x.ok),[true,false,true,false]);
  assert.equal(result.items[0]!.value!.mime,'application/json');assert.equal(result.items[1]!.error,'unsupported-scheme');
  assert.equal(result.items[3]!.error,'decode-failed');h.service.revokeAll();
});
test('Blossom verifies bytes on fallback and does not let hints choose servers', async () => {
  const body=text('verified'), digest=hash(body);let attempts=0;
  const h=setup({servers:()=>['https://one.example.com','https://two.example.com'],https:async url=>{
    assert.ok(url.endsWith('/'+digest));return ++attempts===1?text('wrong'):body;}});
  const s=h.bind();await s.execute(bytes('hash','blossom:sha256:'+digest));assert.equal(attempts,2);
  const bad=setup({https:async()=>text('wrong')}), b=bad.bind();
  await assert.rejects(b.execute(bytes('bad','blossom:sha256:'+digest)),error('decode-failed'));
  h.service.revokeAll();bad.service.revokeAll();
});
test('Nostr resolves one validated event without following content or relay hints', async () => {
  const secret=new Uint8Array(32);secret[31]=1;
  const event=finalizeEvent({kind:1,created_at:1,tags:[],content:'https://private.local/never-fetch'},secret);
  const h=setup({query:{query:async(filters,_signal,active)=>{active();assert.deepEqual(filters[0]!.ids,[event.id]);return[{event:JSON.parse(JSON.stringify(event))}];}}});
  const s=h.bind();const result=await s.execute(bytes('note','nostr:'+noteEncode(event.id))) as {value:{bytes:Uint8Array;mime:string}};
  assert.equal(result.value.mime,'application/json');assert.equal(JSON.parse(new TextDecoder().decode(result.value.bytes)).id,event.id);
  await s.execute(bytes('hint','nostr:'+neventEncode({id:event.id,relays:['wss://foreign.local']})));assert.equal(h.calls(),0);
  h.service.revokeAll();
});
test('cancel and revoke drop stale delivery even if a resolver ignores abort', async () => {
  let release!:(value:Uint8Array<ArrayBuffer>)=>void;
  const h=setup({https:()=>new Promise(resolve=>{release=resolve;})}), s=h.bind();
  const work=s.execute(bytes('waiting'));await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(await s.execute(parseResourceRequest({type:'resource.cancel',id:'waiting'})),null);
  await assert.rejects(work,error('timeout'));release(text('late'));await new Promise(resolve=>setTimeout(resolve,0));
  await assert.rejects(s.execute(bytes('waiting')),error('invalid-request'));h.service.revokeAll();
});
test('process and session concurrent caps include uncooperative cancelled fetches', async () => {
  const releases:((value:Uint8Array<ArrayBuffer>)=>void)[]=[];
  const h=setup({https:()=>new Promise(resolve=>releases.push(resolve))}), a=h.bind('a'), b=h.bind('b'), c=h.bind('c');
  const work=[a.execute(bytes('a1')),a.execute(bytes('a2')),b.execute(bytes('b1')),b.execute(bytes('b2'))];
  await assert.rejects(a.execute(bytes('a3')),error('quota-exceeded'));await assert.rejects(c.execute(bytes('c1')),error('quota-exceeded'));
  a.revoke();b.revoke();await Promise.all(work.map(p=>assert.rejects(p,error('timeout'))));
  await assert.rejects(c.execute(bytes('c2')),error('quota-exceeded'));
  for(const release of releases)release(text());await new Promise(resolve=>setTimeout(resolve,0));h.service.revokeAll();
});
test('rate budget includes cache hits and rollback cannot reset it', async () => {
  let clock=100;const h=setup({now:()=>clock}), s=h.bind();
  for(let i=0;i<60;i++)await s.execute(bytes('id'+i));
  await assert.rejects(s.execute(bytes('over')),error('quota-exceeded'));clock=0;
  await assert.rejects(s.execute(bytes('rollback')),error('quota-exceeded'));clock=60100;
  await s.execute(bytes('fresh'));assert.equal(h.calls(),1);h.service.revokeAll();
});

// Header fixtures exercise dimensional admission, not codec decoding.
test('JPEG frame headers bound dimensions after metadata and reject truncated or unknown frames', () => {
  const jpeg = (width:number,height:number) => {
    const value = new Uint8Array([255,216,255,225,0,4,1,2,255,194,0,11,8,0,0,0,0,1,1,17,0]);
    const view = new DataView(value.buffer);view.setUint16(13,height);view.setUint16(15,width);return value;
  };
  assert.equal(classifyResourceBytes(jpeg(4096,4096)),'image/jpeg');
  for (const value of [jpeg(4097,1),jpeg(1,0),jpeg(1,1).slice(0,20),new Uint8Array([255,216,255,218,0,2])])
    assert.throws(()=>classifyResourceBytes(value),error('decode-failed'));
});
test('WebP lossy, lossless and extended canvas headers bound dimensions and validate truncation', () => {
  const webp = (tag:string,length:number) => {
    const value=new Uint8Array(20+length+(length & 1)),view=new DataView(value.buffer);
    value.set(text('RIFF'));view.setUint32(4,value.length-8,true);value.set(text('WEBP'),8);value.set(text(tag),12);view.setUint32(16,length,true);return value;
  };
  const lossy=webp('VP8 ',10);lossy.set([157,1,42],23);new DataView(lossy.buffer).setUint16(26,4096,true);new DataView(lossy.buffer).setUint16(28,2,true);
  const lossless=webp('VP8L',5);lossless[20]=47;new DataView(lossless.buffer).setUint32(21,4095 | (4095 << 14),true);
  const extended=webp('VP8X',10);extended.set([255,15,0],24);extended.set([255,15,0],27);
  for (const value of [lossy,lossless,extended]) assert.equal(classifyResourceBytes(value),'image/webp');
  new DataView(lossy.buffer).setUint16(26,4097,true);new DataView(lossless.buffer).setUint32(21,4096,true);extended.set([0,16,0],24);
  for (const value of [lossy,lossless,extended,webp('VP8X',8),webp('JUNK',10)])
    assert.throws(()=>classifyResourceBytes(value),error('decode-failed'));
});

test('resource info follows trusted Blossom disable/restore and absent Nostr resolver without preflight gating', async () => {
  let enabled=false;const h=setup({servers:()=>enabled?['https://cdn.example.com']:[]}),session=h.bind();
  const info=async(id:string)=>(await session.execute(parseResourceRequest({type:'resource.info',id}))) as {info:{schemes:{scheme:string;enabled:boolean}[]}};
  const first=await info('disabled');assert.equal(first.info.schemes.find(value=>value.scheme==='blossom')!.enabled,false);
  assert.equal(first.info.schemes.find(value=>value.scheme==='nostr')!.enabled,false);
  enabled=true;assert.equal((await info('restored')).info.schemes.find(value=>value.scheme==='blossom')!.enabled,true);
  await session.execute(bytes('direct'));assert.equal(h.calls(),1);h.service.revokeAll();
});
