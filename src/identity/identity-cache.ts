import type { NostrEvent } from 'nostr-tools/pure';
import { createConnection } from '../storage/connection.ts';
import { publicKey, utf8Bytes } from '../storage/codec.ts';
import { configure } from '../storage/schema.ts';
import { fail, type SQLiteModule } from '../storage/ports.ts';
import { IDENTITY_CACHE_KEYS, IDENTITY_LIMITS, type IdentityCacheKey } from './identity-contract.ts';

export const IDENTITY_DATA_DATABASE = 'hypergolic-public-identity-v1.db';
const TABLE = 'CREATE TABLE identity_cache (user TEXT NOT NULL, cache_key TEXT NOT NULL, fetched_at INTEGER NOT NULL CHECK (fetched_at >= 0), payload TEXT NOT NULL CHECK (length(CAST(payload AS BLOB)) <= 262144), PRIMARY KEY (user, cache_key)) WITHOUT ROWID';
export type IdentityCacheRecord = Readonly<{ fetchedAt: number; events: readonly NostrEvent[] }>;
export interface IdentityCache {
  read(user: string, key: IdentityCacheKey, assertActive: () => void, signal: AbortSignal): Promise<IdentityCacheRecord | null>;
  write(user: string, key: IdentityCacheKey, record: IdentityCacheRecord, assertActive: () => void, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function cacheKey(key: IdentityCacheKey): string {
  if (!IDENTITY_CACHE_KEYS.includes(key)) return fail('INVALID_INPUT');
  return key;
}
/** App-only public signed source cache. It shares no table or allowance with guest storage. */
export async function openIdentityCache(sqlite: SQLiteModule, platform: 'android' | 'ios'): Promise<IdentityCache> {
  if (platform !== 'android' && platform !== 'ios') return fail('INVALID_INPUT');
  const db = await sqlite.openDatabaseAsync(IDENTITY_DATA_DATABASE, { useNewConnection: true, enableChangeListener: false });
  const connection = createConnection(db);
  try {
    await configure(db, platform);
    await connection.transaction(() => connection.assertOpen(), async io => {
      const [versions, objects] = await Promise.all([
        io.all<{ user_version: number }>('PRAGMA user_version'),
        io.all<{ type: string; name: string; sql: string }>("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name"),
      ]);
      if (versions.length !== 1) return fail('CORRUPT_STORAGE');
      if (versions[0]!.user_version === 0 && objects.length === 0) {
        await db.execAsync(TABLE); await db.execAsync('PRAGMA user_version = 1');
      } else if (versions[0]!.user_version !== 1 || objects.length !== 1 || objects[0]!.type !== 'table' || objects[0]!.name !== 'identity_cache' || objects[0]!.sql !== TABLE) return fail('CORRUPT_STORAGE');
    });
  } catch (error) { await connection.abort(); throw error; }
  return Object.freeze({
    async read(input: string, inputKey: IdentityCacheKey, assertActive: () => void, signal: AbortSignal) {
      const user = publicKey(input), key = cacheKey(inputKey), lease = connection.lease(assertActive);
      try { return await lease.submit({ signal }, async check => {
        const rows = await connection.access(check).all<{ fetched_at: number; payload: string }>('SELECT fetched_at, payload FROM identity_cache WHERE user = ? AND cache_key = ?', user, key);
        if (rows.length === 0) return null;
        if (rows.length !== 1 || !integer(rows[0]!.fetched_at) || typeof rows[0]!.payload !== 'string' || utf8Bytes(rows[0]!.payload) > IDENTITY_LIMITS.bundleBytes) return fail('CORRUPT_STORAGE');
        let events: unknown;
        try { events = JSON.parse(rows[0]!.payload); } catch { return fail('CORRUPT_STORAGE'); }
        if (!Array.isArray(events) || events.length > 32) return fail('CORRUPT_STORAGE');
        return Object.freeze({ fetchedAt: rows[0]!.fetched_at, events: events as NostrEvent[] });
      }); } finally { lease.revoke(); }
    },
    async write(input: string, inputKey: IdentityCacheKey, record: IdentityCacheRecord, assertActive: () => void, signal: AbortSignal) {
      const user = publicKey(input), key = cacheKey(inputKey);
      if (!integer(record.fetchedAt) || !Array.isArray(record.events) || record.events.length > 32) return fail('INVALID_INPUT');
      const payload = JSON.stringify(record.events), size = utf8Bytes(payload);
      if (size > IDENTITY_LIMITS.bundleBytes) return fail('QUOTA_EXCEEDED');
      const lease = connection.lease(assertActive);
      try { await lease.submit({ signal }, check => connection.transaction(check, async io => {
        const rows = await io.all<{ user: string; cache_key: string; bytes: number; fetched_at: number }>('SELECT user, cache_key, length(CAST(payload AS BLOB)) AS bytes, fetched_at FROM identity_cache ORDER BY fetched_at, user, cache_key');
        if (rows.length > IDENTITY_LIMITS.cacheRows || rows.some(row => !integer(row.bytes) || !integer(row.fetched_at))) return fail('CORRUPT_STORAGE');
        let count = rows.length, bytes = rows.reduce((total, row) => total + row.bytes, 0);
        if (bytes > IDENTITY_LIMITS.cacheBytes) return fail('CORRUPT_STORAGE');
        const previous = rows.find(row => row.user === user && row.cache_key === key);
        if (previous) { count--; bytes -= previous.bytes; }
        for (const row of rows) {
          if (count < IDENTITY_LIMITS.cacheRows && bytes + size <= IDENTITY_LIMITS.cacheBytes) break;
          if (row === previous) continue;
          if (await io.run('DELETE FROM identity_cache WHERE user = ? AND cache_key = ?', row.user, row.cache_key) !== 1) return fail('STORAGE_FAILURE');
          count--; bytes -= row.bytes;
        }
        if (count >= IDENTITY_LIMITS.cacheRows || bytes + size > IDENTITY_LIMITS.cacheBytes) return fail('QUOTA_EXCEEDED');
        if (await io.run('INSERT INTO identity_cache (user, cache_key, fetched_at, payload) VALUES (?, ?, ?, ?) ON CONFLICT(user, cache_key) DO UPDATE SET fetched_at = excluded.fetched_at, payload = excluded.payload', user, key, record.fetchedAt, payload) !== 1) return fail('STORAGE_FAILURE');
        const saved = await io.all<{ fetched_at: number; payload: string }>('SELECT fetched_at, payload FROM identity_cache WHERE user = ? AND cache_key = ?', user, key);
        if (saved.length !== 1 || saved[0]!.fetched_at !== record.fetchedAt || saved[0]!.payload !== payload) return fail('STORAGE_FAILURE');
      })); } finally { lease.revoke(); }
    },
    close: () => connection.close(),
  });
}
