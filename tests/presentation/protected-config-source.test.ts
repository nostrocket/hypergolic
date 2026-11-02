import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyEvent} from 'nostr-tools/pure';
import {createHash} from 'node:crypto';
import {createProtectedConfigurationSource,offerIncompatibleConfigurationUpdate,CONFIGURATION_SAMPLES} from '../native/presentation/protected-source.ts';
const calls:unknown[][]=[];
const fallback={async query(...args:unknown[]){calls.push(['query',...args]);return ['external'];},async readHtml(...args:unknown[]){calls.push(['readHtml',...args]);return new Uint8Array([7]);}};
const source=createProtectedConfigurationSource(fallback),signal=new AbortController().signal;
const caller=CONFIGURATION_SAMPLES.find(row=>row.role==='config-caller')!,collision=CONFIGURATION_SAMPLES.find(row=>row.role==='config-collision')!,update=CONFIGURATION_SAMPLES.find(row=>row.role==='config-incompatible-update')!;
const coordinate=(row:{event:{pubkey:string};appId:string})=>({kind:35129 as const,pubkey:row.event.pubkey,identifier:row.appId});
test('samples use verified signatures and exact HTML and aggregate hashes; collision changes only publisher',()=>{
 for(const row of CONFIGURATION_SAMPLES){assert(verifyEvent({...row.event,tags:row.event.tags.map(tag=>[...tag])}));assert.equal(createHash('sha256').update(row.html).digest('hex'),row.htmlHash);assert.equal(row.event.tags.find(tag=>tag[0]==='x')?.[1],createHash('sha256').update(row.htmlHash+' /index.html\n').digest('hex'));}
 assert.equal(caller.appId,collision.appId);assert.equal(caller.htmlHash,collision.htmlHash);assert.notEqual(caller.event.pubkey,collision.event.pubkey);assert.equal(caller.event.pubkey,update.event.pubkey);assert.notEqual(caller.htmlHash,update.htmlHash);
});
test('offered incompatible version changes fresh selection while pinned cold restoration stays exact',async()=>{
 assert.deepEqual(await source.query(coordinate(caller),[],null,signal),[caller.event]);offerIncompatibleConfigurationUpdate();assert.deepEqual(await source.query(coordinate(caller),[],null,signal),[update.event]);assert.deepEqual(await source.query(coordinate(caller),[],caller.event.id,signal),[caller.event]);assert.deepEqual(await source.query(coordinate(caller),[],update.event.id,signal),[update.event]);assert.deepEqual(await source.query(coordinate(caller),[],'0'.repeat(64),signal),[]);assert.deepEqual(await source.query(coordinate(collision),[],null,signal),[collision.event]);
});
test('foreign coordinates and hashes delegate original transport arguments without replacement',async()=>{
 const foreign={kind:35129 as const,pubkey:caller.event.pubkey,identifier:'foreign-app'},relays=['wss://relay.example.org'],servers=['https://example.org'];assert.deepEqual(await source.query(foreign,relays,null,signal),['external']);assert.deepEqual(calls.at(-1),['query',foreign,relays,null,signal]);assert.deepEqual(await source.readHtml('0'.repeat(64),servers,32,signal),new Uint8Array([7]));assert.deepEqual(calls.at(-1),['readHtml','0'.repeat(64),servers,32,signal]);
});
test('local bytes respect size and cancellation and each read returns its own carrier',async()=>{
 const bytes=await source.readHtml(caller.htmlHash,[],2*1024*1024,signal);assert.equal(createHash('sha256').update(bytes).digest('hex'),caller.htmlHash);bytes[0]=0;assert.equal(createHash('sha256').update(await source.readHtml(caller.htmlHash,[],2*1024*1024,signal)).digest('hex'),caller.htmlHash);await assert.rejects(source.readHtml(caller.htmlHash,[],1,signal));const aborted=new AbortController();aborted.abort();await assert.rejects(source.query(coordinate(caller),[],null,aborted.signal));await assert.rejects(source.readHtml(caller.htmlHash,[],2*1024*1024,aborted.signal));
});
