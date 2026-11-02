import { createConnection, type Access } from '../storage/connection.ts';
import { publicKey } from '../storage/codec.ts';
import { configure } from '../storage/schema.ts';
import { fail, type SQLiteModule, type TrustedApp, type TrustedUser } from '../storage/ports.ts';
import { routingText } from '../routing/routing-contract.ts';
const TABLE = 'CREATE TABLE notify_permissions (user TEXT NOT NULL, publisher TEXT NOT NULL, app_id TEXT NOT NULL, channel TEXT NOT NULL, PRIMARY KEY (user, publisher, app_id, channel)) WITHOUT ROWID';
export type NotifyPermission = Readonly<{publisher: string; appId: string; channel: string}>;
export interface NotifyPermissions {
  has(owner: TrustedApp, channel: string): Promise<boolean>;
  grant(owner: TrustedApp, channel: string): Promise<void>;
  list(owner: TrustedUser): Promise<readonly NotifyPermission[]>;
  revoke(owner: TrustedApp, channel: string): Promise<void>;
  close(): Promise<void>;
}
export async function openNotifyPermissions(sqlite: SQLiteModule, platform: 'android' | 'ios'): Promise<NotifyPermissions> {
  const db = await sqlite.openDatabaseAsync('hypergolic-notify-v1.db', {useNewConnection: true, enableChangeListener: false}); const connection = createConnection(db);
  try {
    await configure(db, platform);
    await connection.transaction(() => connection.assertOpen(), async io => {
      const [version, initialRows] = await Promise.all([io.all<{user_version: number}>('PRAGMA user_version'), io.all<{name: string; type: string; sql: string}>("SELECT name, type, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name")]); let rows = initialRows;
      if (version.length !== 1) fail('CORRUPT_STORAGE');
      if (version[0]!.user_version === 0 && rows.length === 0) { await io.run(TABLE); await io.run('PRAGMA user_version = 1'); rows = await io.all("SELECT name, type, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name"); }
      else if (version[0]!.user_version !== 1) fail('CORRUPT_STORAGE');
      if (rows.length !== 1 || rows[0]!.name !== 'notify_permissions' || rows[0]!.type !== 'table' || rows[0]!.sql !== TABLE) fail('CORRUPT_STORAGE');
    });
  } catch (error) { await connection.abort(); throw error; }
  async function request<T>(owner: TrustedUser, action: (io: Access, user: string) => Promise<T>): Promise<T> {
    const user = publicKey(owner.user), assertActive = owner.assertActive;
    const lease = connection.lease(() => { if (owner.user !== user || owner.assertActive !== assertActive) fail('REVOKED'); assertActive(); });
    try { return await lease.submit(undefined, check => connection.transaction(check, io => action(io, user))); } finally { lease.revoke(); }
  }
  function scope(owner: TrustedApp, input: string) { return {publisher: publicKey(owner.publisher), appId: routingText(owner.appId, 1024), channel: input === '' ? '' : routingText(input, 128)}; }
  return Object.freeze({
    has: (owner: TrustedApp, channel: string) => { const key = scope(owner, channel); return request(owner, async (io, user) => (await io.all('SELECT 1 FROM notify_permissions WHERE user = ? AND publisher = ? AND app_id = ? AND channel = ?', user, key.publisher, key.appId, key.channel)).length === 1); },
    grant: (owner: TrustedApp, channel: string) => { const key = scope(owner, channel); return request(owner, async (io, user) => {
      const rows = await io.all<{total: number; own: number}>('SELECT COUNT(*) AS total, COUNT(CASE WHEN user = ? THEN 1 END) AS own FROM notify_permissions', user);
      const count = rows[0]; if (rows.length !== 1 || !count || !Number.isSafeInteger(count.total) || !Number.isSafeInteger(count.own) || count.total < 0 || count.own < 0 || count.total > 4096 || count.own > 1024) fail('CORRUPT_STORAGE');
      const exists = await io.all('SELECT 1 FROM notify_permissions WHERE user = ? AND publisher = ? AND app_id = ? AND channel = ?', user, key.publisher, key.appId, key.channel);
      if (!exists.length && (count.total >= 4096 || count.own >= 1024)) fail('QUOTA_EXCEEDED');
      await io.run('INSERT INTO notify_permissions (user, publisher, app_id, channel) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', user, key.publisher, key.appId, key.channel);
      if ((await io.all('SELECT 1 FROM notify_permissions WHERE user = ? AND publisher = ? AND app_id = ? AND channel = ?', user, key.publisher, key.appId, key.channel)).length !== 1) fail('STORAGE_FAILURE');
    }); },
    list: (owner: TrustedUser) => request(owner, async (io, user) => {
      const rows = await io.all<{publisher: string; app_id: string; channel: string}>('SELECT publisher, app_id, channel FROM notify_permissions WHERE user = ? ORDER BY publisher, app_id, channel', user); if (rows.length > 1024) fail('CORRUPT_STORAGE');
      return Object.freeze(rows.map(row => Object.freeze({publisher: publicKey(row.publisher), appId: routingText(row.app_id, 1024), channel: row.channel === '' ? '' : routingText(row.channel, 128)})));
    }),
    revoke: (owner: TrustedApp, channel: string) => { const key = scope(owner, channel); return request(owner, async (io, user) => { await io.run('DELETE FROM notify_permissions WHERE user = ? AND publisher = ? AND app_id = ? AND channel = ?', user, key.publisher, key.appId, key.channel); }); },
    close: () => connection.close(),
  });
}
