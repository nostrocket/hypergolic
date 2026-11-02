import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentityActions, type IdentityActionsModule } from '../../src/security/identity-actions.ts';
import { VaultError, type DeletionGrant } from '../../src/security/identity-vault.ts';

const selected = '22'.repeat(32), target = '11'.repeat(32), other = '33'.repeat(32);
const context = { selectedPubkey: selected, revision: 4 };
const request = { pubkey: target, ...context };
const denied = (error: unknown) => error instanceof VaultError && error.code === 'AUTHORIZATION_DENIED';
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
/** Test-only simulated native surface. Production authentication remains the real LAContext adapter. */
class NativeFixture implements IdentityActionsModule {
  activations = 0;
  nextSession = 0;
  nextGrant = 0;
  calls: unknown[][] = [];
  valid = true;
  activationFailure = false;
  opening: ReturnType<typeof deferred<string>> | null = null;
  authentication: ReturnType<typeof deferred<string>> | null = null;
  grants = new Map<string, { session: string; target: string }>();
  async isDeletionAvailableAsync() { return true; }
  activateIdentityActions() { this.activations += 1; if (this.activationFailure) throw new Error('native diagnostic must not escape'); }
  beginSettingsAsync(key: string, revision: number): Promise<string> {
    this.calls.push(['begin', key, revision]);
    return this.opening?.promise ?? Promise.resolve(`settings_fixture_${++this.nextSession}`);
  }
  endSettings(session: string) { this.calls.push(['end', session]); this.grants.clear(); }
  cancelDeletion(session: string) { this.calls.push(['cancel', session]); this.grants.clear(); }
  authorizeDeletionAsync(session: string, key: string, current: string, revision: number): Promise<string> {
    this.calls.push(['authorize', session, key, current, revision]);
    if (this.authentication) return this.authentication.promise;
    return Promise.resolve(this.issue(session, key));
  }
  issue(session: string, key: string) {
    const token = `grant_fixture_value_${++this.nextGrant}`;
    this.grants.set(token, { session, target: key }); return token;
  }
  assertDeletionGrantActive(session: string, key: string, token: string) {
    const grant = this.grants.get(token);
    if (!this.valid || grant?.session !== session || grant.target !== key) throw new Error('native revoked');
    this.calls.push(['assert', session, key, token]);
  }
}
async function ready() {
  const native = new NativeFixture(), actions = createIdentityActions(native, 'ios');
  await actions.beginSettings(context);
  return { native, actions };
}
test('activation requires a supported native platform and native admission; failure is constant and never retried', () => {
  const native = new NativeFixture();
  assert.throws(() => createIdentityActions(native, 'web'), { code: 'STORAGE_FAILURE' });
  assert.equal(native.activations, 0);
  native.activationFailure = true;
  assert.throws(() => createIdentityActions(native, 'ios'), { code: 'STORAGE_FAILURE', message: 'STORAGE_FAILURE' });
  assert.equal(native.activations, 1);
});
test('native receives exact context and an immutable grant exposes no token', async () => {
  const { native, actions } = await ready();
  const grant = await actions.authorizeDeletion(request);
  assert.deepEqual(native.calls.find(c => c[0] === 'authorize'), ['authorize', 'settings_fixture_1', target, selected, 4]);
  assert.equal(Object.isFrozen(grant), true);
  assert.deepEqual(Object.keys(grant), ['assertActive']);
  grant.assertActive();
  assert.equal(actions.tokens.consume(grant, target), 'grant_fixture_value_1');
  assert.throws(() => grant.assertActive(), denied);
  assert.throws(() => actions.tokens.consume(grant, target), denied);
});
test('selected target, changed selection/revision and missing settings never reach native auth', async () => {
  const { native, actions } = await ready();
  for (const invalid of [{ ...request, pubkey: selected }, { ...request, selectedPubkey: other }, { ...request, revision: 5 }]) {
    await assert.rejects(actions.authorizeDeletion(invalid), denied);
  }
  actions.endSettings();
  await assert.rejects(actions.authorizeDeletion(request), denied);
  assert.equal(native.calls.filter(c => c[0] === 'authorize').length, 0);
});
test('invalid contexts are rejected before native beginning', async () => {
  const native = new NativeFixture(), actions = createIdentityActions(native, 'ios');
  for (const revision of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(actions.beginSettings({ ...context, revision }), denied);
  }
  await assert.rejects(actions.beginSettings({ ...context, selectedPubkey: 'bad' }), denied);
  assert.equal(native.calls.length, 0);
});
test('foreign grants and wrong targets cannot use or consume a real grant', async () => {
  const { actions } = await ready(), grant = await actions.authorizeDeletion(request);
  let getterCalls = 0;
  const forged = Object.defineProperty({}, 'assertActive', { get() { getterCalls += 1; throw new Error('must not run'); } }) as DeletionGrant;
  assert.throws(() => actions.tokens.consume(forged, target), denied);
  assert.equal(getterCalls, 0);
  assert.throws(() => actions.tokens.consume(grant, other), denied);
  assert.equal(actions.tokens.consume(grant, target), 'grant_fixture_value_1');
});
for (const reason of ['cancel', 'dismiss', 'dispose'] as const) test(`late authentication after ${reason} cannot issue a usable JS grant`, async () => {
  const { native, actions } = await ready();
  native.authentication = deferred<string>();
  const pending = actions.authorizeDeletion(request);
  await assert.rejects(actions.authorizeDeletion(request), denied);
  if (reason === 'cancel') actions.cancelDeletion();
  else if (reason === 'dismiss') actions.endSettings();
  else actions.dispose();
  native.authentication.resolve(native.issue('settings_fixture_1', target));
  await assert.rejects(pending, denied);
});
for (const reason of ['background', 'runtime loss', 'expiry']) test(`native ${reason} revocation is checked even without a JS lifecycle event`, async () => {
  const { native, actions } = await ready(), grant = await actions.authorizeDeletion(request);
  native.valid = false;
  assert.throws(() => grant.assertActive(), denied);
  assert.throws(() => actions.tokens.consume(grant, target), denied);
});
test('dismissal while settings open is pending closes the exact late session and rejects duplicate opening', async () => {
  const native = new NativeFixture(), actions = createIdentityActions(native, 'ios');
  native.opening = deferred<string>();
  const pending = actions.beginSettings(context);
  await assert.rejects(actions.beginSettings(context), denied);
  actions.endSettings();
  native.opening.resolve('settings_fixture_late');
  await assert.rejects(pending, denied);
  assert.deepEqual(native.calls.filter(c => c[0] === 'end'), [['end', 'settings_fixture_late']]);
  await assert.rejects(actions.authorizeDeletion(request), denied);
});
test('old grant cannot consume a newer token for the same target after cancellation', async () => {
  const { actions } = await ready(), old = await actions.authorizeDeletion(request);
  actions.cancelDeletion();
  const current = await actions.authorizeDeletion(request);
  assert.throws(() => actions.tokens.consume(old, target), denied);
  assert.equal(actions.tokens.consume(current, target), 'grant_fixture_value_2');
});
test('native rejection and malformed token return no grant or native diagnostic', async () => {
  const { native, actions } = await ready();
  native.authentication = deferred<string>();
  const rejected = actions.authorizeDeletion(request);
  native.authentication.reject(new Error('private native details'));
  await assert.rejects(rejected, { code: 'AUTHORIZATION_DENIED', message: 'AUTHORIZATION_DENIED' });
  native.authentication = deferred<string>();
  const malformed = actions.authorizeDeletion(request);
  native.authentication.resolve('bad');
  await assert.rejects(malformed, denied);
});
test('local revocation happens even when native cancellation throws', async () => {
  const { native, actions } = await ready(), grant = await actions.authorizeDeletion(request);
  native.cancelDeletion = () => { throw new Error('private diagnostic'); };
  assert.throws(() => actions.cancelDeletion(), denied);
  assert.throws(() => grant.assertActive(), denied);
});


for (const platform of ['android', 'ios'] as const) test(`${platform}: shared owner requires native availability and binds the exact erase token`, async () => {
  const native = new NativeFixture(), actions = createIdentityActions(native, platform);
  assert.equal(await actions.isDeletionAvailable(), true);
  native.isDeletionAvailableAsync = async () => false;
  assert.equal(await actions.isDeletionAvailable(), false);
  native.isDeletionAvailableAsync = async () => { throw new Error('native private details'); };
  assert.equal(await actions.isDeletionAvailable(), false);
  await actions.beginSettings(context);
  const grant = await actions.authorizeDeletion(request);
  assert.equal(actions.tokens.consume(grant, target), 'grant_fixture_value_1');
  actions.dispose();
  assert.equal(await actions.isDeletionAvailable(), false);
  await assert.rejects(actions.authorizeDeletion(request), denied);
});
test('late availability cannot reopen a disposed owner', async () => {
  const native = new NativeFixture(), actions = createIdentityActions(native, 'android');
  const result = deferred<boolean>(); native.isDeletionAvailableAsync = () => result.promise;
  const available = actions.isDeletionAvailable(); actions.dispose(); result.resolve(true);
  assert.equal(await available, false);
});
