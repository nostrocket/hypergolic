import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {finalizeEvent,getPublicKey} from 'nostr-tools/pure';
import {appDataContextForArtifact} from '../../src/app-data/app-data-source.ts';
import {captureAppDataContext,assertCurrentAppDataSettings} from '../../src/app-data/app-data-context.ts';
import {verifyArtifact,verifyManifest} from '../../src/napplets/verified-artifact.ts';
const secret=new Uint8Array(32).fill(35),publisher=getPublicKey(secret),appId='context-proof';
async function artifact(body='one',id=appId){
  const bytes=new TextEncoder().encode('<!doctype html><html><head></head><body>'+body+'</body></html>');
  const hash=createHash('sha256').update(bytes).digest('hex');
  const event=finalizeEvent({kind:35129,created_at:1800000000,tags:[['d',id],['x',hash]],content:'Context fixture'},secret);
  return verifyArtifact(await verifyManifest({kind:35129,pubkey:publisher,identifier:id,relayHints:[]},JSON.parse(JSON.stringify(event))),bytes);
}
test('only branded source plus actual Identity and either independent publication grant yields a stable scoped policy',async()=>{
  const first=await artifact(),next=await artifact('two'),foreign=await artifact('one','another-app');
  const network=['wss://one.example.com/','wss://two.example.com/'];
  const context=appDataContextForArtifact(first,['identity','outbox'],network)!;
  assert.deepEqual(context,appDataContextForArtifact(first,['identity','relay'],network));
  assert.equal(context.sourceKind,35129);assert.equal(context.policy.maxContentBytes,3072);
  assert.deepEqual(context.policy.defaultRelays,['wss://one.example.com']);assert(Object.isFrozen(context.policy.relays));
  assert.equal(context.policy.scope,appDataContextForArtifact(next,['identity','outbox'],network)!.policy.scope);
  assert.notEqual(context.policy.scope,appDataContextForArtifact(foreign,['identity','outbox'],network)!.policy.scope);
  for(const grants of [[],['outbox'],['relay'],['identity']])assert.equal(appDataContextForArtifact(first,grants,network),null);
  assert.throws(()=>appDataContextForArtifact({...first},['identity','outbox'],network));
});
test('unrepresentable configured relay makes only app-data unavailable, without rewriting or reordering Network settings',async()=>{
  const source=await artifact(),long='wss://one.example.com/'+ 'p'.repeat(260),network=[long,'wss://two.example.com/'];
  assert.equal(appDataContextForArtifact(source,['identity','outbox'],network),null);
  assert.deepEqual(network,[long,'wss://two.example.com/']);
  assert.equal(appDataContextForArtifact(source,['identity','outbox'],[]),null);
});
test('native-held context matches source/grants, rejects malformed arrays and stale configured settings',async()=>{
  const source=await artifact(),network=['wss://one.example.com/'],context=appDataContextForArtifact(source,['identity','outbox'],network)!;
  const origin={publisher,appId,fixture:'published',domains:['identity','outbox']};
  assert.deepEqual(captureAppDataContext(JSON.parse(JSON.stringify(context)),origin),context);
  assert.deepEqual(captureAppDataContext(context,{...origin,domains:['identity','relay']}),context);
  for(const patch of [{publisher:'a'.repeat(64)},{appId:'foreign'},{fixture:'state-lab'},{domains:['identity']}])assert.throws(()=>captureAppDataContext(context,{...origin,...patch}));
  for(const patch of [{sourceKind:5129},{policy:{...context.policy,scope:'0'.repeat(64)}},{policy:{...context.policy,maxContentBytes:16384}},
    {policy:{...context.policy,relays:['wss://one.example.com/'+'p'.repeat(260)]}},{policy:{...context.policy,relays:new Array(1)}}])assert.throws(()=>captureAppDataContext({...context,...patch},origin));
  const accessor=JSON.parse(JSON.stringify(context));Object.defineProperty(accessor.policy,'scope',{get(){throw Error('must not execute');}});
  assert.throws(()=>captureAppDataContext(accessor,origin));
  assertCurrentAppDataSettings(context,network);assert.throws(()=>assertCurrentAppDataSettings(context,['wss://two.example.com/']));
});
