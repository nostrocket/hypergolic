import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { IdentityTransition, IdentityChangeError } from '../../src/security/identity-transition.ts';
import { bindRoutingOwner } from '../../src/routing/routing-owner.ts';
import { VaultError } from '../../src/security/identity-vault.ts';
import { Integrated, pubkey } from '../security/harness.ts';
import { initialTestWorkspace, bundledUXDescriptor, assertBundledWorkspace } from '../../src/shell/fixtures.ts';
import { emptyWorkspace, openNapplet, snapshotWorkspace } from '../../src/shell/workspace.ts';
import { setup, deferred, registration } from './harness.ts';

const imports = new WeakMap<IdentityTransition, { setImportTarget(value: number): void }>();

async function start(t: TestContext) {
  const protectedStore = new Integrated();
  t.after(() => protectedStore.sqlite.cleanup());
  const native = await protectedStore.owner();
  await native.vault.open();
  const storage = await setup(t);
  const ports = { vault: native.vault, database: storage.database, seed: initialTestWorkspace, assertAvailable: assertBundledWorkspace };
  const transition = await IdentityTransition.open(ports);
  imports.set(transition, native.vault);
  return { ...storage, protectedStore, native, ports, transition };
}
async function request(owner: IdentityTransition, target = 2) {
  imports.get(owner)!.setImportTarget(target);
  const pending = await owner.prepareImport(); assert(pending); return pending;
}

test('invalid input, cancelling import and stale confirmation preserve the live workspace and vault', async t => {
  const { transition, native, protectedStore } = await start(t);
  const before = transition.getSnapshot().session;
  const calls = protectedStore.secure.calls.length;
  native.vault.setImportTarget(-1);
  await assert.rejects(transition.prepareImport(), { code: 'INVALID_NSEC' });
  assert.equal(transition.getSnapshot().session, before);
  const pending = await request(transition);
  assert.equal(JSON.stringify(transition.getSnapshot()).includes('nsec1fixture'), false);
  assert.equal(native.vault.getSnapshot().identities.length, 1);
  transition.cancel(pending);
  assert.equal(transition.getSnapshot().session, before);
  await assert.rejects(transition.confirm(pending), { code: 'STALE' });
  assert.equal(protectedStore.secure.calls.length, calls);
});

test('import persists selection, retains loaded order/focus and revokes every old authority', async t => {
  const { transition, native, database } = await start(t);
  const previous = transition.getSnapshot().session;
  const oldAuthority = transition.sessionAuthority();
  const oldStrings = database.bindStorage(registration({ user: oldAuthority.user, assertActive: oldAuthority.assertActive }));
  await oldStrings.port.set('state', 'first identity');
  await transition.confirm(await request(transition));
  const current = transition.getSnapshot();
  assert.equal(current.phase, 'ready');
  assert.equal(current.session.vault.selectedPubkey, pubkey(2));
  assert.equal(current.session.vault.identities.length, 2);
  assert.equal(native.vault.getSnapshot().selectedPubkey, pubkey(2));
  assert.equal(current.session.epoch, previous.epoch + 1);
  assert.notEqual(current.session.workspace, previous.workspace);
  assert.deepEqual(current.session.workspace.getSnapshot().workspace, previous.workspace.getSnapshot().workspace);
  assert.equal(previous.workspace.getSnapshot().error, 'REVOKED');
  assert.throws(oldAuthority.assertActive, { code: 'STALE' });
  await assert.rejects(oldStrings.port.get('state'), { code: 'REVOKED' });
  const authority = transition.sessionAuthority();
  assert.equal(await database.bindStorage(registration({ user: authority.user, assertActive: authority.assertActive })).port.get('state'), null);
  const back = transition.prepareSelect(pubkey(1)); assert(back);
  await transition.confirm(back);
  const restored = transition.sessionAuthority();
  assert.equal(await database.bindStorage(registration({ user: restored.user, assertActive: restored.assertActive })).port.get('state'), 'first identity');
});

test('duplicate/current import is a no-op; duplicate saved import selects without adding another identity', async t => {
  const { transition } = await start(t);
  imports.get(transition)!.setImportTarget(1);
  assert.equal(await transition.prepareImport(), null);
  assert.equal(transition.getSnapshot().session.epoch, 0);
  await transition.confirm(await request(transition));
  const back = await request(transition, 1);
  assert.equal(back.kind, 'select');
  await transition.confirm(back);
  assert.equal(transition.getSnapshot().session.vault.identities.length, 2);
  assert.equal(transition.getSnapshot().session.vault.selectedPubkey, pubkey(1));
});

test('selection/import are single-flight, frozen workspace ignores late callbacks, and capabilities pause during commit', async t => {
  const { transition, sqlite } = await start(t);
  const pending = await request(transition);
  const previous = transition.getSnapshot().session;
  const authority = transition.sessionAuthority();
  const gate = deferred(), entered = deferred();
  sqlite.onStep = async sql => { if (sql.startsWith('UPDATE workspaces')) { entered.resolve(); await gate.promise; } };
  previous.workspace.change(openNapplet(initialTestWorkspace(), bundledUXDescriptor(4)));
  const switching = transition.confirm(pending);
  await entered.promise;
  assert.equal(transition.getSnapshot().phase, 'switching');
  assert.throws(authority.assertActive, { code: 'STALE' });
  assert.throws(() => transition.prepareSelect(pubkey(1)), { code: 'BUSY' });
  await assert.rejects(transition.confirm(pending), { code: 'STALE' });
  transition.cancel(pending);
  previous.workspace.change(emptyWorkspace());
  assert.equal(previous.workspace.getSnapshot().workspace.sessions.length, 4);
  gate.resolve(); await switching;
  assert.equal(transition.getSnapshot().session.workspace.getSnapshot().workspace.sessions.length, 4);
});

test('explicit empty workspace carries through selection and ordinary restart without fixture reseeding', async t => {
  const { transition, ports } = await start(t);
  transition.getSnapshot().session.workspace.change(emptyWorkspace());
  await transition.confirm(await request(transition));
  assert.equal(transition.getSnapshot().session.workspace.getSnapshot().workspace.sessions.length, 0);
  const restarted = await IdentityTransition.open(ports);
  assert.equal(restarted.getSnapshot().session.vault.selectedPubkey, pubkey(2));
  assert.equal(restarted.getSnapshot().session.workspace.getSnapshot().workspace.sessions.length, 0);
});

test('known precommit validation failure keeps the same mounted session and permits later workspace changes', async t => {
  const { ports, transition } = await start(t);
  const before = transition.getSnapshot().session;
  ports.vault.commitImport = async () => { throw new VaultError('LIMIT_REACHED'); };
  await assert.rejects(transition.confirm(await request(transition)), { code: 'LIMIT_REACHED' });
  assert.equal(transition.getSnapshot().phase, 'ready');
  assert.equal(transition.getSnapshot().session, before);
  assert.equal(transition.getSnapshot().failure, 'LIMIT_REACHED');
  before.workspace.change(emptyWorkspace()); await before.workspace.flush();
  assert.equal(before.workspace.getSnapshot().workspace.sessions.length, 0);
  transition.sessionAuthority().assertActive();
});

test('source persistence failure stops before identity mutation and preserves saved data', async t => {
  const { transition, sqlite, native } = await start(t);
  sqlite.faults.push({ prefix: 'UPDATE workspaces', mode: 'before' });
  transition.getSnapshot().session.workspace.change(emptyWorkspace());
  await assert.rejects(transition.confirm(await request(transition)), { code: 'RECOVERY_REQUIRED' });
  assert.equal(native.vault.getSnapshot().selectedPubkey, pubkey(1));
  assert.equal(transition.getSnapshot().phase, 'recovery');
  assert.throws(transition.sessionAuthority().assertActive, IdentityChangeError);
});

test('lost destination commit acknowledgement requires restart; no old identity is exposed under the new selection', async t => {
  const { transition, sqlite, native, ports } = await start(t);
  sqlite.faults.push({ prefix: 'COMMIT', mode: 'after' });
  await assert.rejects(transition.confirm(await request(transition)), { code: 'RECOVERY_REQUIRED' });
  assert.equal(transition.getSnapshot().phase, 'recovery');
  assert.equal(native.vault.getSnapshot().selectedPubkey, pubkey(2));
  assert.throws(transition.sessionAuthority().assertActive, { code: 'STALE' });
  const restarted = await IdentityTransition.open(ports);
  assert.equal(restarted.getSnapshot().session.vault.selectedPubkey, pubkey(2));
  assert.equal(restarted.getSnapshot().session.workspace.getSnapshot().workspace.sessions.length, 3);
});

test('corrupt destination workspace is preserved and blocks entry after durable selection', async t => {
  const { transition, sqlite } = await start(t);
  sqlite.raw().prepare('INSERT INTO workspaces (user, revision, payload) VALUES (?, ?, ?)').run(pubkey(2), 0, 'invalid fixture data');
  await assert.rejects(transition.confirm(await request(transition)), { code: 'RECOVERY_REQUIRED' });
  assert.equal(transition.getSnapshot().phase, 'recovery');
  assert.equal(sqlite.raw().prepare('SELECT payload FROM workspaces WHERE user = ?').get(pubkey(2))?.payload, 'invalid fixture data');
});

test('deleting an inactive identity preserves the live workspace, capability authority and selected saved data', async t => {
  const { transition, database, native } = await start(t);
  await transition.confirm(await request(transition));
  const before = transition.getSnapshot().session, authority = transition.sessionAuthority();
  const strings = database.bindStorage(registration({ user: authority.user, assertActive: authority.assertActive }));
  await strings.port.set('draft', 'retained current identity');
  before.workspace.change(openNapplet(before.workspace.getSnapshot().workspace, bundledUXDescriptor(4)));
  await transition.deleteInactive(pubkey(1), before);
  const after = transition.getSnapshot();
  assert.equal(after.phase, 'ready'); assert.equal(after.session.workspace, before.workspace);
  assert.equal(after.session.epoch, before.epoch); assert.equal(after.session.vault.selectedPubkey, pubkey(2));
  assert.equal(after.session.vault.revision, before.vault.revision + 1);
  assert.deepEqual(after.session.vault.identities.map(item => item.pubkey), [pubkey(2)]);
  authority.assertActive(); assert.equal(await strings.port.get('draft'), 'retained current identity');
  assert.equal(before.workspace.getSnapshot().workspace.sessions.length, 4);
  before.workspace.change(emptyWorkspace()); await before.workspace.flush();
  assert.equal(before.workspace.getSnapshot().error, null);
  assert.equal((await native.vault.open()).identities.length, 1);
});

test('rejected deletion keeps the mounted session, while selected, absent and stale targets never authenticate', async t => {
  const { transition, protectedStore } = await start(t);
  const original = transition.getSnapshot().session;
  await assert.rejects(transition.deleteInactive(pubkey(1), original), { code: 'DELETE_SELECTED' });
  await assert.rejects(transition.deleteInactive(pubkey(7), original), { code: 'NOT_FOUND' });
  assert.equal(protectedStore.authCalls, 0);
  await transition.confirm(await request(transition)); const selected = transition.getSnapshot().session;
  await assert.rejects(transition.deleteInactive(pubkey(1), original), { code: 'STALE' });
  protectedStore.authActive = false;
  await assert.rejects(transition.deleteInactive(pubkey(1), selected), { code: 'AUTHORIZATION_DENIED' });
  assert.equal(transition.getSnapshot().session, selected);
  assert.equal(transition.getSnapshot().failure, 'DELETION_REJECTED');
  transition.sessionAuthority().assertActive();
  selected.workspace.change(emptyWorkspace()); await selected.workspace.flush();
  assert.equal(selected.workspace.getSnapshot().error, null);
});

test('deletion freezes and flushes workspace before authenticating, and prevents concurrent identity changes', async t => {
  const { transition, sqlite, protectedStore } = await start(t);
  await transition.confirm(await request(transition)); const before = transition.getSnapshot().session;
  const gate = deferred(), entered = deferred();
  sqlite.onStep = async sql => { if (sql.startsWith('UPDATE workspaces')) { entered.resolve(); await gate.promise; } };
  before.workspace.change(openNapplet(before.workspace.getSnapshot().workspace, bundledUXDescriptor(4)));
  const routing:{available:boolean}={available:true};
  t.after(bindRoutingOwner(transition,{synchronizeRoutingOwner(_user,_epoch,available){routing.available=available;}}));
  const deletion = transition.deleteInactive(pubkey(1), before); await entered.promise;
  assert.equal(routing.available,false);
  assert.equal(transition.getSnapshot().phase, 'deleting'); assert.equal(protectedStore.authCalls, 0);
  assert.throws(transition.sessionAuthority().assertActive, { code: 'STALE' });
  assert.throws(() => transition.prepareSelect(pubkey(1)), { code: 'BUSY' });
  await assert.rejects(transition.deleteInactive(pubkey(1), before), { code: 'BUSY' });
  before.workspace.change(emptyWorkspace()); assert.equal(before.workspace.getSnapshot().workspace.sessions.length, 4);
  gate.resolve(); await deletion; assert.equal(protectedStore.authCalls, 1);
});

test('failed workspace persistence stops deletion before authentication or key removal', async t => {
  const { transition, sqlite, protectedStore, native } = await start(t);
  await transition.confirm(await request(transition)); const before = transition.getSnapshot().session;
  const routing:{available:boolean}={available:true};
  t.after(bindRoutingOwner(transition,{synchronizeRoutingOwner(_user,_epoch,available){routing.available=available;}}));
  sqlite.faults.push({ prefix: 'UPDATE workspaces', mode: 'before' }); before.workspace.change(emptyWorkspace());
  await assert.rejects(transition.deleteInactive(pubkey(1), before), { code: 'RECOVERY_REQUIRED' });
  assert.equal(routing.available,false);
  assert.equal(protectedStore.authCalls, 0); assert.equal(native.vault.getSnapshot().identities.length, 2);
  assert.equal(transition.getSnapshot().phase, 'recovery');
});

test('unexpected inventory changes and uncertain delete outcomes revoke the live session', async t => {
  for (const mode of ['changed', 'uncertain'] as const) {
    const { transition, ports } = await start(t);
    await transition.confirm(await request(transition)); const before = transition.getSnapshot().session;
    const authority = transition.sessionAuthority();
    ports.vault.deleteIdentity = async () => {
      if (mode === 'uncertain') throw new VaultError('READBACK_FAILED');
      return { ...before.vault, selectedPubkey: pubkey(1), revision: before.vault.revision + 1 };
    };
    await assert.rejects(transition.deleteInactive(pubkey(1), before));
    assert.equal(transition.getSnapshot().phase, 'recovery'); assert.throws(authority.assertActive, { code: 'STALE' });
  }
});

test('approval lost after journal commit preserves the workspace and exposes the exact deletion to retry', async t => {
  const { transition, protectedStore, native } = await start(t);
  await transition.confirm(await request(transition)); const before = transition.getSnapshot().session;
  const authority = transition.sessionAuthority();
  protectedStore.sqlite.onStep = name => { if (name === 'exec:COMMIT') protectedStore.authActive = false; };
  await assert.rejects(transition.deleteInactive(pubkey(1), before), { code: 'AUTHORIZATION_DENIED' });
  const pending = transition.getSnapshot();
  assert.equal(pending.phase, 'ready'); assert.equal(pending.failure, 'DELETION_PENDING');
  assert.equal(pending.session.workspace, before.workspace); assert.equal(pending.session.epoch, before.epoch);
  assert.equal(pending.session.vault.pendingDeletion, pubkey(1));
  assert.equal(pending.session.vault.identities.find(value => value.pubkey === pubkey(1))?.status, 'deleting');
  authority.assertActive(); assert.equal(native.vault.getSnapshot().identities.length, 2);
  protectedStore.sqlite.onStep = null; protectedStore.authActive = true;
  await assert.rejects(transition.deleteInactive(pubkey(1), before), { code: 'STALE' });
  await transition.deleteInactive(pubkey(1), pending.session);
  assert.equal(transition.getSnapshot().session.workspace, before.workspace); authority.assertActive();
  assert.equal(transition.getSnapshot().session.vault.pendingDeletion, null);
  assert.equal(protectedStore.authCalls, 2);
});

test('retained authority after deletion still rejects a later identity switch and an unaccepted inventory revision', async t => {
  const { transition, ports } = await start(t);
  await transition.confirm(await request(transition)); const before = transition.getSnapshot().session;
  const authority = transition.sessionAuthority();
  await transition.deleteInactive(pubkey(1), before); authority.assertActive();
  await transition.confirm(await request(transition, 3));
  assert.throws(authority.assertActive, { code: 'STALE' });
  const back = transition.prepareSelect(pubkey(2)); assert(back); await transition.confirm(back);
  assert.throws(authority.assertActive, { code: 'STALE' });
  const currentAuthority = transition.sessionAuthority(), accepted = transition.getSnapshot().session.vault;
  ports.vault.getSnapshot = () => ({ ...accepted, revision: accepted.revision + 1 });
  assert.throws(currentAuthority.assertActive, { code: 'STALE' });
  transition.getSnapshot().session.workspace.change(emptyWorkspace()); await transition.getSnapshot().session.workspace.flush();
  assert.equal(transition.getSnapshot().session.workspace.getSnapshot().error, 'REVOKED');
});


test('cancel during the initial deletion flush never opens authentication and preserves the live workspace', async t => {
  const { transition, protectedStore } = await start(t);
  await transition.confirm(await request(transition));
  const before = transition.getSnapshot().session;
  const deleting = transition.deleteInactive(pubkey(1), before);
  transition.cancelDeletion(before);
  await assert.rejects(deleting, { code: 'AUTHORIZATION_DENIED' });
  assert.equal(protectedStore.authCalls, 0);
  assert.equal(transition.getSnapshot().session, before);
  assert.equal(transition.getSnapshot().phase, 'ready');
  await transition.deleteInactive(pubkey(1), before);
  assert.equal(protectedStore.authCalls, 1);
});
test('cancel while protected keys are verified never reaches a later authentication prompt', async t => {
  const { transition, native, protectedStore } = await start(t);
  await transition.confirm(await request(transition));
  const before = transition.getSnapshot().session;
  protectedStore.secure.onStep = name => { if (name.startsWith('get:secret.')) transition.cancelDeletion(before); };
  await assert.rejects(transition.deleteInactive(pubkey(1), before), { code: 'AUTHORIZATION_DENIED' });
  assert.equal(protectedStore.authCalls, 0);
  assert.equal(transition.getSnapshot().session, before);
});

test('routing owner retains current authority for pending import and cancellation but withdraws it synchronously before confirmed change',async t=>{
 const {transition,native}=await start(t),before=transition.getSnapshot().session;
 const calls:{user:string;epoch:number;available:boolean;selected:string}[]=[];
 t.after(bindRoutingOwner(transition,{synchronizeRoutingOwner(user,epoch,available){calls.push({user,epoch,available,selected:native.vault.getSnapshot().selectedPubkey});}}));
 const pending=await request(transition);transition.cancel(pending);
 assert.deepEqual(calls.map(c=>c.available),[true,true,true]);
 assert(calls.every(c=>c.user===pubkey(1)&&c.selected===pubkey(1)&&c.epoch===before.epoch));
 const chosen=await request(transition);const confirmed=transition.confirm(chosen);
 assert.deepEqual(calls.at(-1),{user:pubkey(1),epoch:before.epoch,available:false,selected:pubkey(1)});
 await confirmed;
 assert.deepEqual(calls.at(-1),{user:pubkey(2),epoch:before.epoch+1,available:true,selected:pubkey(2)});
});

test('cancelling native input discards a late public candidate without changing the workspace', async t => {
  const { transition, ports } = await start(t);
  const original = transition.getSnapshot().session;
  const candidate = Object.freeze({ handle: 'native_late_candidate', pubkey: pubkey(2) });
  let deliver!: (value: typeof candidate) => void;
  const cancelled: object[] = [];
  ports.vault.prepareImport = async () => new Promise(done => { deliver = done; });
  ports.vault.cancelImport = value => { cancelled.push(value); };
  const result = transition.prepareImport();
  assert.throws(() => transition.prepareSelect(pubkey(1)), { code: 'BUSY' });
  transition.cancelImportPreparation(); deliver(candidate);
  assert.equal(await result, null);
  assert.deepEqual(cancelled, [candidate]);
  assert.equal(transition.getSnapshot().session, original);
  assert.equal(transition.getSnapshot().pending, null);
});

test('failed workspace flush retires its prepared native candidate before any import commit', async t => {
  const { transition, ports, sqlite } = await start(t);
  let commits = 0, cancellations = 0;
  ports.vault.commitImport = async () => { commits++; throw new Error('must not commit'); };
  const cancel = ports.vault.cancelImport.bind(ports.vault);
  ports.vault.cancelImport = candidate => { cancellations++; cancel(candidate); };
  transition.getSnapshot().session.workspace.change(emptyWorkspace());
  sqlite.faults.push({ prefix: 'UPDATE workspaces', mode: 'before' });
  await assert.rejects(transition.confirm(await request(transition)), { code: 'RECOVERY_REQUIRED' });
  assert.equal(commits, 0); assert.equal(cancellations, 1);
});


test('same-account method selection preserves napplet data and revokes old workspace authority', async t => {
  const { transition, ports, database } = await start(t);
  const before = transition.getSnapshot().session;
  const oldAuthority = transition.sessionAuthority();
  const oldData = database.bindStorage(registration({ user: oldAuthority.user, assertActive: oldAuthority.assertActive }));
  await oldData.port.set('draft', 'same account data');
  let saved = before.vault, mutations = 0;
  ports.vault.getSnapshot = () => saved;
  ports.vault.selectSigningMethod = async (account, method) => {
    assert.equal(account, before.vault.selectedPubkey); assert.equal(method, 'nip46');
    mutations++; saved = { ...saved, revision: saved.revision + 1 }; return saved;
  };
  const pending = transition.prepareSigningMethod('nip46');
  assert.equal(transition.getSnapshot().session, before); assert.equal(mutations, 0);
  await transition.confirm(pending);
  const after = transition.getSnapshot().session;
  assert.equal(mutations, 1); assert.equal(after.vault.identities.length, 1);
  assert.equal(after.vault.selectedPubkey, before.vault.selectedPubkey); assert.equal(after.epoch, before.epoch + 1);
  assert.throws(oldAuthority.assertActive, { code: 'STALE' });
  await assert.rejects(oldData.port.get('draft'), { code: 'REVOKED' });
  const current = transition.sessionAuthority();
  assert.equal(await database.bindStorage(registration({ user: current.user, assertActive: current.assertActive })).port.get('draft'), 'same account data');
});

test('cancelled method choice preserves mounted sessions and never calls a native mutation', async t => {
  const { transition, ports } = await start(t); const before = transition.getSnapshot().session;
  let mutations = 0;
  ports.vault.selectSigningMethod = async () => { mutations++; throw new Error('must not dispatch'); };
  const pending = transition.prepareSigningMethod('nip46'); transition.cancel(pending);
  assert.equal(transition.getSnapshot().session, before); assert.equal(mutations, 0);
  await assert.rejects(transition.confirm(pending), { code: 'STALE' });
  transition.sessionAuthority().assertActive();
});

test('failed workspace flush stops method selection before native review or mutation', async t => {
  const { transition, ports, sqlite } = await start(t); let mutations = 0;
  ports.vault.selectSigningMethod = async () => { mutations++; throw new Error('must not dispatch'); };
  transition.getSnapshot().session.workspace.change(emptyWorkspace());
  sqlite.faults.push({ prefix: 'UPDATE workspaces', mode: 'before' });
  await assert.rejects(transition.confirm(transition.prepareSigningMethod('nip46')), { code: 'RECOVERY_REQUIRED' });
  assert.equal(mutations, 0); assert.equal(transition.getSnapshot().phase, 'recovery');
});

test('remote connection to the selected key still commits and restarts the same account', async t => {
  const { transition, ports } = await start(t); const before = transition.getSnapshot().session;
  const candidate = { handle: 'remote_connection_00001', pubkey: before.vault.selectedPubkey };
  let saved = before.vault, commits = 0;
  ports.vault.getSnapshot = () => saved;
  ports.vault.prepareRemoteConnection = async () => candidate;
  ports.vault.commitRemoteConnection = async value => {
    assert.equal(value, candidate); commits++; saved = { ...saved, revision: saved.revision + 1 }; return saved;
  };
  const pending = await transition.prepareRemoteConnection(); assert(pending);
  assert.equal(pending.kind, 'connect'); assert.equal(pending.pubkey, before.vault.selectedPubkey);
  await transition.confirm(pending);
  assert.equal(commits, 1); assert.equal(transition.getSnapshot().session.vault.identities.length, 1);
  assert.equal(transition.getSnapshot().session.epoch, before.epoch + 1);
});

test('late remote preparation after cancellation is retired without affecting the account', async t => {
  const { transition, ports } = await start(t); const before = transition.getSnapshot().session;
  const candidate = { handle: 'remote_connection_00001', pubkey: before.vault.selectedPubkey };
  let deliver!: (value: typeof candidate) => void;
  const retired: object[] = [];
  ports.vault.prepareRemoteConnection = async () => new Promise(resolve => { deliver = resolve; });
  ports.vault.cancelRemoteConnection = value => { retired.push(value); };
  const preparing = transition.prepareRemoteConnection(); transition.cancelRemotePreparation(); deliver(candidate);
  assert.equal(await preparing, null); assert.deepEqual(retired, [candidate]);
  assert.equal(transition.getSnapshot().session, before);
});

test('disconnect never selects another method and preserves the account even when none remain', async t => {
  const { transition, ports, database } = await start(t); const before = transition.getSnapshot().session;
  let saved = before.vault, disconnected = 0, selected = 0;
  ports.vault.getSnapshot = () => saved;
  ports.vault.disconnectSigningMethod = async (_account, method) => {
    assert.equal(method, 'nip46'); disconnected++; saved = { ...saved, revision: saved.revision + 1 }; return saved;
  };
  ports.vault.selectSigningMethod = async () => { selected++; throw new Error('no fallback'); };
  ports.vault.getSigningMethods = async account => ({ vaultId: saved.vaultId, revision: saved.revision,
    pubkey: account, selectedMethod: null, methods: [] });
  const authority = transition.sessionAuthority();
  await database.bindStorage(registration({ user: authority.user, assertActive: authority.assertActive })).port.set('draft', 'retained');
  await transition.confirm(transition.prepareDisconnect());
  assert.equal(disconnected, 1); assert.equal(selected, 0); assert.equal((await transition.getSigningMethods()).selectedMethod, null);
  assert.equal(transition.getSnapshot().session.vault.selectedPubkey, before.vault.selectedPubkey);
  const current = transition.sessionAuthority();
  assert.equal(await database.bindStorage(registration({ user: current.user, assertActive: current.assertActive })).port.get('draft'), 'retained');
});

test('same-account disconnect rolls back a suspended old-authority write and retains prior data', { timeout: 5000 }, async t => {
  const { transition, ports, database, sqlite } = await start(t);
  const before = transition.getSnapshot().session, authority = transition.sessionAuthority();
  const oldData = database.bindStorage(registration({ user: authority.user, assertActive: authority.assertActive }));
  await oldData.port.set('marker', 'committed before disconnect');
  let saved = before.vault, disconnected = 0, selected = 0;
  ports.vault.getSnapshot = () => saved;
  ports.vault.disconnectSigningMethod = async (account, method) => {
    assert.equal(account, before.vault.selectedPubkey); assert.equal(method, 'nip46');
    disconnected++; saved = { ...saved, revision: saved.revision + 1 }; return saved;
  };
  ports.vault.selectSigningMethod = async () => { selected++; throw new Error('no fallback'); };
  ports.vault.getSigningMethods = async account => ({ vaultId: saved.vaultId, revision: saved.revision,
    pubkey: account, selectedMethod: disconnected ? null : 'nip46',
    methods: disconnected ? [] : [{ kind: 'nip46', peerPubkey: pubkey(3), relays: ['wss://nos.lol'] }] });
  assert.equal((await transition.getSigningMethods()).selectedMethod, 'nip46');
  const entered = deferred(), release = deferred(), sqlStart = sqlite.calls.length;
  let held = false;
  sqlite.onStep = async sql => {
    if (!held && sql.startsWith('INSERT INTO saved_strings')) { held = true; entered.resolve(); await release.promise; }
  };
  const rejectedWrite = assert.rejects(oldData.port.set('tentative', 'must roll back'), { code: 'REVOKED' });
  await entered.promise;
  const changing = transition.confirm(transition.prepareDisconnect());
  try {
    assert.equal(transition.getSnapshot().phase, 'switching');
    assert.throws(authority.assertActive, { code: 'STALE' });
    await assert.rejects(oldData.port.get('marker'), { code: 'REVOKED' });
  } finally { release.resolve(); await Promise.all([rejectedWrite, changing]); }
  sqlite.onStep = undefined;
  const sql = sqlite.calls.slice(sqlStart).map(call => call.sql);
  const insert = sql.findIndex(statement => statement.startsWith('INSERT INTO saved_strings'));
  const rollback = sql.indexOf('ROLLBACK');
  assert(insert >= 0 && rollback > insert);
  assert(!sql.slice(insert + 1, rollback).includes('COMMIT'));
  const after = transition.getSnapshot().session, current = transition.sessionAuthority();
  assert.equal(transition.getSnapshot().phase, 'ready');
  assert.equal(after.vault.selectedPubkey, before.vault.selectedPubkey);
  assert.deepEqual(after.vault.identities, before.vault.identities);
  assert.equal(after.epoch, before.epoch + 1);
  assert.equal(disconnected, 1); assert.equal(selected, 0);
  const methods = await transition.getSigningMethods();
  assert.equal(methods.selectedMethod, null); assert.deepEqual(methods.methods, []);
  assert.throws(authority.assertActive, { code: 'STALE' });
  await assert.rejects(oldData.port.get('marker'), { code: 'REVOKED' });
  const currentData = database.bindStorage(registration({ user: current.user, assertActive: current.assertActive })).port;
  assert.equal(await currentData.get('marker'), 'committed before disconnect');
  assert.equal(await currentData.get('tentative'), null);
});

test('post-write method uncertainty cannot resume the prior workspace', async t => {
  const { transition, ports } = await start(t); const authority = transition.sessionAuthority();
  ports.vault.selectSigningMethod = async () => { throw new VaultError('READBACK_FAILED'); };
  await assert.rejects(transition.confirm(transition.prepareSigningMethod('nip46')), { code: 'READBACK_FAILED' });
  assert.equal(transition.getSnapshot().phase, 'recovery'); assert.throws(authority.assertActive, { code: 'STALE' });
});


test('cancellation while flushing a method change cannot open a later native review', async t => {
  const { transition, ports, sqlite } = await start(t); const before = transition.getSnapshot().session;
  let calls = 0, cancellations = 0;
  ports.vault.selectSigningMethod = async () => { calls++; throw new Error('must not dispatch'); };
  ports.vault.cancelAction = () => { cancellations++; };
  const gate = deferred(), entered = deferred();
  sqlite.onStep = async sql => { if (sql.startsWith('UPDATE workspaces')) { entered.resolve(); await gate.promise; } };
  before.workspace.change(emptyWorkspace());
  const changing = transition.confirm(transition.prepareSigningMethod('nip46'));
  await entered.promise; transition.cancelChange(); gate.resolve();
  await assert.rejects(changing, { code: 'AUTHORIZATION_DENIED' });
  assert.equal(calls, 0); assert.equal(cancellations, 1); assert.equal(transition.getSnapshot().session, before);
  transition.sessionAuthority().assertActive();
});

test('a cancelled method change with a late durable acknowledgement requires recovery', async t => {
  const { transition, ports } = await start(t); const before = transition.getSnapshot().session;
  let saved = before.vault, finish!: (value: typeof saved) => void;
  const entered = deferred();
  ports.vault.getSnapshot = () => saved;
  ports.vault.selectSigningMethod = async () => new Promise(resolve => { finish = resolve; entered.resolve(); });
  const changing = transition.confirm(transition.prepareSigningMethod('nip46'));
  await entered.promise; transition.cancelChange(); saved = { ...saved, revision: saved.revision + 1 }; finish(saved);
  await assert.rejects(changing, { code: 'READBACK_FAILED' });
  assert.equal(transition.getSnapshot().phase, 'recovery'); assert.equal(before.workspace.getSnapshot().error, 'REVOKED');
});


for (const stage of ['load', 'save'] as const) {
  test(`cancellation during destination workspace ${stage} cannot publish fresh authority`, async t => {
    const { transition, ports, database, sqlite, native } = await start(t);
    const previous = transition.getSnapshot().session;
    const authority = transition.sessionAuthority();
    await database.bindWorkspace({ user: pubkey(2), assertActive() {} }).port.save(snapshotWorkspace(emptyWorkspace()), null);
    const bindings: ReturnType<typeof database.bindWorkspace>[] = [];
    ports.database = { ...database, bindWorkspace(owner) {
      const binding = database.bindWorkspace(owner); bindings.push(binding); return binding;
    } };
    const gate = deferred(), entered = deferred();
    const prefix = stage === 'load' ? 'SELECT revision, payload FROM workspaces' : 'UPDATE workspaces';
    sqlite.onStep = async sql => { if (sql.startsWith(prefix)) { entered.resolve(); await gate.promise; } };
    const changing = transition.confirm(await request(transition));
    await entered.promise;
    assert.equal(native.vault.getSnapshot().selectedPubkey, pubkey(2));
    transition.cancelChange(); gate.resolve();
    await assert.rejects(changing, { code: 'READBACK_FAILED' });
    assert.equal(transition.getSnapshot().phase, 'recovery');
    assert.equal(transition.getSnapshot().session, previous);
    assert.equal(previous.workspace.getSnapshot().error, 'REVOKED');
    assert.throws(authority.assertActive, { code: 'STALE' });
    assert.throws(transition.sessionAuthority().assertActive, { code: 'STALE' });
    assert.equal(bindings.length, 1);
    await assert.rejects(bindings[0]!.port.load(), { code: 'REVOKED' });
    const reopened = await IdentityTransition.open(ports);
    assert.equal(reopened.getSnapshot().session.vault.selectedPubkey, pubkey(2));
    reopened.sessionAuthority().assertActive();
  });
}

for (const kind of ['import', 'connect'] as const) {
  for (const cancelled of [false, true]) {
    test(`fatal ${kind} preparation failure requires recovery${cancelled ? ' after cancellation' : ''}`, async t => {
      const { transition, ports } = await start(t);
      const previous = transition.getSnapshot().session, authority = transition.sessionAuthority();
      const gate = deferred(), entered = deferred();
      const prepare = async () => {
        entered.resolve(); await gate.promise;
        ports.vault.getSnapshot = () => { throw new VaultError('NOT_READY'); };
        throw new VaultError('STORAGE_FAILURE');
      };
      ports.vault.prepareImport = prepare;
      ports.vault.prepareRemoteConnection = prepare;
      const preparing = kind === 'import' ? transition.prepareImport() : transition.prepareRemoteConnection();
      await entered.promise;
      if (cancelled) {
        if (kind === 'import') transition.cancelImportPreparation(); else transition.cancelRemotePreparation();
      }
      gate.resolve();
      await assert.rejects(preparing, { code: 'STORAGE_FAILURE' });
      assert.equal(transition.getSnapshot().phase, 'recovery');
      assert.equal(transition.getSnapshot().session, previous);
      assert.equal(previous.workspace.getSnapshot().error, 'REVOKED');
      assert.throws(authority.assertActive, { code: 'STALE' });
    });
  }
}

test('fatal metadata read during duplicate import retires the candidate and revokes the session', async t => {
  const { transition, ports } = await start(t);
  const previous = transition.getSnapshot().session;
  const candidate = { handle: 'native_known_candidate', pubkey: previous.vault.selectedPubkey };
  let retired = 0;
  ports.vault.prepareImport = async () => candidate;
  ports.vault.getSigningMethods = async () => {
    ports.vault.getSnapshot = () => { throw new VaultError('NOT_READY'); };
    throw new VaultError('STORAGE_FAILURE');
  };
  ports.vault.cancelImport = value => { assert.equal(value, candidate); retired++; };
  await assert.rejects(transition.prepareImport(), { code: 'STORAGE_FAILURE' });
  assert.equal(retired, 1); assert.equal(transition.getSnapshot().phase, 'recovery');
  assert.equal(previous.workspace.getSnapshot().error, 'REVOKED');
});

test('late rejected preparation preserves a newer healthy confirmation', async t => {
  const { transition, ports } = await start(t);
  const gate = deferred(), entered = deferred();
  ports.vault.prepareRemoteConnection = async () => { entered.resolve(); await gate.promise; throw new VaultError('SIGNER_REJECTED'); };
  const preparing = transition.prepareRemoteConnection();
  await entered.promise; transition.cancelRemotePreparation();
  const pending = transition.prepareSigningMethod('nip46');
  gate.resolve(); await assert.rejects(preparing, { code: 'SIGNER_REJECTED' });
  assert.equal(transition.getSnapshot().phase, 'confirming');
  assert.equal(transition.getSnapshot().pending, pending);
  transition.sessionAuthority().assertActive();
  transition.cancel(pending);
});

test('a late preparation failure cannot replace a newer accepted account session', async t => {
  const { transition, ports } = await start(t);
  const gate = deferred(), entered = deferred();
  ports.vault.prepareRemoteConnection = async () => { entered.resolve(); await gate.promise; throw new VaultError('STORAGE_FAILURE'); };
  const preparing = transition.prepareRemoteConnection();
  await entered.promise; transition.cancelRemotePreparation();
  await transition.confirm(await request(transition));
  const accepted = transition.getSnapshot().session;
  gate.resolve(); await assert.rejects(preparing, { code: 'STORAGE_FAILURE' });
  assert.equal(transition.getSnapshot().phase, 'ready');
  assert.equal(transition.getSnapshot().session, accepted);
  transition.sessionAuthority().assertActive();
});

test('a different vault identifier is never treated as an unchanged account', async t => {
  const { transition, ports } = await start(t);
  const previous = transition.getSnapshot().session;
  ports.vault.prepareRemoteConnection = async () => {
    ports.vault.getSnapshot = () => ({ ...previous.vault, vaultId: 'replacement_vault_identifier' });
    throw new VaultError('SIGNER_REJECTED');
  };
  await assert.rejects(transition.prepareRemoteConnection(), { code: 'SIGNER_REJECTED' });
  assert.equal(transition.getSnapshot().phase, 'recovery');
  assert.equal(previous.workspace.getSnapshot().error, 'REVOKED');
});

test('native cancellation cleanup failure cannot revive a pending change', async t => {
  const { transition, ports, sqlite } = await start(t);
  const previous = transition.getSnapshot().session;
  const gate = deferred(), entered = deferred();
  let dispatched = false;
  ports.vault.selectSigningMethod = async () => { dispatched = true; throw new Error('must not dispatch'); };
  ports.vault.cancelAction = () => { throw new Error('native bridge unavailable'); };
  sqlite.onStep = async sql => { if (sql.startsWith('UPDATE workspaces')) { entered.resolve(); await gate.promise; } };
  previous.workspace.change(emptyWorkspace());
  const changing = transition.confirm(transition.prepareSigningMethod('nip46'));
  await entered.promise;
  try { assert.doesNotThrow(() => transition.cancelChange()); } finally { gate.resolve(); }
  await assert.rejects(changing, { code: 'AUTHORIZATION_DENIED' });
  assert.equal(dispatched, false);
  assert.equal(transition.getSnapshot().phase, 'ready');
  transition.sessionAuthority().assertActive();
});


test('explicit relay refresh flushes first and restarts the same account with its saved data', async t => {
  const { transition, ports, sqlite } = await start(t);
  const before = transition.getSnapshot().session;
  const candidate = { handle: 'native_refresh_candidate_01', pubkey: before.vault.selectedPubkey };
  let saved = before.vault, commits = 0;
  const gate = deferred(), entered = deferred();
  sqlite.onStep = async sql => { if (sql.startsWith('UPDATE workspaces')) { entered.resolve(); await gate.promise; } };
  ports.vault.prepareRemoteRefresh = async account => { assert.equal(account, candidate.pubkey); return candidate; };
  ports.vault.getSnapshot = () => saved;
  ports.vault.commitRemoteRefresh = async value => {
    assert.equal(value, candidate);
    commits++; saved = { ...saved, revision: saved.revision + 1 }; return saved;
  };
  before.workspace.change(emptyWorkspace());
  const pending = await transition.prepareRemoteRefresh(); assert(pending);
  assert.equal(pending.kind, 'refresh-remote'); assert.equal(commits, 0);
  const changing = transition.confirm(pending); await entered.promise; assert.equal(commits, 0);
  gate.resolve(); await changing;
  const after = transition.getSnapshot().session;
  assert.equal(commits, 1); assert.equal(after.vault.selectedPubkey, before.vault.selectedPubkey);
  assert.deepEqual(after.vault.identities, before.vault.identities);
  assert.equal(after.workspace.getSnapshot().workspace.sessions.length, 0);
  assert.equal(after.epoch, before.epoch + 1); assert.equal(before.workspace.getSnapshot().error, 'REVOKED');
});

test('late relay refresh cancellation destroys only the refresh candidate', async t => {
  const { transition, ports } = await start(t);
  const before = transition.getSnapshot().session, gate = deferred();
  const candidate = { handle: 'native_refresh_candidate_01', pubkey: before.vault.selectedPubkey };
  let retired = 0, committed = 0;
  ports.vault.prepareRemoteRefresh = async () => { await gate.promise; return candidate; };
  ports.vault.cancelRemoteRefresh = value => { assert.equal(value, candidate); retired++; };
  ports.vault.cancelRemoteConnection = () => { throw new Error('Wrong candidate purpose'); };
  ports.vault.commitRemoteRefresh = async () => { committed++; throw new Error('Cancelled'); };
  const preparing = transition.prepareRemoteRefresh(); transition.cancelRemotePreparation(); gate.resolve();
  assert.equal(await preparing, null); assert.equal(retired, 1); assert.equal(committed, 0);
  assert.equal(transition.getSnapshot().session, before);
});

test('declining relay refresh confirmation cancels its exact candidate without a durable change', async t => {
  const { transition, ports } = await start(t), before = transition.getSnapshot().session;
  const candidate = { handle: 'native_refresh_candidate_01', pubkey: before.vault.selectedPubkey };
  let retired = 0;
  ports.vault.prepareRemoteRefresh = async () => candidate;
  ports.vault.cancelRemoteRefresh = value => { assert.equal(value, candidate); retired++; };
  ports.vault.cancelRemoteConnection = () => { throw new Error('Wrong candidate purpose'); };
  const pending = await transition.prepareRemoteRefresh(); assert(pending); transition.cancel(pending);
  await assert.rejects(transition.confirm(pending), { code: 'STALE' });
  assert.equal(retired, 1); assert.equal(transition.getSnapshot().session, before);
});


test('background preserves only a native-confirmed preparation while explicit cancel still retires it', async t => {
  const { transition, ports } = await start(t), before = transition.getSnapshot().session, gate = deferred();
  const candidate = { handle: 'native_refresh_candidate_01', pubkey: before.vault.selectedPubkey };
  let cancelled = 0, retired = 0;
  ports.vault.prepareRemoteRefresh = async () => { await gate.promise; return candidate; };
  ports.vault.isRemotePreparationHandoffPending = () => true;
  ports.vault.cancelRemotePreparation = () => { cancelled++; };
  ports.vault.cancelRemoteRefresh = () => { retired++; };
  const preparing = transition.prepareRemoteRefresh(); transition.backgroundRemotePreparation();
  assert.equal(cancelled, 0); transition.cancelRemotePreparation(); assert.equal(cancelled, 1);
  gate.resolve(); assert.equal(await preparing, null); assert.equal(retired, 1);
  assert.equal(transition.getSnapshot().session, before);
});
