import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SQLiteConnection, SQLiteModule } from '../../src/storage/sqlite.ts';
import { openNativeRelaySettings, RELAY_SETTINGS_DATABASE } from '../../src/network/relay-settings-native.ts';

class NodeSQLiteConnection implements SQLiteConnection {
  private readonly database: DatabaseSync;
  constructor(database: DatabaseSync) { this.database = database; }
  async execAsync(sql: string): Promise<void> { this.database.exec(sql); }
  async runAsync(sql: string, ...params: (string | number | null)[]): Promise<{ changes: number }> {
    const result = this.database.prepare(sql).run(...params);
    return { changes: Number(result.changes) };
  }
  async getAllAsync<T>(sql: string, ...params: (string | number | null)[]): Promise<T[]> {
    return this.database.prepare(sql).all(...params) as T[];
  }
  async isInTransactionAsync(): Promise<boolean> { return this.database.isTransaction; }
  async closeAsync(): Promise<void> { this.database.close(); }
}

test('native relay settings survive database close and reopen without reseeding', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'hypergolic-relays-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sqlite: SQLiteModule = { openDatabaseAsync: async name => {
    assert.equal(name, RELAY_SETTINGS_DATABASE);
    return new NodeSQLiteConnection(new DatabaseSync(join(directory, name)));
  } };
  const first = await openNativeRelaySettings(sqlite, 'android');
  const defaults = first.getSettings();
  await first.addRelay('lookup', 'wss://manifest.example.org');
  await first.removeRelay('network', defaults.networkRelays[0]!);
  await first.close();

  const reopened = await openNativeRelaySettings(sqlite, 'android');
  assert.deepEqual(reopened.getSettings(), {
    networkRelays: defaults.networkRelays.slice(1),
    lookupRelays: [...defaults.lookupRelays, 'wss://manifest.example.org'],
  });
  await reopened.close();
});
