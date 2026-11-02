import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentityActions, type IdentityActionsModule } from '../../src/security/identity-actions.ts';
import { VaultError } from '../../src/security/identity-vault.ts';

const selected = '22'.repeat(32), target = '11'.repeat(32), other = '33'.repeat(32);
const context = { selectedPubkey: selected, revision: 4 };
const denied = (error: unknown) => error instanceof VaultError && error.code === 'AUTHORIZATION_DENIED';
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
/** Explicit test double: production authentication and reveal remain entirely native. */
class NativeBackupDouble implements IdentityActionsModule {
  calls: unknown[][] = [];
  showing: ReturnType<typeof deferred<void>> | null = null;
  isDeletionAvailableAsync = async () => true;
  isBackupAvailableAsync?: () => Promise<boolean> = async () => true;
  activateIdentityActions() { this.calls.push(['activate']); }
  beginSettingsAsync(key: string, revision: number) { this.calls.push(['begin', key, revision]); return Promise.resolve('settings_fixture_123'); }
  endSettings(session: string) { this.calls.push(['end', session]); }
  cancelDeletion(session: string) { this.calls.push(['cancel-delete', session]); }
  authorizeDeletionAsync(session: string, key: string, current: string, revision: number) {
    this.calls.push(['authorize-delete', session, key, current, revision]); return Promise.resolve('grant_fixture_value_123');
  }
  assertDeletionGrantActive() { /* Not reached by backup tests. */ }
  showBackupAsync?: (session: string, key: string, current: string, revision: number) => Promise<void> = (session, key, current, revision) => {
    this.calls.push(['show', session, key, current, revision]); return this.showing?.promise ?? Promise.resolve();
  };
  cancelBackup?: (session: string) => void = session => { this.calls.push(['cancel-backup', session]); };
}
async function ready() {
  const native = new NativeBackupDouble(), actions = createIdentityActions(native, 'ios');
  await actions.beginSettings(context);
  return { native, actions };
}

test('backup is unavailable and denied when the native module omits any required optional method', async () => {
  const native = new NativeBackupDouble();
  native.cancelBackup = undefined;
  const actions = createIdentityActions(native, 'ios');
  await actions.beginSettings(context);
  assert.equal(await actions.isBackupAvailable(), false);
  await assert.rejects(actions.showBackup({ pubkey: selected, ...context }), denied);
  assert.equal(native.calls.filter(call => call[0] === 'show').length, 0);
  native.cancelBackup = session => { native.calls.push(['cancel-backup', session]); };
  native.showBackupAsync = undefined;
  await assert.rejects(actions.showBackup({ pubkey: selected, ...context }), denied);
  native.showBackupAsync = async () => undefined;
  native.cancelBackup = undefined;
  assert.equal(await actions.isBackupAvailable(), false);
});
test('backup binds the exact selected identity and revision, with no JS secret result', async () => {
  const { native, actions } = await ready();
  assert.equal(await actions.showBackup({ pubkey: selected, ...context }), undefined);
  assert.deepEqual(native.calls.filter(call => call[0] === 'show'), [['show', 'settings_fixture_123', selected, selected, 4]]);
  await assert.rejects(actions.showBackup({ pubkey: target, ...context }), denied);
  await assert.rejects(actions.showBackup({ pubkey: selected, selectedPubkey: other, revision: 4 }), denied);
  await assert.rejects(actions.showBackup({ pubkey: selected, selectedPubkey: selected, revision: 5 }), denied);
});
test('backup cancellation invalidates the local epoch before its late native panel result', async () => {
  const { native, actions } = await ready();
  native.showing = deferred<void>();
  const showing = actions.showBackup({ pubkey: selected, ...context });
  actions.cancelBackup();
  assert.deepEqual(native.calls.filter(call => call[0] === 'cancel-backup'), [['cancel-backup', 'settings_fixture_123']]);
  native.showing.resolve();
  await assert.rejects(showing, denied);
});
test('a changed selected context cannot reuse the previous Settings session', async () => {
  const { native, actions } = await ready();
  native.showing = deferred<void>();
  const showing = actions.showBackup({ pubkey: selected, ...context });
  actions.cancelBackup();
  native.showing.resolve();
  await assert.rejects(showing, denied);
  await actions.beginSettings({ selectedPubkey: other, revision: 5 });
  await assert.rejects(actions.showBackup({ pubkey: selected, ...context }), denied);
  assert.deepEqual(native.calls.filter(call => call[0] === 'begin').at(-1), ['begin', other, 5]);
});
test('backup and deletion share one pending action lock', async () => {
  const { native, actions } = await ready();
  native.showing = deferred<void>();
  const showing = actions.showBackup({ pubkey: selected, ...context });
  await assert.rejects(actions.authorizeDeletion({ pubkey: target, ...context }), denied);
  native.showing.resolve();
  await showing;
});
