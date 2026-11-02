import assert from 'node:assert/strict';
import test from 'node:test';
import {openIdentityListAccess, IDENTITY_PERMISSION_DATABASE, type IdentityListOwner} from '../../src/identity/identity-permissions.ts';
import type {NativeRegistration} from '../../src/runtime/capability-protocol.ts';
import {DiskSQLite, hex} from '../storage/harness.ts';
const registration: NativeRegistration = {user: hex(1), publisher: hex(2), appId: 'signed-app', version: hex(3), instanceId: 'one', sessionId: 'one', generation: 'generation', epoch: 0, fixture: 'published', domains: ['identity']};
const selected = {user: registration.user};
const signal = () => new AbortController().signal;
async function setup(t: {after(fn: () => void): void}) {
  const sqlite = new DiskSQLite(); t.after(() => sqlite.cleanup());
  const policy: IdentityListOwner[][] = [], current = {...selected};
  const native = {replace(owners: readonly IdentityListOwner[]) {policy.push([...owners]);}};
  const access = await openIdentityListAccess(sqlite, 'android', native, () => current.user);
  return {sqlite, policy, native, current, access};
}
const empty = () => {};
test('separate explicit approval persists the exact public user/publisher/app and cold restart remembers it across app versions', async t => {
  const {sqlite, policy, native, current, access} = await setup(t);
  const pending = access.authorize(registration, signal(), empty);
  const review = access.getSnapshot().review!; assert.deepEqual(review.owner, {user: hex(1), publisher: hex(2), appId: 'signed-app'});
  assert.deepEqual(policy.at(-1), []);
  await access.decide(review.id, true); (await pending)(); assert.equal(access.getSnapshot().grants.length, 1);
  await access.close(); assert.deepEqual(policy.at(-1), []);
  const cold = await openIdentityListAccess(sqlite, 'android', native, () => current.user);
  (await cold.authorize({...registration, version: hex(9), generation: 'new-generation'}, signal(), empty))();
  assert.equal(cold.getSnapshot().review, null); assert.equal(policy.at(-1)!.length, 1);
});
test('denial and duplicate pending reads grant nothing; stale review IDs cannot approve another request', async t => {
  const {access, policy, sqlite} = await setup(t);
  const pending = access.authorize(registration, signal(), empty); const denied = assert.rejects(pending, /access denied/);
  await assert.rejects(access.authorize(registration, signal(), empty), /approval busy/);
  const id = access.getSnapshot().review!.id; await access.decide(id, false); await denied;
  await assert.rejects(access.decide(id, true), /expired/); assert.deepEqual(policy.at(-1), []);
  assert.equal(sqlite.raw(IDENTITY_PERMISSION_DATABASE).prepare('SELECT count(*) AS n FROM identity_list_access').get()!.n, 0);
});
test('permission never crosses publisher, app or selected public user', async t => {
  const {access, current} = await setup(t);
  const approved = access.authorize(registration, signal(), empty); await access.decide(access.getSnapshot().review!.id, true); (await approved)();
  for (const delta of [{publisher: hex(4)}, {appId: 'another-app'}]) {
    const pending = access.authorize({...registration, ...delta}, signal(), empty); const denied = assert.rejects(pending); assert.ok(access.getSnapshot().review); await access.decide(access.getSnapshot().review!.id, false); await denied;
  }
  current.user = hex(5);
  await assert.rejects(access.authorize(registration, signal(), empty), /owner changed/);
  const pending = access.authorize({...registration, user: current.user}, signal(), empty); const denied = assert.rejects(pending); await access.decide(access.getSnapshot().review!.id, false); await denied;
});
test('revocation immediately removes native permission and permanently invalidates old read guards, even after reapproval', async t => {
  const {access, policy, sqlite} = await setup(t);
  const pending = access.authorize(registration, signal(), empty); await access.decide(access.getSnapshot().review!.id, true); const guard = await pending;
  const grant = access.getSnapshot().grants[0]!;
  sqlite.onStep = sql => {if (sql.startsWith('DELETE FROM identity_list_access')) {assert.deepEqual(policy.at(-1), []); assert.throws(guard, /revoked/);}};
  await access.revoke(grant); sqlite.onStep = undefined; assert.throws(guard, /revoked/);
  const again = access.authorize(registration, signal(), empty); await access.decide(access.getSnapshot().review!.id, true); (await again)(); assert.throws(guard, /revoked/);
});
test('abort removes review before approval and can never store an allowance', async t => {
  const {access, sqlite} = await setup(t); const controller = new AbortController();
  const pending = access.authorize(registration, controller.signal, empty); const denied = assert.rejects(pending, /cancelled/); const id = access.getSnapshot().review!.id;
  controller.abort(); await denied; assert.equal(access.getSnapshot().review, null); await assert.rejects(access.decide(id, true), /expired/);
  assert.equal(sqlite.raw(IDENTITY_PERMISSION_DATABASE).prepare('SELECT count(*) AS n FROM identity_list_access').get()!.n, 0);
});
for (const mode of ['before', 'after', 'omit'] as const) test(`failed ${mode} approval commit/readback never mirrors or returns permission`, async t => {
  const {access, policy, sqlite} = await setup(t); const pending = access.authorize(registration, signal(), empty); const denied = assert.rejects(pending, /unavailable/);
  sqlite.faults.push({prefix: mode === 'omit' ? 'INSERT INTO identity_list_access' : 'COMMIT', mode});
  await access.decide(access.getSnapshot().review!.id, true); await denied;
  assert.deepEqual(policy.at(-1), []); assert.equal(access.getSnapshot().grants.length, 0); assert.equal(access.getSnapshot().error, 'Public list approval could not be saved.');
});
test('identity revocation during commit suppresses permission delivery and native mirroring', async t => {
  const {access, policy, sqlite, current} = await setup(t);
  const pending = access.authorize(registration, signal(), empty); const denied = assert.rejects(pending, /unavailable/);
  sqlite.onStep = sql => {if (sql === 'COMMIT') current.user = hex(8);};
  await access.decide(access.getSnapshot().review!.id, true); await denied; assert.deepEqual(policy.at(-1), []);
});
test('failed revocation remains denied in process and discloses uncertain persistent state', async t => {
  const {access, policy, sqlite} = await setup(t);
  const pending = access.authorize(registration, signal(), empty); await access.decide(access.getSnapshot().review!.id, true); const guard = await pending;
  sqlite.faults.push({prefix: 'DELETE FROM identity_list_access', mode: 'before'});
  await assert.rejects(access.revoke(access.getSnapshot().grants[0]!), /unavailable/); assert.throws(guard, /revoked/); assert.deepEqual(policy.at(-1), []);
  assert.match(access.getSnapshot().error!, /Restart may restore/);
});
test('corrupt stored owner cannot become a native allowance on reopen', async t => {
  const {access, native, sqlite, current, policy} = await setup(t); await access.close();
  sqlite.raw(IDENTITY_PERMISSION_DATABASE).prepare('INSERT INTO identity_list_access (user, publisher, app) VALUES (?, ?, ?)').run('invalid', hex(2), 'app');
  await assert.rejects(openIdentityListAccess(sqlite, 'android', native, () => current.user)); assert.deepEqual(policy.at(-1), []);
});
test('an uncertain approval commit requires a new explicit decision before a retry may mirror its durable row',async t=>{
 const {access,sqlite,policy}=await setup(t);const first=access.authorize(registration,signal(),empty);const rejected=assert.rejects(first,/unavailable/);
 sqlite.faults.push({prefix:'COMMIT',mode:'after'});await access.decide(access.getSnapshot().review!.id,true);await rejected;assert.deepEqual(policy.at(-1),[]);
 const retry=access.authorize(registration,signal(),empty);assert.ok(access.getSnapshot().review);assert.deepEqual(policy.at(-1),[]);
 await access.decide(access.getSnapshot().review!.id,true);(await retry)();assert.equal(policy.at(-1)!.length,1);assert.equal(access.getSnapshot().grants.length,1);
});
