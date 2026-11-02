import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {openConfigStore, CONFIG_STORE_SERVICE, type ConfigProtectedOptions} from '../../../src/presentation/config-store.ts';

test('production config caller round-trips through the compiled Android allowlist without touching legacy data', async () => {
  const classpath = process.env.HYPERGOLIC_CONFIG_POLICY_CLASSES;
  const java = process.env.HYPERGOLIC_CONFIG_POLICY_JAVA;
  assert.ok(classpath && java, 'Run through the native patch runner');
  const records = new Map([['inventory', 'untouched-encrypted-receipt'], ['secret.test', 'untouched-encrypted-record']]);
  const original = new Map(records);
  const gate = (key: string, options: ConfigProtectedOptions) => {
    assert.equal(options.requireAuthentication, false); assert.equal(options.keychainAccessible, 6);
    execFileSync(java!, ['-cp', classpath!, 'ConfigPolicyProof', key, options.keychainService], {stdio: 'pipe'});
  };
  const native = {
    isAvailableAsync: async () => true,
    getItemAsync: async (key: string, options: ConfigProtectedOptions) => {gate(key, options); return records.get(key) ?? null;},
    setItemAsync: async (key: string, value: string, options: ConfigProtectedOptions) => {gate(key, options); records.set(key, value);}
  };
  const hash = async (value: string) => createHash('sha256').update(value).digest('hex');
  const owner = {user: '01'.repeat(32), publisher: '02'.repeat(32), appId: 'config-test', version: '03'.repeat(32), instanceId: 'one', assertActive() {}};
  const record = {format: 1 as const, ordinary: {theme: 'dark'}, secrets: {'["token"]': 'public-test-token'}};
  const store = await openConfigStore(native, hash, 6);
  await store.change(owner, () => record);
  const reopened = await openConfigStore(native, hash, 6);
  assert.deepEqual(await reopened.read({...owner, instanceId: 'two'}), record);
  const safe = {keychainService: CONFIG_STORE_SERVICE, requireAuthentication: false as const, keychainAccessible: 6};
  for (const key of original.keys()) {
    await assert.rejects(native.getItemAsync(key, safe));
    await assert.rejects(native.setItemAsync(key, 'overwrite', safe));
    assert.equal(records.get(key), original.get(key));
  }
  // Storage here is a double; this checks the production caller against compiled
  // native policy, not OS encryption or a device restart.
});

test('native read failure cannot turn established config into an empty record or a replacement write', async () => {
  for (const reason of ['missing protected key', 'invalidated protected key']) {
    let writes = 0;
    const native = {
      isAvailableAsync: async () => true,
      getItemAsync: async () => {throw new Error(reason);},
      setItemAsync: async () => {writes++;},
    };
    const hash = async (value: string) => createHash('sha256').update(value).digest('hex');
    const owner = {user: '01'.repeat(32), publisher: '02'.repeat(32), appId: 'config-test', version: '03'.repeat(32), instanceId: 'one', assertActive() {}};
    const store = await openConfigStore(native, hash, 6);
    await assert.rejects(store.read(owner), {code: 'STORAGE_FAILURE'});
    let updateCalled = false;
    await assert.rejects(store.change(owner, current => {updateCalled = true; return current;}), {code: 'STORAGE_FAILURE'});
    assert.equal(updateCalled, false);
    assert.equal(writes, 0);
  }
});
