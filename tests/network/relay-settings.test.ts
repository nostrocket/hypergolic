import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  openRelaySettings,
  RELAY_SETTINGS_STORAGE_KEY,
  MAX_RELAYS_PER_ROLE,
  MAX_RELAY_URL_BYTES,
  RelaySettingsError,
  type RelaySettingsStoragePort,
} from '../../src/network/relay-settings.ts';

const defaults = JSON.parse(readFileSync('src/config/default-relays.json', 'utf8')) as {
  networkRelays: string[];
  lookupRelays: string[];
};

class MemoryStorage implements RelaySettingsStoragePort {
  readonly values = new Map<string, string>();
  writes = 0;
  async getItem(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
  async setItem(key: string, value: string): Promise<void> { this.writes += 1; this.values.set(key, value); }
}

function expectCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => error instanceof RelaySettingsError && error.code === code);
}

test('first open seeds exact shipped defaults and subsequent open retains edits', async () => {
  const storage = new MemoryStorage();
  const first = await openRelaySettings(storage);
  assert.deepEqual(first.getSettings(), defaults);
  assert.equal(storage.writes, 1);
  assert.equal(storage.values.has(RELAY_SETTINGS_STORAGE_KEY), true);

  await first.addRelay('network', 'wss://relay.example.org');
  const reopened = await openRelaySettings(storage);
  assert.deepEqual(reopened.getSettings().networkRelays, [...defaults.networkRelays, 'wss://relay.example.org']);
  assert.equal(storage.writes, 2);
});

test('user edits including empty role lists persist and restore defaults is explicit', async () => {
  const storage = new MemoryStorage();
  const service = await openRelaySettings(storage);
  for (const relay of [...defaults.networkRelays]) await service.removeRelay('network', relay);
  const reopenedEmpty = await openRelaySettings(storage);
  assert.deepEqual(reopenedEmpty.getSettings().networkRelays, []);
  assert.deepEqual(reopenedEmpty.getSettings().lookupRelays, defaults.lookupRelays);

  await reopenedEmpty.restoreDefaults('network');
  const reopenedRestored = await openRelaySettings(storage);
  assert.deepEqual(reopenedRestored.getSettings().networkRelays, defaults.networkRelays);
  await reopenedRestored.restoreDefaults();
  assert.deepEqual((await openRelaySettings(storage)).getSettings(), defaults);
});

test('previously saved default membership and order survive the new default seed', async () => {
  const storage = new MemoryStorage();
  const networkRelays = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://bucket.coracle.social'];
  const lookupRelays = ['wss://lookup.example.org'];
  storage.values.set(RELAY_SETTINGS_STORAGE_KEY, JSON.stringify({schemaVersion: 1, networkRelays, lookupRelays}));
  const service = await openRelaySettings(storage);
  assert.deepEqual(service.getSettings(), {networkRelays, lookupRelays});
  assert.equal(storage.writes, 0);
  await service.restoreDefaults('network');
  assert.deepEqual(service.getSettings(), {networkRelays: defaults.networkRelays, lookupRelays});
});

test('moving a Network relay uses its current position and preserves both role memberships on reopen', async () => {
  const storage = new MemoryStorage();
  const service = await openRelaySettings(storage);
  const added = 'wss://relay.example.org';
  await service.addRelay('network', added);
  await service.addRelay('lookup', 'wss://lookup.example.org');
  const before = service.getSettings();
  const [first, second, third] = defaults.networkRelays;
  await Promise.all([service.moveNetworkRelay('wss://RELAY.EXAMPLE.ORG:443/', 'up'), service.moveNetworkRelay(added, 'up')]);
  assert.deepEqual(service.getSettings().networkRelays, [first, added, second, third]);
  await service.moveNetworkRelay(added, 'down');
  const after = (await openRelaySettings(storage)).getSettings();
  assert.deepEqual(after.networkRelays, [first, second, added, third]);
  assert.deepEqual(new Set(after.networkRelays), new Set(before.networkRelays));
  assert.deepEqual(after.lookupRelays, before.lookupRelays);
});

test('invalid, missing and boundary Network moves leave the stored list unchanged', async () => {
  const storage = new MemoryStorage();
  const service = await openRelaySettings(storage);
  const before = service.getSettings();
  const [first, , last] = before.networkRelays;
  const prior = storage.values.get(RELAY_SETTINGS_STORAGE_KEY);
  expectCode(() => service.moveNetworkRelay('ws://relay.example.org', 'up'), 'INVALID_RELAY_URL');
  expectCode(() => service.moveNetworkRelay(first!, 'sideways' as never), 'INVALID_RELAY_MOVE');
  await assert.rejects(service.moveNetworkRelay(before.lookupRelays[0]!, 'up'), {code: 'INVALID_RELAY_MOVE'});
  await service.moveNetworkRelay(first!, 'up');
  await service.moveNetworkRelay(last!, 'down');
  assert.deepEqual(service.getSettings(), before);
  assert.equal(storage.values.get(RELAY_SETTINGS_STORAGE_KEY), prior);
  assert.equal(storage.writes, 1);
});

test('a failed Network move is not published in memory and the next move can persist', async () => {
  const storage = new MemoryStorage();
  const service = await openRelaySettings(storage);
  const before = service.getSettings(), setItem = storage.setItem.bind(storage);
  storage.setItem = async () => {throw new Error('write failed');};
  await assert.rejects(service.moveNetworkRelay(before.networkRelays[1]!, 'up'), /write failed/);
  assert.deepEqual(service.getSettings(), before);
  storage.setItem = setItem;
  await service.moveNetworkRelay(before.networkRelays[1]!, 'up');
  assert.deepEqual((await openRelaySettings(storage)).getSettings().networkRelays,
    [before.networkRelays[1], before.networkRelays[0], before.networkRelays[2]]);
});

test('accepts public wss DNS names and rejects unsafe or noncanonical URL classes', async () => {
  const service = await openRelaySettings(new MemoryStorage());
  await service.addRelay('lookup', 'wss://relay.example.org:443/path');
  assert.equal(service.getSettings().lookupRelays.at(-1), 'wss://relay.example.org/path');

  for (const url of [
    'ws://relay.example.org',
    'https://relay.example.org',
    'wss://user:pass@relay.example.org',
    'wss://@relay.example.org',
    'wss://relay.example.org?token=secret',
    'wss://relay.example.org#fragment',
    `wss://relay.example.org/${'x'.repeat(MAX_RELAY_URL_BYTES)}`,
    'wss://localhost',
    'wss://relay.localhost',
    'wss://router.lan',
    'wss://relay.internal',
    'wss://127.0.0.1',
    'wss://10.0.0.2',
    'wss://192.168.1.20',
    'wss://[::1]',
    'wss://single-label',
  ]) expectCode(() => service.addRelay('network', url), 'INVALID_RELAY_URL');
});

test('duplicate detection is canonical and scoped to one role', async () => {
  const service = await openRelaySettings(new MemoryStorage());
  await service.addRelay('network', 'wss://relay.example.org');
  await assert.rejects(service.addRelay('network', 'wss://RELAY.EXAMPLE.ORG:443/'), (error: unknown) =>
    error instanceof RelaySettingsError && error.code === 'DUPLICATE_RELAY');
  await assert.rejects(service.addRelay('network', 'wss://relay.example.org.'), (error: unknown) =>
    error instanceof RelaySettingsError && error.code === 'DUPLICATE_RELAY');
  expectCode(() => service.addRelay('other' as never, 'wss://other.example.org'), 'INVALID_RELAY_ROLE');
  await service.addRelay('lookup', 'wss://relay.example.org');
  assert.equal(service.getSettings().networkRelays.at(-1), 'wss://relay.example.org');
  assert.equal(service.getSettings().lookupRelays.at(-1), 'wss://relay.example.org');
});

test('invalid persisted data is rejected instead of being silently reseeded', async () => {
  const storage = new MemoryStorage();
  storage.values.set(RELAY_SETTINGS_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, networkRelays: [], lookupRelays: [] }));
  const service = await openRelaySettings(storage);
  assert.deepEqual(service.getSettings(), { networkRelays: [], lookupRelays: [] });

  storage.values.set(RELAY_SETTINGS_STORAGE_KEY, '{bad json');
  await assert.rejects(openRelaySettings(storage), (error: unknown) =>
    error instanceof RelaySettingsError && error.code === 'INVALID_PERSISTED_SETTINGS');
});


test('per-role relay count is bounded', async () => {
  const service = await openRelaySettings(new MemoryStorage());
  for (let index = service.getSettings().networkRelays.length; index < MAX_RELAYS_PER_ROLE; index += 1) {
    await service.addRelay('network', `wss://relay-${index}.example.org`);
  }
  await assert.rejects(service.addRelay('network', 'wss://relay-over-limit.example.org'), (error: unknown) =>
    error instanceof RelaySettingsError && error.code === 'RELAY_LIMIT_EXCEEDED');
});
