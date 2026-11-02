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
