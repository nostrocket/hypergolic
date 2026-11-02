import type { SQLiteModule } from '../storage/sqlite.ts';
import { openResourceSettings, RESOURCE_SETTINGS_KEY, type ResourceSettings } from './resource-settings.ts';
export type NativeResourceSettings = ResourceSettings & { close(): Promise<void> };
/** Dedicated app-only store of public download origins. It is not napplet storage. */
export async function openNativeResourceSettings(sqlite: SQLiteModule): Promise<NativeResourceSettings> {
  const db = await sqlite.openDatabaseAsync('hypergolic-resource-settings-v1.db',{useNewConnection:true,enableChangeListener:false});
  let closed = false;
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const result = tail.then(() => { if (closed) throw Error('Resource settings unavailable'); return run(); });
    tail = result.catch(() => {}); return result;
  };
  try {
    await db.execAsync('PRAGMA busy_timeout = 1000');
    await db.execAsync('CREATE TABLE IF NOT EXISTS resource_settings (storage_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL CHECK(length(payload) <= 40000))');
    const service = await openResourceSettings({
      getItem: key => serial(async () => {
        if (key !== RESOURCE_SETTINGS_KEY) throw Error('Invalid settings key');
        const rows = await db.getAllAsync<{payload:string}>('SELECT payload FROM resource_settings WHERE storage_key = ?',key);
        if (rows.length > 1) throw Error('Invalid settings');
        return rows[0]?.payload ?? null;
      }),
      setItem: (key, payload) => serial(async () => {
        if (key !== RESOURCE_SETTINGS_KEY || payload.length > 40000) throw Error('Invalid settings');
        await db.runAsync('INSERT INTO resource_settings (storage_key,payload) VALUES (?,?) ON CONFLICT(storage_key) DO UPDATE SET payload = excluded.payload',key,payload);
      }),
    });
    return Object.freeze({...service,close:() => serial(async () => {closed=true;await db.closeAsync();})});
  } catch(error) {try {await db.closeAsync();} catch { /* Preserve the settings failure. */ } throw error;}
}
