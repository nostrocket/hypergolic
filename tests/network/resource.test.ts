import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { finalizeEvent } from 'nostr-tools/pure';
import { noteEncode, neventEncode } from 'nostr-tools/nip19';
import { createResourceService, type ResourceResolvers } from '../../src/resources/resource-service.ts';
import { parseResourceRequest, parseResourceURL, publicResourceHttps, ResourceError,
  RESOURCE_LIMITS, resourceFailure } from '../../src/resources/resource-contract.ts';
import { classifyResourceBytes } from '../../src/resources/resource-mime.ts';
import { DEFAULT_RESOURCE_SERVERS } from '../../src/resources/resource-settings.ts';
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
test('modern Resource inputs share legacy bounds and reject injected authority', () => {
  const url = 'blossom:' + 'a'.repeat(64) + '.png';
  const targets = [{url, servers: ['https://assets.example.com:443/']}, {url: 'data:,hello'}];
  const modern = {type: 'resource.bytesMany', id: 'modern', requests: targets};
  assert.deepEqual(parseResourceRequest(modern), {...modern, requests: [{url, servers: ['https://assets.example.com']}, targets[1]]});
  for (const requests of [
    [null],
    [url],
    [{url, scope: 'other'}],
    [{url, servers: new Array(1)}],
    [{url, get servers() { throw Error('getter executed'); }}],
  ]) assert.throws(() => parseResourceRequest({...modern, requests}), error('invalid-request'));
  assert.throws(() => parseResourceRequest({...modern, urls: [url]}), error('invalid-request'));
  assert.throws(() => parseResourceRequest({...modern, requests: Array(9).fill({url})}), error('too-large'));
  assert.throws(() => parseResourceRequest({type: 'resource.bytes', id: 'many', url, servers: Array(17).fill('https://one.example.com')}), error('too-large'));
  assert.throws(() => parseResourceRequest({type: 'resource.bytes', id: 'huge', url, servers: ['x'.repeat(513)]}), error('too-large'));
  assert.throws(() => parseResourceRequest({type: 'resource.bytes', id: 'unsafe', url, servers: ['https://127.0.0.1/']}), error('blocked-by-policy'));
  assert.deepEqual(parseResourceURL(url), {scheme: 'blossom', hash: 'a'.repeat(64)});
  assert.deepEqual(parseResourceURL(url + '?xs=private.local'), {scheme: 'blossom', hash: 'a'.repeat(64)});
});

test('SeedHammer converter hint shape preserves its exact hash and bounds advisory input', () => {
  const digest = 'ef0611095f75c56e60cf7772bdc90a30e388406cf17f318b13933e77e105a877';
  const raw = `blossom:${digest}`;
  const uri = raw + '?xs=bls.unrug.tech&xs=blossom.primal.net&xs=cdn.hzrd149.com&xs=blossom.ditto.pub';
  const servers = ['https://bls.unrug.tech', 'https://blossom.primal.net', 'https://cdn.hzrd149.com', 'https://blossom.ditto.pub',
    'https://blossom.data.haus', 'https://blossom-01.uid.ovh', 'https://blossom.nmail.li', 'https://blossom.nostr.black',
    'https://cdn.klepak.net', 'https://media.libernet.app'];
  const request = {type: 'resource.bytes', id: 'seed-converter', url: uri, servers};
  assert.deepEqual(parseResourceRequest(request), request);
  assert.deepEqual(parseResourceURL(uri), {scheme: 'blossom', hash: digest, servers: servers.slice(0, 4)});
  assert.deepEqual(parseResourceURL(raw), {scheme: 'blossom', hash: digest});
  assert.deepEqual(parseResourceURL(`blossom:sha256:${digest}?as=ignored&sz=2&xs=https%3A%2F%2Fblossom.primal.net%3A443%2F&xs=blossom.primal.net`),
    {scheme: 'blossom', hash: digest, servers: ['https://blossom.primal.net']});
  assert.throws(() => parseResourceURL(raw + '#xs=blossom.primal.net'), error('invalid-request'));
  assert.throws(() => parseResourceURL(raw + '?' + Array(17).fill('xs=blossom.primal.net').join('&')), error('too-large'));
  assert.throws(() => parseResourceURL(raw + '?as=' + 'a'.repeat(8192)), error('too-large'));
});

test('Blossom origins reject parser repairs and URI hints decode only once', () => {
  const digest = 'a'.repeat(64);
  const url = `blossom:${digest}`;
  const repairedOrigins = ['https://%62lossom.primal.net', 'https:////blossom.primal.net',
    'https:/blossom.primal.net', 'https://blossom.primal.net:', 'https://blossom.primal.net?',
    'https://blossom.primal.net#', 'https://blossom.primal.net/foo/..', 'https://blossom.primal.net/%2e',
    'https://user@blossom.primal.net', 'https://blossom.primal.net\t', 'https://blossom.primal.net:65536',
    'https://blossom.primal.net:0', 'https://127.0.0.0x1'];
  for (const server of repairedOrigins) {
    assert.throws(() => parseResourceRequest({type: 'resource.bytes', id: 'invalid', url, servers: [server]}), error('blocked-by-policy'));
    assert.deepEqual(parseResourceURL(`${url}?xs=${encodeURIComponent(server)}`), {scheme: 'blossom', hash: digest});
  }
  assert.deepEqual(parseResourceURL(`${url}?xs=%2562lossom.primal.net&xs=blossom.primal.net=invalid`), {scheme: 'blossom', hash: digest});
  assert.deepEqual(parseResourceURL(`${url}?as=%bad&xs=%bad&sz=%&%78s=BLOSSOM.Primal.Net%3A0443`),
    {scheme: 'blossom', hash: digest, servers: ['https://blossom.primal.net']});
  assert.deepEqual(parseResourceURL(`${url}?xs=%62lossom.primal.net&xs=blossom.primal.net%3A8443`), {
    scheme: 'blossom', hash: digest, servers: ['https://blossom.primal.net', 'https://blossom.primal.net:8443'],
  });
});

test('public URL preflight rejects private spellings, credentials, fragments and unknown schemes', () => {
  for (const url of ['https://127.0.0.1/a','https://2130706433/a','https://[::1]/a','https://localhost/a',
    'https://a.local/a','https://a.home.arpa/a','https://user:pass@a.example.com/a','https://@a.example.com/a',
    'https://a.example.com/a#secret','https://a.example.com/\\evil','https://a.example.com/\n']) assert.throws(() => publicResourceHttps(url));
  assert.equal(publicResourceHttps('https://assets.example.com/a?b=1'),'https://assets.example.com/a?b=1');
  assert.throws(() => parseResourceURL('http://assets.example.com/a'),error('unsupported-scheme'));
  assert.throws(() => parseResourceURL('htree://root'),error('unsupported-scheme'));
  assert.throws(() => parseResourceURL('blossom:sha256:' + 'A'.repeat(64)), error('invalid-request'));
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
test('Blossom aliases share verified bytes by hash within one realm and respect disabled settings', async () => {
  let enabled = true;
  const h = setup({servers: () => enabled ? ['https://cdn.example.com'] : []});
  const a = h.bind(), b = h.bind('other');
  const digest = hash(text());
  const canonical = `blossom:sha256:${digest}`;
  const bare = `blossom:${digest}`;
  const hinted = `${bare}.jpg?xs=cdn.example.com&sz=1`;
  try {
    const first = await a.execute(bytes('first', canonical)) as {value: {bytes: Uint8Array}};
    first.value.bytes[0] = 0;
    for (const url of [bare, hinted]) {
      const hit = await a.execute(bytes(url === bare ? 'bare' : 'hinted', url)) as {value: {bytes: Uint8Array; mime: string}};
      assert.deepEqual(hit.value, {bytes: text(), mime: 'text/plain'});
    }
    assert.equal(h.calls(), 1);
    enabled = false;
    await assert.rejects(a.execute(bytes('disabled', hinted)), error('blocked-by-policy'));
    assert.equal(h.calls(), 1);
    enabled = true;
    await b.execute(bytes('other', hinted));
    assert.equal(h.calls(), 2);
  } finally { h.service.revokeAll(); }
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

test('unhinted default mirrors reach the third verified response within one URL budget', async t => {
  t.mock.timers.enable({apis: ['setTimeout', 'setInterval']});
  let clock = 0;
  const body = text('verified default mirror'), digest = hash(body);
  const calls: {url: string; reject(error: ResourceError): void; resolve(bytes: Uint8Array<ArrayBuffer>): void}[] = [];
  const h = setup({servers: () => DEFAULT_RESOURCE_SERVERS, now: () => clock,
    https: (url, _signal, active) => { active(); return new Promise((resolve, reject) => calls.push({url, resolve, reject})); }});
  const work = h.bind().execute(bytes('default-fallback', 'blossom:' + digest));
  void work.catch(() => {});
  const turn = () => new Promise<void>(resolve => setImmediate(resolve));
  try {
    await turn(); assert.equal(calls.length, 1);
    clock = 1000; t.mock.timers.tick(1000); calls[0]!.reject(new ResourceError('not-found'));
    await turn(); assert.equal(calls.length, 2);
    clock = 2000; t.mock.timers.tick(1000); calls[1]!.reject(new ResourceError('not-found'));
    await turn(); assert.equal(calls.length, 3);
    clock = 2500; t.mock.timers.tick(500); calls[2]!.resolve(body);
    const result = await work as {value: {bytes: Uint8Array; mime: string}};
    assert.deepEqual(result.value, {bytes: body, mime: 'text/plain'});
    assert.deepEqual(calls.map(call => call.url), ['https://blossom.primal.net', 'https://cdn.satellite.earth', 'https://blssm.us'].map(origin => origin + '/' + digest));
  } finally { h.service.revokeAll(); for (const call of calls) call.resolve(body); await work.catch(() => {}); t.mock.timers.reset(); }
});

test('slow default mirrors cannot renew the URL deadline or start a late third attempt', async t => {
  t.mock.timers.enable({apis: ['setTimeout', 'setInterval']});
  let clock = 0;
  const body = text('late default mirror'), digest = hash(body);
  const calls: {url: string; reject(error: ResourceError): void; resolve(bytes: Uint8Array<ArrayBuffer>): void}[] = [];
  const h = setup({servers: () => DEFAULT_RESOURCE_SERVERS, now: () => clock,
    https: (url, _signal, active) => { active(); return new Promise((resolve, reject) => calls.push({url, resolve, reject})); }});
  const work = h.bind().execute(bytes('default-timeout', 'blossom:' + digest));
  void work.catch(() => {});
  const turn = () => new Promise<void>(resolve => setImmediate(resolve));
  try {
    await turn(); clock = 5000; t.mock.timers.tick(5000); calls[0]!.reject(new ResourceError('not-found'));
    await turn(); assert.equal(calls.length, 2);
    clock = RESOURCE_LIMITS.urlMs; t.mock.timers.tick(RESOURCE_LIMITS.urlMs - 5000);
    await assert.rejects(work, error('timeout'));
    calls[1]!.reject(new ResourceError('not-found')); await turn();
    assert.equal(calls.length, 2);
    assert.equal(RESOURCE_LIMITS.requestMs, 20_000);
    assert.equal(RESOURCE_LIMITS.urlMs, 15_000);
  } finally { h.service.revokeAll(); for (const call of calls) call.resolve(body); await work.catch(() => {}); t.mock.timers.reset(); }
});
test('advisory Blossom hints prefer an exact configured origin and preserve configured fallback', async () => {
  const body = text('verified');
  const digest = hash(body);
  const url = `blossom:${digest}.png`;
  const attempts: string[] = [];
  const h = setup({servers: () => ['https://one.example.com', 'https://two.example.com'], https: async target => {
    attempts.push(target);
    return target.startsWith('https://one.example.com/') ? body : text('wrong hash');
  }});
  try {
    const request = parseResourceRequest({type: 'resource.bytes', id: 'hint', url,
      servers: ['https://outside.example.com', 'https://one.example.com.evil.org', 'https://two.example.com:443/']});
    await h.bind().execute(request);
    assert.deepEqual(attempts, [`https://two.example.com/${digest}`, `https://one.example.com/${digest}`]);

    attempts.length = 0;
    const result = await h.bind().execute(parseResourceRequest({type: 'resource.bytesMany', id: 'modern', requests: [
      {url: 'htree://unsupported'}, {url, servers: ['https://one.example.com.evil.org']}, {url: 'data:,verified'},
    ]})) as {items: {url: string; ok: boolean}[]};
    assert.deepEqual(result.items.map(item => item.ok), [false, true, true]);
    assert.deepEqual(attempts, [`https://one.example.com/${digest}`]);
  } finally { h.service.revokeAll(); }

  const disabled = setup({servers: () => []});
  try {
    await assert.rejects(disabled.bind().execute(parseResourceRequest({type: 'resource.bytes', id: 'disabled', url,
      servers: ['https://one.example.com']})), error('blocked-by-policy'));
    assert.equal(disabled.calls(), 0);
  } finally { disabled.service.revokeAll(); }
});

test('URI and SDK hints can reorder only the four configured attempts and bytes still need the exact hash', async () => {
  const body = text('verified');
  const digest = hash(body);
  const configured = ['https://one.example.com', 'https://two.example.com', 'https://three.example.com', 'https://four.example.com'];
  const url = `blossom:${digest}?xs=two.example.com&xs=http://one.example.com&xs=https://user@one.example.com&xs=127.0.0.1&xs=one.example.com/wrong`;
  const servers = ['https://four.example.com:443/', ...Array.from({length: 9}, (_, index) => `https://outside${index}.example.com`)];
  const attempts: string[] = [];
  const h = setup({servers: () => configured, https: async (target, _signal, active, token) => {
    active();
    assert.equal(token, 'controlled-lease');
    attempts.push(target);
    return text('wrong');
  }});
  try {
    await assert.rejects(h.bind().execute(parseResourceRequest({type: 'resource.bytes', id: 'hint', url, servers})), error('decode-failed'));
    assert.deepEqual(attempts, [configured[1], configured[3], configured[0], configured[2]].map(origin => `${origin}/${digest}`));
  } finally { h.service.revokeAll(); }
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
test('rate budget includes cache hits and rollback cannot reset it', async () => {
  let clock=100;const h=setup({now:()=>clock}), s=h.bind();
  for(let i=0;i<60;i++)await s.execute(bytes('id'+i));
  await assert.rejects(s.execute(bytes('over')),error('quota-exceeded'));clock=0;
  await assert.rejects(s.execute(bytes('rollback')),error('quota-exceeded'));clock=60100;
  await s.execute(bytes('fresh'));assert.equal(h.calls(),1);h.service.revokeAll();
});

// Header fixtures exercise dimensional admission, not codec decoding.

test('classifies GLB v2 with valid JSON and binary chunk framing', () => {
  const json = text('{"asset":{"version":"2.0"}} ');
  assert.equal(json.length % 4, 0);
  const bytes = new Uint8Array(20 + json.length + 12);
  bytes.set(text('glTF'));
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.length, true);
  view.setUint32(12, json.length, true);
  bytes.set(text('JSON'), 16);
  bytes.set(json, 20);
  view.setUint32(20 + json.length, 4, true);
  bytes.set(text('BIN\0'), 24 + json.length);
  assert.equal(classifyResourceBytes(bytes), 'model/gltf-binary');

  const corrupt = (offset: number, value: number) => {
    const changed = bytes.slice();
    changed[offset] = value;
    return changed;
  };
  for (const invalid of [bytes.subarray(0, 23), corrupt(4, 1), corrupt(8, 0),
    corrupt(12, 3), corrupt(16, 0), corrupt(20, 60), corrupt(20 + json.length, 8)]) {
    assert.throws(() => classifyResourceBytes(invalid), error('decode-failed'));
  }
});

test('classifies bounded gzip containers without decoding compressed payloads', () => {
  const plain = new Uint8Array(gzipSync('measurement data'));
  const name = text('measurements.json\0');
  const named = new Uint8Array(plain.length + name.length);
  named.set(plain.subarray(0, 10));
  named[3] = 8;
  named.set(name, 10);
  named.set(plain.subarray(10), 10 + name.length);
  assert.equal(classifyResourceBytes(plain), 'application/gzip');
  assert.equal(classifyResourceBytes(named), 'application/gzip');

  for (const [offset, value] of [[2, 7], [3, 0x20], [3, 4], [10, 6]] as const) {
    const invalid = plain.slice();
    invalid[offset] = value;
    assert.throws(() => classifyResourceBytes(invalid), error('decode-failed'));
  }
  assert.throws(() => classifyResourceBytes(plain.subarray(0, 19)), error('decode-failed'));
});

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
