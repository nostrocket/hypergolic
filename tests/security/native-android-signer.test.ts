import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { captureSigningMethods, signerFailureMessage, signingMethodAction, signingMethodTitle } from '../../src/security/signing-methods.ts';
import { identityChangeCopy } from '../../src/shell/identity-change-copy.ts';
import { IdentityTransition } from '../../src/security/identity-transition.ts';
import { backgroundIdentitySettings } from '../../src/shell/identity-settings-lifecycle.ts';
import { initialTestWorkspace, assertBundledWorkspace } from '../../src/shell/fixtures.ts';
import { VaultError } from '../../src/security/identity-vault-model.ts';
import { captureNativeVaultSnapshot } from '../../src/security/native-identity-vault.ts';
import { setup, deferred, registration } from '../storage/harness.ts';
import { harness, first, pubkey, second, candidate, event, authority } from './native-vault-harness.ts';

const android = { kind: 'nip55', packageName: 'com.example.signer', certificateSha256s: ['1'.repeat(64), 'a'.repeat(64)] };
const metadata = { vaultId: first.vaultId, revision: first.revision, pubkey, selectedMethod: 'nip55', methods: [android] };

test('Android signer metadata retains the exact package and sorted complete certificate set', () => {
  const captured = captureSigningMethods(JSON.stringify(metadata), first, pubkey);
  assert.deepEqual(captured.methods, [android]);
  const method = captured.methods[0]; assert.equal(method.kind, 'nip55');
  if (method.kind !== 'nip55') throw new Error('Wrong method');
  assert(Object.isFrozen(method)); assert(Object.isFrozen(method.certificateSha256s));
  const all = [{ kind: 'local' }, { kind: 'nip46', peerPubkey: second, relays: ['wss://relay.damus.io'] }, android];
  assert.equal(captureSigningMethods(JSON.stringify({ ...metadata, methods: all }), first, pubkey).methods.length, 3);
  assert.equal(captureSigningMethods(JSON.stringify({ ...metadata, methods: all.slice(1) }), first, pubkey).methods.length, 2);
  for (const methods of [[android, all[0]], [android, android], [all[1], all[0], android]]) {
    assert.throws(() => captureSigningMethods(JSON.stringify({ ...metadata, methods }), first, pubkey), { code: 'CORRUPT_METADATA' });
  }
});

test('Android method metadata rejects incomplete, reordered, oversized or noncanonical trust identity', () => {
  const invalid = [
    { ...android, packageName: 'com.example.signer\n' }, { ...android, packageName: 'signer' },
    { ...android, packageName: 'com..signer' }, { ...android, packageName: 'a.' + 'b'.repeat(254) },
    { ...android, packageName: 'com.1signer' }, { ...android, certificateSha256s: [] },
    { ...android, certificateSha256s: [...android.certificateSha256s].reverse() },
    { ...android, certificateSha256s: ['1'.repeat(64), '1'.repeat(64)] },
    { ...android, certificateSha256s: ['A'.repeat(64)] }, { ...android, certificateSha256s: [null] },
    { ...android, certificateSha256s: ['a'.repeat(64) + '\n'] },
    { ...android, certificateSha256s: Array.from({ length: 17 }, (_, i) => i.toString(16).padStart(64, '0')) },
    { kind: 'nip55', packageName: android.packageName, certificateSha256: 'a'.repeat(64) },
    { ...android, secretKey: 'forbidden' },
  ];
  for (const method of invalid) assert.throws(() => captureSigningMethods(JSON.stringify({ ...metadata, methods: [method] }), first, pubkey), { code: 'CORRUPT_METADATA' });
});

test('native metadata and candidate identifiers require exact bytes without trailing line breaks', async () => {
  for (const next of [{ ...first, vaultId: first.vaultId + '\n' },
    { ...first, selectedPubkey: pubkey + '\n', identities: [{ ...first.identities[0], pubkey: pubkey + '\n' }] }]) {
    assert.throws(() => captureNativeVaultSnapshot(JSON.stringify(next)), { code: 'CORRUPT_METADATA' });
  }
  for (const result of [{ ...candidate, handle: candidate.handle + '\n' }, { ...candidate, pubkey: pubkey + '\n' }]) {
    const { vault, module } = harness(); await vault.open();
    module.prepareNativeAndroidSignerAsync = async () => JSON.stringify(result);
    await assert.rejects(vault.prepareAndroidSigner(), { code: 'CORRUPT_METADATA' });
    assert.throws(() => vault.getSnapshot(), { code: 'NOT_READY' });
  }
  const remote = { kind: 'nip46', peerPubkey: second + '\n', relays: ['wss://relay.damus.io'] };
  assert.throws(() => captureSigningMethods(JSON.stringify({ ...metadata, selectedMethod: 'nip46', methods: [remote] }), first, pubkey), { code: 'CORRUPT_METADATA' });
});

test('Android connection candidates cannot substitute for remote, refresh, import or cloned candidates', async () => {
  const { vault, module, calls } = harness(); await vault.open();
  module.prepareNativeAndroidSignerAsync = async () => JSON.stringify({ ...candidate, pubkey });
  module.commitNativeAndroidSignerAsync = async (handle, vaultId, revision) => {
    assert.equal(handle, candidate.handle); assert.equal(vaultId, first.vaultId); assert.equal(revision, 1);
    calls.push('android-commit'); return JSON.stringify({ ...first, revision: 2 });
  };
  const pending = await vault.prepareAndroidSigner(); assert(pending);
  await assert.rejects(vault.commitAndroidSigner({ ...pending }), { code: 'AUTHORIZATION_DENIED' });
  await assert.rejects(vault.commitRemoteConnection(pending), { code: 'AUTHORIZATION_DENIED' });
  await assert.rejects(vault.commitRemoteRefresh(pending), { code: 'AUTHORIZATION_DENIED' });
  await assert.rejects(vault.commitImport(pending), { code: 'AUTHORIZATION_DENIED' });
  vault.cancelRemoteConnection(pending); vault.cancelRemoteRefresh(pending); vault.cancelImport(pending);
  assert.deepEqual(calls, []);
  assert.deepEqual(await vault.commitAndroidSigner(pending), { ...first, revision: 2 });
  await assert.rejects(vault.commitAndroidSigner(pending), { code: 'AUTHORIZATION_DENIED' });
  assert.deepEqual(calls, ['android-commit']);
});

test('Android cancellation consumes only its issued handle and cannot cancel remote preparation results', async () => {
  const { vault, calls } = harness(); await vault.open();
  const remote = await vault.prepareRemoteConnection(); assert(remote);
  vault.cancelAndroidSigner(remote); assert.deepEqual(calls, []);
  await assert.rejects(vault.commitAndroidSigner(remote), { code: 'AUTHORIZATION_DENIED' });
  const pending = await vault.prepareAndroidSigner(); assert(pending);
  vault.cancelAndroidSigner({ ...pending }); vault.cancelAndroidSigner(pending); vault.cancelAndroidSigner(pending);
  await assert.rejects(vault.commitAndroidSigner(pending), { code: 'AUTHORIZATION_DENIED' });
  assert.deepEqual(calls, [`cancel-android:${pending.handle}`]);
});

test('Android connection rejects private candidate fields and inconsistent durable readback', async () => {
  const invalid = harness(); await invalid.vault.open();
  invalid.module.prepareNativeAndroidSignerAsync = async () => JSON.stringify({ ...candidate, privateKey: 'forbidden' });
  await assert.rejects(invalid.vault.prepareAndroidSigner(), { code: 'CORRUPT_METADATA' });
  assert.throws(() => invalid.vault.getSnapshot(), { code: 'NOT_READY' });
  for (const next of [first, { ...first, revision: 3 }, { ...first, revision: 2, identities: [{ ...first.identities[0], origin: 'connected' }] }]) {
    const { vault, module } = harness(); await vault.open();
    module.prepareNativeAndroidSignerAsync = async () => JSON.stringify({ ...candidate, pubkey });
    module.commitNativeAndroidSignerAsync = async () => JSON.stringify(next);
    const pending = await vault.prepareAndroidSigner(); assert(pending);
    await assert.rejects(vault.commitAndroidSigner(pending), { code: 'CORRUPT_METADATA' });
    assert.throws(() => vault.getSnapshot(), { code: 'NOT_READY' });
  }
});

test('a missing native Android adapter remains an unsupported recoverable operation', async () => {
  const { vault, module } = harness(); const before = await vault.open();
  module.prepareNativeAndroidSignerAsync = undefined as never;
  await assert.rejects(vault.prepareAndroidSigner(), { code: 'SIGNER_UNSUPPORTED' });
  assert.equal(vault.getSnapshot(), before);
});

for (const code of ['SIGNER_IDENTITY_CHANGED', 'SIGNER_APP_FAILED', 'SIGNER_REJECTED', 'SIGNER_UNAVAILABLE'] as const) {
  test(`Android signing ${code} has no fallback and does not expose native error text`, async () => {
    const { vault, module, calls } = harness(); const before = await vault.open();
    module.reviewAndSignNativeEventAsync = async () => { calls.push('one-request'); throw { code, message: 'untrusted signer data' }; };
    const execution = authority();
    await assert.rejects(vault.signApproved(event, execution), error => error instanceof VaultError && error.code === code && error.message === code);
    assert.equal(vault.getSnapshot(), before);
    await assert.rejects(vault.signApproved(event, execution), { code: 'AUTHORIZATION_DENIED' });
    assert.deepEqual(calls, ['one-request']);
    assert(!signerFailureMessage(code).includes('untrusted'));
  });
}

async function transitionHarness(t: TestContext) {
  const native = harness(); await native.vault.open();
  const storage = await setup(t);
  const transition = await IdentityTransition.open({ vault: native.vault, database: storage.database,
    seed: initialTestWorkspace, assertAvailable: assertBundledWorkspace });
  return { ...native, ...storage, transition };
}

test('linking an Android signer to the same account flushes and preserves napplet data and revokes old authority', async t => {
  const { vault, module, database, transition } = await transitionHarness(t);
  const before = transition.getSnapshot().session, old = transition.sessionAuthority();
  const stored = database.bindStorage(registration({ user: old.user, assertActive: old.assertActive }));
  await stored.port.set('saved', 'same account');
  module.prepareNativeAndroidSignerAsync = async () => JSON.stringify({ ...candidate, pubkey });
  module.commitNativeAndroidSignerAsync = async () => JSON.stringify({ ...first, revision: 2 });
  const pending = await transition.prepareAndroidSigner(); assert(pending); assert.equal(pending.kind, 'connect-android');
  await transition.confirm(pending);
  assert.equal(vault.getSnapshot().identities.length, 1); assert.equal(vault.getSnapshot().selectedPubkey, pubkey);
  assert.equal(transition.getSnapshot().session.epoch, before.epoch + 1);
  assert.throws(old.assertActive, { code: 'STALE' });
  const current = transition.sessionAuthority();
  assert.equal(await database.bindStorage(registration({ user: current.user, assertActive: current.assertActive })).port.get('saved'), 'same account');
});

for (const retained of [false, true]) test(`Settings background retains only an exact Android preparation: ${retained}`, async t => {
  const { module, calls, transition } = await transitionHarness(t); const gate = deferred(); let id = '';
  module.prepareNativeAndroidSignerAsync = async (vaultId, revision, attemptId) => {
    assert.equal(vaultId, first.vaultId); assert.equal(revision, first.revision); id = attemptId;
    await gate.promise; return JSON.stringify(candidate);
  };
  module.nativeRemotePreparationHandoffState = (vaultId, revision, attemptId) => {
    assert.equal(vaultId, first.vaultId); assert.equal(revision, first.revision); assert.equal(attemptId, id);
    return retained ? 'pending' : null;
  };
  const work = transition.prepareAndroidSigner(); backgroundIdentitySettings(transition); gate.resolve();
  const pending = await work;
  if (retained) {
    assert(pending); assert.equal(pending.kind, 'connect-android'); assert.deepEqual(calls, []);
    transition.cancel(pending); assert.deepEqual(calls, [`cancel-android:${candidate.handle}`]);
  } else {
    assert.equal(pending, null); assert.deepEqual(calls, ['cancel-action', `cancel-android:${candidate.handle}`]);
  }
});

test('Android disconnect names the exact method and never chooses a fallback', async t => {
  const { module, calls, transition } = await transitionHarness(t);
  module.disconnectNativeSigningMethodAsync = async (account, method) => {
    assert.equal(account, pubkey); assert.equal(method, 'nip55'); calls.push('disconnect'); return JSON.stringify({ ...first, revision: 2 });
  };
  module.selectNativeSigningMethodAsync = async () => { throw new Error('No fallback'); };
  await transition.confirm(transition.prepareDisconnect('nip55'));
  assert.equal(transition.getSnapshot().session.vault.selectedPubkey, pubkey); assert.deepEqual(calls, ['disconnect']);
});

test('Android method copy distinguishes local, remote and same-phone signing', () => {
  assert.equal(signingMethodTitle('nip55'), 'Android signer app');
  assert.equal(signingMethodAction('nip55'), 'Use Android signer app');
  assert.equal(identityChangeCopy({ kind: 'select-method', method: 'nip55', pubkey }, pubkey).approve, 'Use Android signer app');
  assert.equal(identityChangeCopy({ kind: 'disconnect-method', method: 'nip55', pubkey }, pubkey).title, 'Disconnect signer app?');
  assert.match(identityChangeCopy({ kind: 'connect-android', pubkey }, pubkey).detail, /saved data stay the same/);
});
