import test from 'node:test';
import assert from 'node:assert/strict';
import {createRoutingSettings} from '../../src/routing/routing-settings.ts';
import {setup,user} from './harness.ts';
test('trusted Settings persist scoped defaults, announce changes and remove registration without touching unrelated handlers',async t=>{
 const h=await setup(t),service=createRoutingSettings({sessionAuthority:()=>({user,epoch:0,assertActive(){}})},h.native,h.catalog,h.broker);
 await h.register(h.source);const initial=await service.list();assert.equal(initial.handlers.length,1);
 const preferred=await service.prefer('note',initial.handlers[0]!);assert.equal(preferred.defaults.length,1);assert.equal((h.sent.at(-1)!.message.availability as {hasDefault:boolean}).hasDefault,true);
 const cleared=await service.prefer('note',null);assert.equal(cleared.defaults.length,0);
 await h.catalog.remember({user,assertActive(){}},h.b);await service.prefer('note',initial.handlers[0]!);
 const removed=await service.remove(initial.handlers[0]!);assert.equal(removed.defaults.length,0);assert.equal(removed.handlers.length,1);assert.equal(removed.handlers[0]!.publisher,h.b.manifest.pubkey);
});
test('Settings cannot read or mutate with a stale identity, paused native owner or aborted lifetime',async t=>{
 const h=await setup(t),service=createRoutingSettings({sessionAuthority:()=>({user,epoch:0,assertActive(){}})},h.native,h.catalog,h.broker);
 const initial=await service.list(),abort=new AbortController();abort.abort();await assert.rejects(service.prefer('note',initial.handlers[0]!,{signal:abort.signal}));
 h.lifecycle({available:false,foreground:false});await assert.rejects(service.list());
 h.lifecycle({available:true,foreground:true,user:'06'.repeat(32),epoch:1});await assert.rejects(service.remove(initial.handlers[0]!));
 const unchanged=await h.catalog.list({user,assertActive(){}});assert.equal(unchanged.handlers.length,1);assert.equal(unchanged.defaults.length,0);
});
