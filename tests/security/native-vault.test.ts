import assert from 'node:assert/strict';
import test from 'node:test';
import { secret, pubkey, second, first, candidate, harness, event, authority } from './native-vault-harness.ts';
import { finalizeEvent } from 'nostr-tools/pure';
import { captureNativeVaultSnapshot } from '../../src/security/native-identity-vault.ts';
import { createNativeIdentityActions } from '../../src/security/native-identity-actions.ts';
import { captureSigningMethods } from '../../src/security/signing-methods.ts';
import { IdentityTransition } from '../../src/security/identity-transition.ts';
import { backgroundIdentitySettings } from '../../src/shell/identity-settings-lifecycle.ts';
import { initialTestWorkspace, assertBundledWorkspace } from '../../src/shell/fixtures.ts';
import { setup } from '../storage/harness.ts';
import { VaultError } from '../../src/security/identity-vault-model.ts';

test('native vault accepts and freezes public snapshots without secret fields', async () => {
  const { vault } = harness(); const snapshot = await vault.open();
  assert.deepEqual(snapshot, first);
  assert.ok(Object.isFrozen(snapshot)); assert.ok(Object.isFrozen(snapshot.identities[0]));
});

test('public snapshot rejects secrets, duplicate keys, missing selection and invalid revision', () => {
  for (const value of [{ ...first, secretKey: 'forbidden' }, { ...first, revision: 0 }, { ...first, selectedPubkey: second },
    { ...first, identities: [...first.identities, ...first.identities] },
    { ...first, identities: [{ ...first.identities[0], nsec: 'forbidden' }] }, { ...first, pendingDeletion: pubkey }]) {
    assert.throws(() => captureNativeVaultSnapshot(JSON.stringify(value)), { code: 'CORRUPT_METADATA' });
  }
});

test('failed native activation never opens or creates a vault', async () => {
  const { vault, module } = harness(); let opens = 0;
  module.activateNativeVault = () => false;
  module.openNativeVaultAsync = async () => { opens++; return JSON.stringify(first); };
  await assert.rejects(vault.open(), { code: 'AUTHORIZATION_DENIED' }); assert.equal(opens, 0);
  assert.throws(() => vault.getSnapshot(), { code: 'NOT_READY' });
});

test('storage and corruption failures leave no cached identity or fallback', async () => {
  const { vault, module } = harness(); await vault.open(); let calls = 0;
  module.openNativeVaultAsync = async () => { calls++; throw { code: 'RECOVERY_REQUIRED', message: 'never echo native data' }; };
  await assert.rejects(vault.open(), error => error instanceof VaultError && error.message === 'RECOVERY_REQUIRED');
  assert.equal(calls, 1); assert.throws(() => vault.getSnapshot(), { code: 'NOT_READY' });
});

test('native import prepares a public candidate and commits only its original handle object', async () => {
  const { vault, calls } = harness(); await vault.open(); const pending = await vault.prepareImport(); assert(pending);
  assert.deepEqual(pending, candidate); assert.equal(vault.getSnapshot().selectedPubkey, pubkey);
  await assert.rejects(vault.commitImport({ ...pending }), { code: 'AUTHORIZATION_DENIED' });
  assert.equal(calls.includes('commit'), false);
  const selected = await vault.commitImport(pending); assert.equal(selected.selectedPubkey, second);
  await assert.rejects(vault.commitImport(pending), { code: 'AUTHORIZATION_DENIED' });
  assert.equal(calls.filter(item => item === 'commit').length, 1);
});

test('cancelled import handle cannot commit and native cancellation runs once', async () => {
  const { vault, calls } = harness(); await vault.open(); const pending = await vault.prepareImport(); assert(pending);
  vault.cancelImport(pending); vault.cancelImport(pending);
  await assert.rejects(vault.commitImport(pending), { code: 'AUTHORIZATION_DENIED' });
  assert.deepEqual(calls, [`cancel:${candidate.handle}`]);
});

test('native import cancellation returns no candidate and leaves the account unchanged', async () => {
  const { vault, module } = harness(); await vault.open(); module.prepareNativeImportAsync = async () => null;
  assert.equal(await vault.prepareImport(), null); assert.deepEqual(vault.getSnapshot(), first);
});

test('unexpected durable mutation cannot continue with a stale public snapshot', async () => {
  const { vault, module } = harness(); await vault.open(); const pending = await vault.prepareImport(); assert(pending);
  module.commitNativeImportAsync = async () => JSON.stringify({ ...first, revision: 2 });
  await assert.rejects(vault.commitImport(pending), { code: 'CORRUPT_METADATA' });
  assert.throws(() => vault.getSnapshot(), { code: 'NOT_READY' });
});

test('uncertain import acknowledgement requires recovery instead of retrying', async () => {
  const { vault, module } = harness(); await vault.open(); const pending = await vault.prepareImport(); assert(pending);
  module.commitNativeImportAsync = async () => { throw { code: 'READBACK_FAILED' }; };
  await assert.rejects(vault.commitImport(pending), { code: 'READBACK_FAILED' });
  assert.throws(() => vault.getSnapshot(), { code: 'NOT_READY' });
});

test('native signing receives only exact public event and native source correlation', async () => {
  const { vault, calls } = harness(); await vault.open(); const execution = authority();
  const signed = await vault.signApproved(event, execution);
  assert.equal(signed.id, event.hash); assert.equal(signed.pubkey, pubkey);
  await assert.rejects(vault.signApproved(event, execution), { code: 'AUTHORIZATION_DENIED' });
  assert.equal(calls.filter(item => item.startsWith('sign:')).length, 1);
});

test('ordinary signing rejects missing source, upload source and reserved auth kinds', async () => {
  const { vault, calls } = harness(); await vault.open();
  await assert.rejects(vault.signApproved(event, { signal: new AbortController().signal, assertActive() {} }), { code: 'AUTHORIZATION_DENIED' });
  await assert.rejects(vault.signApproved(event, { ...authority(), nativeSource: { kind: 'upload', token: 'wrong-lane' } }), { code: 'AUTHORIZATION_DENIED' });
  for (const kind of [22242, 24242]) await assert.rejects(vault.signApproved({ ...event, event: { ...event.event, kind } }, authority()), { code: 'AUTHORIZATION_DENIED' });
  assert.equal(calls.length, 0);
});

test('mutated native signing result is independently rejected', async () => {
  const { vault, module } = harness(); await vault.open();
  module.reviewAndSignNativeEventAsync = async (_kind, _token, wire) => JSON.stringify(finalizeEvent({ ...JSON.parse(wire), content: 'substituted' }, secret));
  await assert.rejects(vault.signApproved(event, authority()));
});

test('abort cancels the exact native signing request and denies late completion', async () => {
  const { vault, module, calls } = harness(); await vault.open();
  let resolve!: (value: string) => void;
  module.reviewAndSignNativeEventAsync = async () => new Promise<string>(done => { resolve = done; });
  const controller = new AbortController(); const result = vault.signApproved(event, authority(controller));
  controller.abort(); resolve(JSON.stringify(finalizeEvent({ ...event.event, tags: event.event.tags.map(row => [...row]) }, secret)));
  await assert.rejects(result, { code: 'AUTHORIZATION_DENIED' });
  assert.deepEqual(calls, ['cancel-sign:approval:native_source_token_0001']);
});

test('selection during signing rejects the old response', async () => {
  const { vault, module } = harness(); await vault.open();
  let resolve!: (value: string) => void;
  module.reviewAndSignNativeEventAsync = async () => new Promise<string>(done => { resolve = done; });
  const result = vault.signApproved(event, authority());
  const pending = await vault.prepareImport(); assert(pending); await vault.commitImport(pending);
  resolve(JSON.stringify(finalizeEvent({ ...event.event, tags: event.event.tags.map(row => [...row]) }, secret)));
  await assert.rejects(result, { code: 'AUTHORIZATION_DENIED' });
});

test('backup presentation cannot choose a stale or different selected identity', async () => {
  const { vault, calls } = harness(); await vault.open(); const actions = createNativeIdentityActions(vault);
  await actions.beginSettings({ selectedPubkey: pubkey, revision: 1 });
  await assert.rejects(actions.showBackup({ pubkey: second, selectedPubkey: pubkey, revision: 1 }), { code: 'AUTHORIZATION_DENIED' });
  await actions.showBackup({ pubkey, selectedPubkey: pubkey, revision: 1 });
  actions.endSettings();
  await assert.rejects(actions.showBackup({ pubkey, selectedPubkey: pubkey, revision: 1 }), { code: 'AUTHORIZATION_DENIED' });
  assert.equal(calls.filter(item => item === 'backup').length, 1);
});


test('cancellation retains the original native source even if its input object is mutated', async () => {
  const { vault, module, calls } = harness(); await vault.open();
  let resolve!: (value: string) => void;
  module.reviewAndSignNativeEventAsync = async () => new Promise<string>(done => { resolve = done; });
  const controller = new AbortController();
  const source = { kind: 'approval' as const, token: 'original-native-source' };
  const result = vault.signApproved(event, { ...authority(controller), nativeSource: source });
  source.token = 'substituted-native-source'; controller.abort();
  resolve(JSON.stringify(finalizeEvent({ ...event.event, tags: event.event.tags.map(row => [...row]) }, secret)));
  await assert.rejects(result, { code: 'AUTHORIZATION_DENIED' });
  assert.deepEqual(calls, ['cancel-sign:approval:original-native-source']);
});


test('public signing metadata accepts zero or explicit methods and rejects mismatched authority or secret fields', () => {
  const local = { vaultId: first.vaultId, revision: first.revision, pubkey, selectedMethod: 'local', methods: [{ kind: 'local' }] };
  const remote = { kind: 'nip46', peerPubkey: second, relays: ['wss://relay.damus.io'] };
  const linked = captureSigningMethods(JSON.stringify({ ...local, selectedMethod: 'nip46', methods: [...local.methods, remote] }), first, pubkey);
  assert.equal(linked.selectedMethod, 'nip46'); assert.equal(linked.methods.length, 2);
  assert(Object.isFrozen(linked)); assert(Object.isFrozen(linked.methods[1]));
  assert.deepEqual(captureSigningMethods(JSON.stringify({ ...local, selectedMethod: null, methods: [] }), first, pubkey).methods, []);
  for (const value of [
    { ...local, revision: 2 }, { ...local, vaultId: 'another_vault_000001' }, { ...local, pubkey: second },
    { ...local, selectedMethod: 'nip46' }, { ...local, secret: 'must not cross' },
    { ...local, methods: [...local.methods, ...local.methods] },
    { ...local, methods: [{ kind: 'local', scalar: 'must not cross' }] },
    { ...local, selectedMethod: 'nip46', methods: [{ ...remote, peerPubkey: 'g'.repeat(64) }] },
    { ...local, selectedMethod: 'nip46', methods: [{ ...remote, relays: ['ws://relay.damus.io'] }] },
    { ...local, selectedMethod: 'nip46', methods: [{ ...remote, relays: ['wss://localhost'] }] },
    { ...local, selectedMethod: 'nip46', methods: [{ ...remote, relays: ['wss://relay.damus.io/'] }] },
    { ...local, selectedMethod: 'nip46', methods: [{ ...remote, relays: ['wss://relay.damus.io', 'wss://relay.damus.io'] }] },
    { ...local, selectedMethod: 'nip46', methods: [remote, ...local.methods] },
  ]) assert.throws(() => captureSigningMethods(JSON.stringify(value), first, pubkey), { code: 'CORRUPT_METADATA' });
});

test('remote candidate links one existing account with its original one-use handle', async () => {
  const { vault, module, calls } = harness(); await vault.open();
  module.prepareNativeRemoteConnectionAsync = async () => JSON.stringify({ ...candidate, pubkey });
  module.commitNativeRemoteConnectionAsync = async (handle, vaultId, revision) => {
    assert.equal(handle, candidate.handle); assert.equal(vaultId, first.vaultId); assert.equal(revision, 1);
    calls.push('connect'); return JSON.stringify({ ...first, revision: 2 });
  };
  const pending = await vault.prepareRemoteConnection(); assert(pending);
  await assert.rejects(vault.commitRemoteConnection({ ...pending }), { code: 'AUTHORIZATION_DENIED' });
  assert.equal(calls.includes('connect'), false);
  await assert.rejects(vault.commitImport(pending), { code: 'AUTHORIZATION_DENIED' });
  const linked = await vault.commitRemoteConnection(pending);
  assert.equal(linked.identities.length, 1); assert.equal(linked.selectedPubkey, pubkey);
  await assert.rejects(vault.commitRemoteConnection(pending), { code: 'AUTHORIZATION_DENIED' });
  assert.equal(calls.filter(call => call === 'connect').length, 1);
});

test('remote cancellation destroys only its issued candidate and refuses a late commit', async () => {
  const { vault, calls } = harness(); await vault.open();
  const pending = await vault.prepareRemoteConnection(); assert(pending);
  vault.cancelRemoteConnection({ ...pending }); assert.equal(calls.length, 0);
  vault.cancelRemoteConnection(pending); vault.cancelRemoteConnection(pending);
  await assert.rejects(vault.commitRemoteConnection(pending), { code: 'AUTHORIZATION_DENIED' });
  assert.deepEqual(calls, [`cancel-remote:${candidate.handle}`]);
});

test('remote preparation cannot expose a connection URI or client secret through its result', async () => {
  const { vault, module } = harness(); await vault.open();
  module.prepareNativeRemoteConnectionAsync = async () => JSON.stringify({ ...candidate, bunker: 'forbidden' });
  await assert.rejects(vault.prepareRemoteConnection(), { code: 'CORRUPT_METADATA' });
  assert.throws(() => vault.getSnapshot(), { code: 'NOT_READY' });
});

test('remote linking must preserve every existing account and advance the durable revision', async () => {
  for (const changed of [first, { ...first, revision: 2, identities: [{ ...first.identities[0], addedAt: 99 }] }]) {
    const { vault, module } = harness(); await vault.open();
    module.prepareNativeRemoteConnectionAsync = async () => JSON.stringify({ ...candidate, pubkey });
    module.commitNativeRemoteConnectionAsync = async () => JSON.stringify(changed);
    const pending = await vault.prepareRemoteConnection(); assert(pending);
    await assert.rejects(vault.commitRemoteConnection(pending), { code: 'CORRUPT_METADATA' });
    assert.throws(() => vault.getSnapshot(), { code: 'NOT_READY' });
  }
});

test('method mutations cannot change account identity and post-write uncertainty closes the cache', async () => {
  const { vault, module } = harness(); await vault.open();
  module.selectNativeSigningMethodAsync = async () => JSON.stringify({ ...first, revision: 2 });
  await assert.rejects(vault.selectSigningMethod(second, 'nip46'), { code: 'AUTHORIZATION_DENIED' });
  const selected = await vault.selectSigningMethod(pubkey, 'nip46');
  assert.equal(selected.selectedPubkey, pubkey); assert.equal(selected.revision, 2);
  module.disconnectNativeSigningMethodAsync = async () => { throw { code: 'READBACK_FAILED' }; };
  await assert.rejects(vault.disconnectSigningMethod(pubkey, 'nip46'), { code: 'READBACK_FAILED' });
  assert.throws(() => vault.getSnapshot(), { code: 'NOT_READY' });
});

test('same-account method change rejects a signature from the previous vault revision', async () => {
  const { vault, module } = harness(); await vault.open();
  let resolve!: (value: string) => void;
  module.reviewAndSignNativeEventAsync = async () => new Promise<string>(done => { resolve = done; });
  const result = vault.signApproved(event, authority());
  module.selectNativeSigningMethodAsync = async () => JSON.stringify({ ...first, revision: 2 });
  await vault.selectSigningMethod(pubkey, 'nip46');
  resolve(JSON.stringify(finalizeEvent({ ...event.event, tags: event.event.tags.map(row => [...row]) }, secret)));
  await assert.rejects(result, { code: 'AUTHORIZATION_DENIED' });
});

test('an uncertain remote signature never falls back or reuses its approval', async () => {
  const { vault, module } = harness(); const before = await vault.open(); let sent = 0;
  module.reviewAndSignNativeEventAsync = async () => { sent++; throw { code: 'SIGNER_UNCERTAIN', message: 'remote-controlled data' }; };
  const execution = authority();
  await assert.rejects(vault.signApproved(event, execution), error => error instanceof VaultError && error.message === 'SIGNER_UNCERTAIN');
  assert.equal(vault.getSnapshot(), before);
  await assert.rejects(vault.signApproved(event, execution), { code: 'AUTHORIZATION_DENIED' });
  assert.equal(sent, 1);
});


test('relay refresh uses only its issued one-use candidate and preserves account metadata', async () => {
  const { module, vault, calls } = harness(); await vault.open();
  module.prepareNativeRemoteConnectionAsync = async () => JSON.stringify({ ...candidate, pubkey });
  const connection = await vault.prepareRemoteConnection(); assert(connection);
  await assert.rejects(vault.commitRemoteRefresh(connection), { code: 'AUTHORIZATION_DENIED' });
  const refresh = await vault.prepareRemoteRefresh(pubkey); assert(refresh);
  await assert.rejects(vault.commitRemoteConnection(refresh), { code: 'AUTHORIZATION_DENIED' });
  await assert.rejects(vault.commitRemoteRefresh({ ...refresh }), { code: 'AUTHORIZATION_DENIED' });
  module.commitNativeRemoteRefreshAsync = async (handle, vaultId, revision) => {
    assert.equal(handle, refresh.handle); assert.equal(vaultId, first.vaultId); assert.equal(revision, 1);
    calls.push('refresh'); return JSON.stringify({ ...first, revision: 2 });
  };
  const next = await vault.commitRemoteRefresh(refresh);
  assert.deepEqual(next, { ...first, revision: 2 });
  await assert.rejects(vault.commitRemoteRefresh(refresh), { code: 'AUTHORIZATION_DENIED' });
  assert.equal(calls.filter(value => value === 'refresh').length, 1);
});

test('relay refresh cancellation cannot dispatch a commit or cancel a connection candidate', async () => {
  const { vault, calls } = harness(); await vault.open();
  const connection = await vault.prepareRemoteConnection(); assert(connection);
  vault.cancelRemoteRefresh(connection); assert.deepEqual(calls, []);
  const refresh = await vault.prepareRemoteRefresh(pubkey); assert(refresh);
  vault.cancelRemoteRefresh(refresh); vault.cancelRemoteRefresh(refresh);
  await assert.rejects(vault.commitRemoteRefresh(refresh), { code: 'AUTHORIZATION_DENIED' });
  assert.deepEqual(calls, [`cancel-refresh:${refresh.handle}`]);
});

test('relay refresh rejects an unselected or substituted account and private candidate fields', async () => {
  const initial = harness(); await initial.vault.open();
  await assert.rejects(initial.vault.prepareRemoteRefresh(second), { code: 'AUTHORIZATION_DENIED' });
  for (const result of [{ ...candidate }, { handle: 'native_refresh_test_0001', pubkey, clientKey: 'forbidden' }]) {
    const { vault, module } = harness(); await vault.open();
    module.prepareNativeRemoteRefreshAsync = async () => JSON.stringify(result);
    await assert.rejects(vault.prepareRemoteRefresh(pubkey), { code: 'CORRUPT_METADATA' });
    assert.throws(() => vault.getSnapshot(), { code: 'NOT_READY' });
  }
});

test('relay refresh requires exactly one durable revision and unchanged public account inventory', async () => {
  for (const changed of [{ ...first }, { ...first, revision: 3 },
    { ...first, revision: 2, identities: [{ ...first.identities[0], addedAt: 2 }] }]) {
    const { vault, module } = harness(); await vault.open();
    const refresh = await vault.prepareRemoteRefresh(pubkey); assert(refresh);
    module.commitNativeRemoteRefreshAsync = async () => JSON.stringify(changed);
    await assert.rejects(vault.commitRemoteRefresh(refresh), { code: 'CORRUPT_METADATA' });
    assert.throws(() => vault.getSnapshot(), { code: 'NOT_READY' });
  }
});


test('remote preparation retention queries the exact active attempt and retires it on cancel', async () => {
  const { module, vault } = harness(); await vault.open();
  let complete!: (value: string | null) => void, attempt = '', previous = '';
  module.prepareNativeRemoteConnectionAsync = async (vaultId, revision, id) => {
    assert.equal(vaultId, first.vaultId); assert.equal(revision, 1); attempt = id;
    return new Promise(resolve => { complete = resolve; });
  };
  module.nativeRemotePreparationHandoffState = (vaultId, revision, id) => {
    assert.equal(vaultId, first.vaultId); assert.equal(revision, 1); assert.equal(id, attempt); return 'pending';
  };
  for (let count = 0; count < 2; count++) {
    const preparation = vault.prepareRemoteConnection(); assert(attempt); assert.notEqual(attempt, previous); previous = attempt;
    assert.equal(vault.isRemotePreparationHandoffPending(), true);
    vault.cancelRemotePreparation(); assert.equal(vault.isRemotePreparationHandoffPending(), false);
    complete(null); assert.equal(await preparation, null); assert.equal(vault.isRemotePreparationHandoffPending(), false);
  }
});

test('handoff queries fail closed and never expose arbitrary native values', async () => {
  const { module, vault } = harness(); await vault.open();
  const source = { kind: 'approval' as const, token: 'test_source_0001' };
  module.nativeSigningHandoffState = () => { throw new Error('Bridge unavailable'); };
  assert.equal(vault.signingHandoffState(source), null);
  module.nativeSigningHandoffState = () => 'forged' as never;
  assert.equal(vault.signingHandoffState(source), null);
  module.nativeSigningHandoffState = (kind, token) => { assert.equal(kind, source.kind); assert.equal(token, source.token); return 'pending'; };
  assert.equal(vault.signingHandoffState(source), 'pending');
});


test('post-signature foreground wait failure is uncertainty rather than a vault storage failure', async () => {
  const { vault, calls } = harness(); await vault.open();
  const execution = { ...authority(), awaitForeground: async () => { throw new Error('Delayed lifecycle delivery'); } };
  await assert.rejects(vault.signApproved(event, execution), { code: 'SIGNER_UNCERTAIN' });
  assert.equal(vault.getSnapshot().vaultId, first.vaultId);
  assert.equal(calls.filter(call => call.startsWith('sign:')).length, 1);
});


for (const purpose of ['connect', 'refresh'] as const) test(`Settings background and idle backup cleanup preserve exact ${purpose} handoff`, async t => {
  const { vault, module } = harness(); await vault.open(); const actions = createNativeIdentityActions(vault);
  const { database } = await setup(t);
  const transition = await IdentityTransition.open({ vault, database, seed: initialTestWorkspace, assertAvailable: assertBundledWorkspace });
  await actions.beginSettings({ selectedPubkey: pubkey, revision: 1 });
  let status: 'pending' | null = 'pending', cancellations = 0, complete!: (result: string) => void;
  module.nativeRemotePreparationHandoffState = () => status;
  module.prepareNativeRemoteConnectionAsync = async () => new Promise(resolve => { complete = resolve; });
  module.prepareNativeRemoteRefreshAsync = async () => new Promise(resolve => { complete = resolve; });
  module.cancelNativeVaultAction = () => { cancellations++; status = null; };
  const pending = purpose === 'connect' ? transition.prepareRemoteConnection() : transition.prepareRemoteRefresh();
  assert.equal(vault.isRemotePreparationHandoffPending(), true);
  actions.cancelBackup(); backgroundIdentitySettings(transition, actions); actions.cancelBackup();
  assert.equal(cancellations, 0); assert.equal(vault.isRemotePreparationHandoffPending(), true);
  complete(JSON.stringify({ ...candidate, pubkey }));
  assert.equal((await pending)?.kind, purpose === 'connect' ? 'connect' : 'refresh-remote');
  assert.equal(transition.getSnapshot().phase, 'confirming');
});

for (const queryFails of [false, true]) test(`Settings background cancels preparation without native authority: query failure ${queryFails}`, async t => {
  const { vault, module, calls } = harness(); await vault.open(); const actions = createNativeIdentityActions(vault);
  const { database } = await setup(t);
  const transition = await IdentityTransition.open({ vault, database, seed: initialTestWorkspace, assertAvailable: assertBundledWorkspace });
  let complete!: (result: null) => void;
  module.prepareNativeRemoteConnectionAsync = async () => new Promise(resolve => { complete = resolve; });
  module.nativeRemotePreparationHandoffState = () => { if (queryFails) throw new Error('Unavailable'); return null; };
  const pending = transition.prepareRemoteConnection();
  backgroundIdentitySettings(transition, actions); complete(null);
  assert.equal(await pending, null); assert.equal(vault.isRemotePreparationHandoffPending(), false);
  assert.deepEqual(calls, ['cancel-action']); assert.equal(transition.getSnapshot().phase, 'ready');
});

for (const operation of ['cancelBackup', 'backgroundSettings', 'endSettings', 'dispose'] as const) test(`active backup ${operation} revokes late completion`, async () => {
  const { vault, module, calls } = harness(); await vault.open(); const actions = createNativeIdentityActions(vault);
  const request = { pubkey, selectedPubkey: pubkey, revision: 1 };
  await actions.beginSettings(request); calls.length = 0;
  let complete!: () => void;
  module.showNativeBackupAsync = async () => new Promise(resolve => { complete = resolve; });
  const pending = actions.showBackup(request);
  actions[operation](); assert.deepEqual(calls, ['cancel-action']);
  complete(); await assert.rejects(pending, { code: 'AUTHORIZATION_DENIED' });
  await assert.rejects(actions.showBackup(request), { code: 'AUTHORIZATION_DENIED' });
});

test('old cancelled backup completion cannot clear a newer backup operation', async () => {
  const { vault, module, calls } = harness(); await vault.open(); const actions = createNativeIdentityActions(vault);
  const request = { pubkey, selectedPubkey: pubkey, revision: 1 }, completions: (() => void)[] = [];
  module.showNativeBackupAsync = async () => new Promise(resolve => { completions.push(resolve); });
  await actions.beginSettings(request); const old = actions.showBackup(request); actions.cancelBackup();
  await actions.beginSettings(request); const current = actions.showBackup(request); calls.length = 0;
  completions[0](); await assert.rejects(old, { code: 'AUTHORIZATION_DENIED' });
  actions.cancelBackup(); assert.deepEqual(calls, ['cancel-action']);
  completions[1](); await assert.rejects(current, { code: 'AUTHORIZATION_DENIED' });
});

test('explicit Settings end still cancels native work when backup is idle', async () => {
  const { vault, calls } = harness(); await vault.open(); const actions = createNativeIdentityActions(vault);
  const request = { pubkey, selectedPubkey: pubkey, revision: 1 };
  await actions.beginSettings(request); calls.length = 0;
  actions.cancelBackup(); assert.deepEqual(calls, []);
  actions.endSettings(); assert.deepEqual(calls, ['cancel-action']);
  await assert.rejects(actions.showBackup(request), { code: 'AUTHORIZATION_DENIED' });
});


test('Settings background still cancels an active native deletion', async t => {
  const { vault, module, calls } = harness(); await vault.open();
  const imported = await vault.prepareImport(); assert(imported); await vault.commitImport(imported);
  const actions = createNativeIdentityActions(vault), { database } = await setup(t);
  const transition = await IdentityTransition.open({ vault, database, seed: initialTestWorkspace, assertAvailable: assertBundledWorkspace });
  let entered!: () => void, complete!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  module.deleteNativeIdentityAsync = async () => {
    entered(); await new Promise<void>(resolve => { complete = resolve; });
    throw { code: 'AUTHORIZATION_DENIED' };
  };
  calls.length = 0;
  const deletion = transition.deleteInactive(pubkey, transition.getSnapshot().session);
  await waiting; assert.equal(transition.getSnapshot().phase, 'deleting');
  backgroundIdentitySettings(transition, actions);
  assert.deepEqual(calls, ['cancel-action']);
  complete(); await assert.rejects(deletion, { code: 'AUTHORIZATION_DENIED' });
  assert.equal(vault.getSnapshot().identities.length, 2);
  assert.equal(transition.getSnapshot().phase, 'ready');
});
