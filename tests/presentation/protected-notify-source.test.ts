import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyEvent} from 'nostr-tools/pure';
import {createHash} from 'node:crypto';
import {createProtectedNotificationSource,NOTIFICATION_SAMPLES,offerNotificationUpdate} from '../native/presentation/protected-notify-source.ts';
const caller=NOTIFICATION_SAMPLES.find(row=>row.role==='caller')!,collision=NOTIFICATION_SAMPLES.find(row=>row.role==='notify-collision')!;
const coordinate=(row:{event:{pubkey:string};appId:string})=>({kind:35129 as const,pubkey:row.event.pubkey,identifier:row.appId});
const signal=new AbortController().signal;
test('notification collision preserves exact signed app and HTML while changing only publisher',()=>{
 for(const row of NOTIFICATION_SAMPLES){assert(verifyEvent({...row.event,tags:row.event.tags.map(tag=>[...tag])}));assert.equal(createHash('sha256').update(row.html).digest('hex'),row.htmlHash);assert.equal(row.event.tags.find(tag=>tag[0]==='x')?.[1],createHash('sha256').update(row.htmlHash+' /index.html\n').digest('hex'));}
 assert.equal(caller.appId,collision.appId);assert.equal(caller.html,collision.html);assert.equal(caller.htmlHash,collision.htmlHash);assert.deepEqual(caller.event.tags,collision.event.tags);assert.notEqual(caller.event.pubkey,collision.event.pubkey);assert.notEqual(caller.event.id,collision.event.id);
});
test('signed coordinate and pin select exact publisher without cross-publisher replacement',async()=>{
 const fallback={async query(){throw Error('Unexpected fallback');},async readHtml(){throw Error('Unexpected fallback');}},source=createProtectedNotificationSource(fallback);
 assert.deepEqual(await source.query(coordinate(caller),[],null,signal),[caller.event]);assert.deepEqual(await source.query(coordinate(collision),[],null,signal),[collision.event]);assert.deepEqual(await source.query(coordinate(caller),[],caller.event.id,signal),[caller.event]);assert.deepEqual(await source.query(coordinate(caller),[],collision.event.id,signal),[]);assert.deepEqual(await source.query(coordinate(collision),[],caller.event.id,signal),[]);
});
test('foreign coordinates and hashes preserve original transport arguments',async()=>{
 const calls:unknown[][]=[],fallback={async query(...args:unknown[]){calls.push(['query',...args]);return [];},async readHtml(...args:unknown[]){calls.push(['readHtml',...args]);return new Uint8Array([7]);}},source=createProtectedNotificationSource(fallback),foreign={kind:35129 as const,pubkey:caller.event.pubkey,identifier:'unrelated'},relays=['wss://relay.example.org'],servers=['https://example.org'];
 assert.deepEqual(await source.query(foreign,relays,null,signal),[]);assert.deepEqual(calls.at(-1),['query',foreign,relays,null,signal]);assert.deepEqual(await source.readHtml('0'.repeat(64),servers,32,signal),new Uint8Array([7]));assert.deepEqual(calls.at(-1),['readHtml','0'.repeat(64),servers,32,signal]);
});
test('notification local bytes respect cancellation, bounds and fresh carriers',async()=>{
 const fallback={async query(){return [];},async readHtml(){return new Uint8Array();}},source=createProtectedNotificationSource(fallback),bytes=await source.readHtml(caller.htmlHash,[],2*1024*1024,signal);assert.equal(createHash('sha256').update(bytes).digest('hex'),caller.htmlHash);bytes[0]=0;assert.equal(createHash('sha256').update(await source.readHtml(caller.htmlHash,[],2*1024*1024,signal)).digest('hex'),caller.htmlHash);await assert.rejects(source.readHtml(caller.htmlHash,[],1,signal));const abort=new AbortController();abort.abort();await assert.rejects(source.query(coordinate(caller),[],null,abort.signal));await assert.rejects(source.readHtml(caller.htmlHash,[],2*1024*1024,abort.signal));
});

test('offered notification version changes latest lookup while preserving exact old and new pins',async()=>{
 const updated=NOTIFICATION_SAMPLES.find(row=>row.role==='notify-update')!;
 assert.equal(updated.appId,caller.appId);assert.equal(updated.event.pubkey,caller.event.pubkey);assert.equal(updated.address,caller.address);assert.notEqual(updated.htmlHash,caller.htmlHash);assert.notEqual(updated.event.id,caller.event.id);assert(updated.event.created_at>caller.event.created_at);assert.deepEqual(updated.event.tags.filter(tag=>tag[0]==='requires'),caller.event.tags.filter(tag=>tag[0]==='requires'));
 const fallback={async query(){throw Error('Unexpected fallback');},async readHtml(){throw Error('Unexpected fallback');}},source=createProtectedNotificationSource(fallback);
 offerNotificationUpdate();assert.deepEqual(await source.query(coordinate(caller),[],null,signal),[updated.event]);assert.deepEqual(await source.query(coordinate(caller),[],caller.event.id,signal),[caller.event]);assert.deepEqual(await source.query(coordinate(caller),[],updated.event.id,signal),[updated.event]);assert.deepEqual(await source.query(coordinate(collision),[],null,signal),[collision.event]);assert.deepEqual(await source.query(coordinate(caller),[],collision.event.id,signal),[]);
 assert.equal(createHash('sha256').update(await source.readHtml(updated.htmlHash,[],2*1024*1024,signal)).digest('hex'),updated.htmlHash);
});
