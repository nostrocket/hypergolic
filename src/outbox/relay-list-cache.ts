import type { NostrEvent } from 'nostr-tools/pure';
import { createConnection, type Access } from '../storage/connection.ts';
import { publicKey, utf8Bytes } from '../storage/codec.ts';
import { configure } from '../storage/schema.ts';
import { fail, sanitize, type SQLiteModule } from '../storage/ports.ts';
import { parseOutboxRelayList, selectOutboxRelayList } from './relay-list.ts';

export const OUTBOX_CACHE_DATABASE = 'hypergolic-outbox-lists-v1.db';
export const OUTBOX_CACHE_LIMITS = Object.freeze({ rows: 128, bytes: 4 * 1024 * 1024, entryBytes: 64 * 1024 });
const TABLE = 'CREATE TABLE relay_lists (user TEXT NOT NULL, author TEXT NOT NULL, fetched_at INTEGER NOT NULL CHECK (fetched_at >= 0), payload TEXT NOT NULL CHECK (length(CAST(payload AS BLOB)) <= 65536), PRIMARY KEY (user, author)) WITHOUT ROWID';
export type OutboxCacheRecord = Readonly<{ fetchedAt: number; event: NostrEvent | null }>;
export interface OutboxRelayListCache {
  read(user: string, author: string, assertActive: () => void, signal: AbortSignal): Promise<OutboxCacheRecord | null>;
  write(user: string, author: string, record: OutboxCacheRecord, assertActive: () => void, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function decode(payload: unknown, author: string): NostrEvent | null {
  if (typeof payload !== 'string' || utf8Bytes(payload) > OUTBOX_CACHE_LIMITS.entryBytes) return fail('CORRUPT_STORAGE');
  try { const event: unknown = JSON.parse(payload); return event === null ? null : parseOutboxRelayList(event, author).event; }
  catch { return fail('CORRUPT_STORAGE'); }
}
async function readRecord(io: Access, user: string, author: string): Promise<OutboxCacheRecord | null> {
  const rows = await io.all<{ fetched_at: number; payload: string }>('SELECT fetched_at, payload FROM relay_lists WHERE user = ? AND author = ?', user, author);
  if (rows.length === 0) return null;
  if (rows.length !== 1 || !integer(rows[0]!.fetched_at)) return fail('CORRUPT_STORAGE');
  return Object.freeze({ fetchedAt: rows[0]!.fetched_at, event: decode(rows[0]!.payload, author) });
}
/** Shell-owned public metadata; both identity and author are namespace keys. */
export async function openOutboxRelayListCache(sqlite: SQLiteModule, platform: 'android' | 'ios'): Promise<OutboxRelayListCache> {
  if (platform !== 'android' && platform !== 'ios') return fail('INVALID_INPUT');
  let db;
  try { db = await sqlite.openDatabaseAsync(OUTBOX_CACHE_DATABASE, { useNewConnection: true, enableChangeListener: false }); }
  catch { return fail('STORAGE_FAILURE'); }
  const connection = createConnection(db);
  try {
    await configure(db, platform);
    await connection.transaction(connection.assertOpen, async io => {
      const [versions, objects] = await Promise.all([
        io.all<{ user_version: number }>('PRAGMA user_version'),
        io.all<{ type: string; name: string; sql: string }>("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name"),
      ]);
      if (versions.length !== 1) return fail('CORRUPT_STORAGE');
      if (versions[0]!.user_version === 0 && objects.length === 0) {
        await db.execAsync(TABLE); await db.execAsync('PRAGMA user_version = 1');
      } else if (versions[0]!.user_version !== 1 || objects.length !== 1 || objects[0]!.type !== 'table' || objects[0]!.name !== 'relay_lists' || objects[0]!.sql !== TABLE) return fail('CORRUPT_STORAGE');
    });
  } catch (error) { await connection.abort(); throw sanitize(error); }
  return Object.freeze({
    async read(userInput: string, authorInput: string, assertActive: () => void, signal: AbortSignal) {
      const user = publicKey(userInput), author = publicKey(authorInput), lease = connection.lease(assertActive);
      try { return await lease.submit({ signal }, check => readRecord(connection.access(check), user, author)); }
      finally { lease.revoke(); }
    },
    async write(userInput: string, authorInput: string, record: OutboxCacheRecord, assertActive: () => void, signal: AbortSignal) {
      const user = publicKey(userInput), author = publicKey(authorInput);
      if (!integer(record.fetchedAt)) return fail('INVALID_INPUT');
      const fetchedAt = record.fetchedAt;
      let candidate: NostrEvent | null;
      try { candidate = record.event === null ? null : parseOutboxRelayList(record.event, author).event; }
      catch { return fail('INVALID_INPUT'); }
      const lease = connection.lease(assertActive);
      try { await lease.submit({ signal }, check => connection.transaction(check, async io => {
        const previous = await readRecord(io, user, author);
        if (previous && fetchedAt < previous.fetchedAt) return fail('INVALID_INPUT');
        // Empty/older replies cannot roll back a known replacement winner.
        const candidates = [previous?.event, candidate].filter((item): item is NostrEvent => item !== null && item !== undefined);
        const event = selectOutboxRelayList(candidates, author)?.event ?? null;
        const payload = JSON.stringify(event), size = utf8Bytes(payload);
        if (size > OUTBOX_CACHE_LIMITS.entryBytes) return fail('QUOTA_EXCEEDED');
        const rows = await io.all<{ user: string; author: string; bytes: number; fetched_at: number }>('SELECT user, author, length(CAST(payload AS BLOB)) AS bytes, fetched_at FROM relay_lists ORDER BY fetched_at, user, author');
        if (rows.length > OUTBOX_CACHE_LIMITS.rows || rows.some(row => !integer(row.bytes) || !integer(row.fetched_at))) return fail('CORRUPT_STORAGE');
        let count = rows.length, bytes = rows.reduce((total, row) => total + row.bytes, 0);
        if (bytes > OUTBOX_CACHE_LIMITS.bytes) return fail('CORRUPT_STORAGE');
        const own = rows.find(row => row.user === user && row.author === author);
        if (own) { count--; bytes -= own.bytes; }
        for (const row of rows) {
          if (count < OUTBOX_CACHE_LIMITS.rows && bytes + size <= OUTBOX_CACHE_LIMITS.bytes) break;
          if (row === own) continue;
          if (await io.run('DELETE FROM relay_lists WHERE user = ? AND author = ?', row.user, row.author) !== 1) return fail('STORAGE_FAILURE');
          count--; bytes -= row.bytes;
        }
        if (count >= OUTBOX_CACHE_LIMITS.rows || bytes + size > OUTBOX_CACHE_LIMITS.bytes) return fail('QUOTA_EXCEEDED');
        if (await io.run('INSERT INTO relay_lists (user, author, fetched_at, payload) VALUES (?, ?, ?, ?) ON CONFLICT(user, author) DO UPDATE SET fetched_at = excluded.fetched_at, payload = excluded.payload', user, author, fetchedAt, payload) !== 1) return fail('STORAGE_FAILURE');
        const saved = await readRecord(io, user, author);
        if (!saved || saved.fetchedAt !== fetchedAt || saved.event?.id !== event?.id) return fail('STORAGE_FAILURE');
      })); } finally { lease.revoke(); }
    },
    close: connection.close,
  });
}
