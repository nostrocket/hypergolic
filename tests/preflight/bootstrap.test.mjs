import test, { after } from 'node:test';
import { rm } from 'node:fs/promises';
import { buildPreflight } from './build.mjs';
import assert from 'node:assert/strict';
const compiled = await buildPreflight();
after(() => rm(compiled.directory, { recursive: true, force: true }));
let next = 0;
const fresh = () => import(`${compiled.url.href}?case=${next++}`);
const noIdentityEffects = calls => assert(!calls.some(call => /sqlite|secure-store|open-native-vault|Inventory|Stage|Secret|generate-key|derive-key|random-id/.test(call)), calls.join(','));
async function settled(module) {
 const completed = new Promise(resolve => {
  const stop=module.subscribeIdentity(()=>{if(module.getIdentityState().status!=='opening'){stop();resolve();}});
 });
 module.startIdentity();
 await completed;
}
function textOf(element) {
 if(element===null||element===undefined||typeof element==='boolean') return '';
 if(typeof element==='string') return element;
 if(Array.isArray(element)) return element.map(textOf).join(' ');
 return textOf(element.props?.children);
}
test('actual iOS owner composition denies Simulator before SQLite open or identity persistence', async () => {
 const module=await fresh();
 await assert.rejects(module.openTrustedIdentityOwner(),module.IdentityDeviceRequired);
 assert.deepEqual(module.fixture.calls,['module:HypergolicSignerCore','activate-vault','available']);
 noIdentityEffects(module.fixture.calls);
});
test('actual state/entry renders device-required and repeated starts never retry persistence', async () => {
 const module=await fresh();
 await settled(module);
 assert.deepEqual(module.getIdentityState(),{status:'device-required'});
 const text=textOf(module.IdentityEntry());
 assert.match(text,/Use a physical iPhone/);
 assert.match(text,/Simulator cannot provide the file protection required/);
 assert.doesNotMatch(text,/needs attention|Restart Hypergolic|npub1/);
 const calls=[...module.fixture.calls];
 module.startIdentity(); module.startIdentity(); await Promise.resolve();
 assert.deepEqual(module.fixture.calls,calls);
 assert.equal(calls.filter(value=>value==='claim').length,1);
 noIdentityEffects(calls);
});
for(const value of [null,undefined,0,1,'false','true']) test(`malformed availability ${String(value)} stays recovery-required before metadata`,async()=>{
 const module=await fresh(); module.fixture.available=value;
 await settled(module);
 assert.deepEqual(module.getIdentityState(),{status:'recovery-required'});
 assert.match(textOf(module.IdentityEntry()),/Your identity needs attention/);
 noIdentityEffects(module.fixture.calls);
});
for(const failure of [{code:'ERR_IDENTITY_STORE_UNAVAILABLE'},new Error('private native detail')]) test('native availability rejection is a storage failure, never inferred device-required',async()=>{
 const module=await fresh();module.fixture.availabilityFailure=failure;
 await settled(module);
 assert.deepEqual(module.getIdentityState(),{status:'recovery-required'});
 assert.doesNotMatch(textOf(module.IdentityEntry()),/private native detail|physical iPhone/);
 noIdentityEffects(module.fixture.calls);
});
test('missing module is recovery-required and never opens metadata',async()=>{
 const module=await fresh();module.fixture.missingStore=true;
 await settled(module);
 assert.deepEqual(module.getIdentityState(),{status:'recovery-required'});
 noIdentityEffects(module.fixture.calls);
});
test('consumed process owner remains restart-required before any module or storage initialization',async()=>{
 const module=await fresh();module.fixture.claim=false;
 await settled(module);
 assert.deepEqual(module.getIdentityState(),{status:'restart-required'});
 assert.deepEqual(module.fixture.calls,['claim']);
 assert.match(textOf(module.IdentityEntry()),/Restart Hypergolic/);
});
test('literal supported result reaches native persistence once without JavaScript secret storage',async()=>{
 const module=await fresh();module.fixture.available=true;
 await assert.rejects(module.openTrustedIdentityOwner());
 assert.equal(module.fixture.calls.filter(value=>value==='open-native-vault').length,1);
 assert(!module.fixture.calls.some(value=>/sqlite|secure-store|generate-key|Secret/.test(value)));
});
