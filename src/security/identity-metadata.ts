import { VaultError, type DatabaseRecord, type MetadataDatabase } from './identity-vault.ts';
import { decodeDatabase, encodeDatabase } from './identity-codec.ts';
import type { NativePlatform } from './android-encrypted-secrets.ts';

import type { SQLiteConnection, SQLiteModule } from '../storage/sqlite.ts';
export type { SQLiteConnection, SQLiteModule } from '../storage/sqlite.ts';
export interface IdentityMetadata extends MetadataDatabase { close(): Promise<void> }
export const IDENTITY_DATABASE = 'hypergolic-identity-v1.db';
const TABLE = 'CREATE TABLE vault_metadata (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), revision INTEGER NOT NULL CHECK (revision >= 0), payload TEXT NOT NULL CHECK (length(payload) <= 8192))';
type Row = { singleton: number; revision: number; payload: string };
const failed = (): never => { throw new VaultError('STORAGE_FAILURE'); };
const corrupt = (): never => { throw new VaultError('CORRUPT_METADATA'); };

async function configureDurability(db: SQLiteConnection, platform: NativePlatform): Promise<void> {
  // Configure the same dedicated connection used for every write. Expo's exclusive helper opens another.
  await db.execAsync('PRAGMA busy_timeout = 1000');
  const journal = await db.getAllAsync<{ journal_mode: string }>('PRAGMA journal_mode = WAL');
  if (journal.length !== 1 || journal[0]!.journal_mode !== 'wal') failed();
  await db.execAsync('PRAGMA synchronous = FULL');
  const synchronous = await db.getAllAsync<{ synchronous: number }>('PRAGMA synchronous');
  if (synchronous.length !== 1 || synchronous[0]!.synchronous !== 2) failed();
  if (platform === 'ios') {
    await db.execAsync('PRAGMA fullfsync = ON');
    await db.execAsync('PRAGMA checkpoint_fullfsync = ON');
    const fsync = await db.getAllAsync<{ fullfsync: number }>('PRAGMA fullfsync');
    if (fsync.length !== 1 || fsync[0]!.fullfsync !== 1) failed();
    const checkpoint = await db.getAllAsync<{ checkpoint_fullfsync: number }>('PRAGMA checkpoint_fullfsync');
    if (checkpoint.length !== 1 || checkpoint[0]!.checkpoint_fullfsync !== 1) failed();
  }
}

export async function openIdentityMetadata(sqlite: SQLiteModule, platform: NativePlatform): Promise<IdentityMetadata> {
  if (platform !== 'android' && platform !== 'ios') return failed();
  let db: SQLiteConnection;
  try { db = await sqlite.openDatabaseAsync(IDENTITY_DATABASE, { useNewConnection: true, enableChangeListener: false }); }
  catch { return failed(); }
  let closed = false;
  let tail: Promise<unknown> = Promise.resolve();
  function checkOpen(): void { if (closed) failed(); }
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const result = tail.then(async () => { checkOpen(); return run(); });
    // A rejected write must not block the core's readback of an uncertain commit.
    tail = result.catch(() => undefined);
    return result;
  }
  async function poison(): Promise<void> {
    closed = true;
    try { await db.closeAsync(); } catch { /* Already poisoned: preserve the original failure, never reuse. */ }
  }
  async function transaction(run: () => Promise<void>): Promise<void> {
    try {
      await db.execAsync('BEGIN IMMEDIATE');
      await run();
      await db.execAsync('COMMIT');
    } catch (error) {
      try { if (await db.isInTransactionAsync()) await db.execAsync('ROLLBACK'); }
      catch { await poison(); }
      throw error instanceof VaultError ? error : new VaultError('STORAGE_FAILURE');
    }
  }
  async function read(): Promise<DatabaseRecord | null> {
    try {
      const rows = await db.getAllAsync<Row>('SELECT singleton, revision, payload FROM vault_metadata');
      if (rows.length === 0) return null;
      if (rows.length !== 1 || rows[0]!.singleton !== 1 || typeof rows[0]!.payload !== 'string') return corrupt();
      const next = decodeDatabase(rows[0]!.payload);
      if (rows[0]!.revision !== next.revision) return corrupt();
      return next;
    } catch (error) { throw error instanceof VaultError ? error : new VaultError('STORAGE_FAILURE'); }
  }
  try {
    await configureDurability(db, platform);
    await transaction(async () => {
      const version = await db.getAllAsync<{ user_version: number }>('PRAGMA user_version');
      if (version.length !== 1) return corrupt();
      const objects = await db.getAllAsync<{ type: string; name: string; sql: string }>("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name");
      if (version[0]!.user_version === 0 && objects.length === 0) {
        await db.execAsync(TABLE);
        await db.execAsync('PRAGMA user_version = 1');
        return;
      }
      if (version[0]!.user_version !== 1 || objects.length !== 1 || objects[0]!.type !== 'table' || objects[0]!.name !== 'vault_metadata' || objects[0]!.sql !== TABLE) return corrupt();
      await read();
    });
  } catch (error) {
    if (!closed) await poison();
    throw error instanceof VaultError ? error : new VaultError('STORAGE_FAILURE');
  }
  return Object.freeze({
    read: () => serial(read),
    compareAndSwap: (expectedRevision: number | null, next: DatabaseRecord) => {
      // Snapshot before queuing: caller mutation cannot change this pending transaction.
      const encoded = encodeDatabase(next), snapshot = decodeDatabase(encoded);
      if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision === Number.MAX_SAFE_INTEGER)
        || snapshot.revision !== (expectedRevision === null ? 0 : expectedRevision + 1)) throw new VaultError('CORRUPT_METADATA');
      return serial(() => transaction(async () => {
        const current = await read();
        if ((current?.revision ?? null) !== expectedRevision) throw new VaultError('READBACK_FAILED');
        const result = expectedRevision === null
          ? await db.runAsync('INSERT INTO vault_metadata (singleton, revision, payload) VALUES (1, ?, ?)', snapshot.revision, encoded)
          : await db.runAsync('UPDATE vault_metadata SET revision = ?, payload = ? WHERE singleton = 1 AND revision = ?', snapshot.revision, encoded, expectedRevision);
        if (result.changes !== 1) throw new VaultError('READBACK_FAILED');
      }));
    },
    close: () => serial(async () => { closed = true; try { await db.closeAsync(); } catch { return failed(); } }),
  });
}
