import type { NativePlatform } from '../security/android-encrypted-secrets.ts';
import type { SQLiteConnection, SQLiteModule } from '../storage/sqlite.ts';
import { openRelaySettings, type RelaySettingsService, type RelaySettingsStoragePort } from './relay-settings.ts';

export const RELAY_SETTINGS_DATABASE = 'hypergolic-relay-settings-v1.db';
const TABLE = 'CREATE TABLE relay_settings (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), storage_key TEXT NOT NULL CHECK (storage_key = \'trusted-relay-settings-v1\'), payload TEXT NOT NULL CHECK (length(payload) <= 140000))';
type Row = { singleton: number; storage_key: string; payload: string };
const failed = (): never => { throw new Error('Relay settings storage is unavailable'); };

/** Dedicated trusted SQLite storage for public relay URLs. It never stores identity secrets. */
export type NativeRelaySettings = RelaySettingsService & Readonly<{ close(): Promise<void> }>;
export async function openNativeRelaySettings(sqlite: SQLiteModule, platform: NativePlatform): Promise<NativeRelaySettings> {
  if (platform !== 'android' && platform !== 'ios') return failed();
  let db: SQLiteConnection;
  try { db = await sqlite.openDatabaseAsync(RELAY_SETTINGS_DATABASE, { useNewConnection: true, enableChangeListener: false }); }
  catch { return failed(); }
  try {
    await db.execAsync('PRAGMA busy_timeout = 1000');
    const journal = await db.getAllAsync<{ journal_mode: string }>('PRAGMA journal_mode = WAL');
    if (journal.length !== 1 || journal[0]!.journal_mode !== 'wal') return failed();
    await db.execAsync('PRAGMA synchronous = FULL');
    const synchronous = await db.getAllAsync<{ synchronous: number }>('PRAGMA synchronous');
    if (synchronous.length !== 1 || synchronous[0]!.synchronous !== 2) return failed();
    if (platform === 'ios') {
      await db.execAsync('PRAGMA fullfsync = ON');
      await db.execAsync('PRAGMA checkpoint_fullfsync = ON');
      const full = await db.getAllAsync<{ fullfsync: number }>('PRAGMA fullfsync');
      const checkpoint = await db.getAllAsync<{ checkpoint_fullfsync: number }>('PRAGMA checkpoint_fullfsync');
      if (full.length !== 1 || full[0]!.fullfsync !== 1 || checkpoint.length !== 1 || checkpoint[0]!.checkpoint_fullfsync !== 1) return failed();
    }
    await db.execAsync('BEGIN IMMEDIATE');
    try {
      const versions = await db.getAllAsync<{ user_version: number }>('PRAGMA user_version');
      const objects = await db.getAllAsync<{ type: string; name: string; sql: string }>("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name");
      if (versions.length !== 1) return failed();
      if (versions[0]!.user_version === 0 && objects.length === 0) {
        await db.execAsync(TABLE);
        await db.execAsync('PRAGMA user_version = 1');
      } else if (versions[0]!.user_version !== 1 || objects.length !== 1 || objects[0]!.type !== 'table' || objects[0]!.name !== 'relay_settings' || objects[0]!.sql !== TABLE) return failed();
      await db.execAsync('COMMIT');
    } catch (error) {
      try { if (await db.isInTransactionAsync()) await db.execAsync('ROLLBACK'); } catch { /* preserve the original storage failure */ }
      throw error;
    }
  } catch (error) {
    try { await db.closeAsync(); } catch { /* preserve the original storage failure */ }
    throw error;
  }
  let closed = false;
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const result = tail.then(() => { if (closed) return failed(); return run(); });
    tail = result.catch(() => undefined);
    return result;
  };
  const storage: RelaySettingsStoragePort = Object.freeze({
    getItem: (key: string) => serial(async () => {
      if (key !== 'trusted-relay-settings-v1') return null;
      const rows = await db.getAllAsync<Row>('SELECT singleton, storage_key, payload FROM relay_settings');
      if (rows.length === 0) return null;
      if (rows.length !== 1 || rows[0]!.singleton !== 1 || rows[0]!.storage_key !== key || typeof rows[0]!.payload !== 'string') return failed();
      return rows[0]!.payload;
    }),
    setItem: (key: string, value: string) => serial(async () => {
      if (key !== 'trusted-relay-settings-v1' || value.length > 140000) return failed();
      await db.execAsync('BEGIN IMMEDIATE');
      try {
        await db.runAsync('INSERT INTO relay_settings (singleton, storage_key, payload) VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET storage_key = excluded.storage_key, payload = excluded.payload', key, value);
        await db.execAsync('COMMIT');
      } catch (error) {
        try { if (await db.isInTransactionAsync()) await db.execAsync('ROLLBACK'); } catch { /* preserve original failure */ }
        throw error;
      }
    }),
  });
  try {
    const service = await openRelaySettings(storage);
    return Object.freeze({ ...service, close: () => serial(async () => { closed = true; await db.closeAsync(); }) });
  }
  catch (error) { closed = true; try { await db.closeAsync(); } catch { /* preserve invalid stored settings */ } throw error; }
}
