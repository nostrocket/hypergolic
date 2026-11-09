import test from 'node:test';
import assert from 'node:assert/strict';
import {withCvmRelayDefaults} from '../../src/cvm/cvm-relay-defaults.ts';
import type {NativeRelaySettings} from '../../src/network/relay-settings-native.ts';
import {openRelaySettings} from '../../src/network/relay-settings.ts';

test('CVM relay projections follow persisted edits in order and remain bounded to four', async () => {
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let snapshot = {networkRelays: ['wss://first.example.org'], lookupRelays: ['wss://lookup.example.org']};
  let moveStarted = false;
  const settings: NativeRelaySettings = {
    getSettings: () => snapshot,
    async addRelay(_role, url) {
      started.resolve(); await release.promise;
      snapshot = {...snapshot, networkRelays: [...snapshot.networkRelays, url]}; return snapshot;
    },
    async removeRelay() {throw new Error('persistence failed');},
    async moveNetworkRelay() {
      moveStarted = true;
      snapshot = {...snapshot, networkRelays: [...snapshot.networkRelays].reverse()}; return snapshot;
    },
    async restoreDefaults() {return {networkRelays: ['a','b','c','d','e'], lookupRelays: []};},
    async close() {},
  };
  const projections: string[][] = [];
  const mirrored = withCvmRelayDefaults(settings, relays => projections.push([...relays]));
  const second = 'wss://second.example.org';
  const add = mirrored.addRelay('network', second), move = mirrored.moveNetworkRelay(second, 'up');
  await started.promise;
  assert.equal(moveStarted, false);
  assert.deepEqual(projections, [['wss://first.example.org']]);
  release.resolve(); await Promise.all([add, move]);
  assert.deepEqual(projections.slice(1), [['wss://first.example.org', second], [second, 'wss://first.example.org']]);
  await assert.rejects(mirrored.removeRelay('network', second));
  assert.equal(projections.length, 3);
  await mirrored.restoreDefaults();
  assert.deepEqual(projections[3], ['a','b','c','d']);
});

function savedRelays(fifth: string) {
  const before = {
    networkRelays: ['first','second','third','fourth'].map(name => `wss://${name}.example.org`).concat(fifth),
    lookupRelays: ['wss://lookup.example.org'],
  };
  let saved = JSON.stringify({schemaVersion: 1, ...before});
  const storage = {getItem: async () => saved, setItem: async (_: string, value: string) => {saved = value;}};
  const reopen = async (): Promise<NativeRelaySettings> => ({...await openRelaySettings(storage), close: async () => {}});
  return {before, reopen};
}

for (const invalid of ['wss://relay.example.org:0', 'wss://relay.example.org/%0a']) {
  test(`rejected CVM projection clears defaults and preserves saved Network order for ${invalid}`, async () => {
    const {before, reopen} = savedRelays(invalid);
    const projections: string[][] = [];
    const configure = (relays: readonly string[]) => {
      projections.push([...relays]);
      if (relays.includes(invalid)) throw new Error('native relay policy denied');
    };
    const mirrored = withCvmRelayDefaults(await reopen(), configure);
    const moved = await mirrored.moveNetworkRelay(invalid, 'up');
    assert.deepEqual(moved.networkRelays, [...before.networkRelays.slice(0,3), invalid, before.networkRelays[3]]);
    assert.deepEqual(moved.lookupRelays, before.lookupRelays);
    assert.deepEqual(projections, [before.networkRelays.slice(0,4), moved.networkRelays.slice(0,4), []]);
    assert.equal(mirrored.getCvmDefaultsState?.(), 'cleared');
    const restarted = withCvmRelayDefaults(await reopen(), configure);
    assert.deepEqual(restarted.getSettings(), moved);
    assert.equal(restarted.getCvmDefaultsState?.(), 'cleared');
    assert.deepEqual(projections.at(-1), []);
    await restarted.moveNetworkRelay(invalid, 'down');
    assert.deepEqual(restarted.getSettings(), before);
    assert.deepEqual(projections.at(-1), before.networkRelays.slice(0,4));
    assert.equal(restarted.getCvmDefaultsState?.(), 'configured');
  });
}

test('a failed CVM reset stays unknown and observable while Settings retains the persisted move', async () => {
  const invalid = 'wss://relay.example.org:0';
  const {before, reopen} = savedRelays(invalid);
  const mirrored = withCvmRelayDefaults(await reopen(), relays => {
    if (relays.includes(invalid)) throw new Error('native relay policy denied');
    if (relays.length === 0) throw new Error('native reset failed');
  });
  await assert.rejects(mirrored.moveNetworkRelay(invalid, 'up'), /native reset failed/);
  assert.equal(mirrored.getCvmDefaultsState?.(), 'unknown');
  assert.equal(mirrored.getSettings().networkRelays[3], invalid);
  assert.deepEqual((await reopen()).getSettings(), mirrored.getSettings());
  await mirrored.moveNetworkRelay(invalid, 'down');
  assert.deepEqual(mirrored.getSettings(), before);
  assert.equal(mirrored.getCvmDefaultsState?.(), 'configured');
});
