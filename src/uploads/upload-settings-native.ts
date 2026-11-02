import type { SQLiteModule } from '../storage/sqlite.ts';
import { openUploadSettings, UPLOAD_SETTINGS_KEY, type UploadSettings } from './upload-settings.ts';
export interface UploadConfigurationModule { configureUploadServer(server: string | null): void }
export type NativeUploadSettings = UploadSettings & { close(): Promise<void> };
/** App-only persistence and native configuration. A changed setting affects new captures only. */
export async function openNativeUploadSettings(sqlite: SQLiteModule, native: UploadConfigurationModule): Promise<NativeUploadSettings> {
  native.configureUploadServer(null);
  const db = await sqlite.openDatabaseAsync('hypergolic-upload-settings-v1.db', {useNewConnection: true, enableChangeListener: false});
  let closed = false, enabled = false;
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const task = tail.then(() => { if (closed) throw Error('Upload settings unavailable'); return run(); });
    tail = task.catch(() => {}); return task;
  };
  try {
    await db.execAsync('PRAGMA busy_timeout = 1000');
    await db.execAsync('CREATE TABLE IF NOT EXISTS upload_settings (storage_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL CHECK(length(payload) <= 4096))');
    const service = await openUploadSettings({
      getItem: async key => {
        if (key !== UPLOAD_SETTINGS_KEY) throw Error('Invalid settings key');
        const rows = await db.getAllAsync<{payload: string}>('SELECT payload FROM upload_settings WHERE storage_key = ?', key);
        if (rows.length > 1) throw Error('Invalid settings');
        return rows[0]?.payload ?? null;
      },
      setItem: async (key, payload) => {
        if (key !== UPLOAD_SETTINGS_KEY || new TextEncoder().encode(payload).length > 4096) throw Error('Invalid settings');
        await db.runAsync('INSERT INTO upload_settings (storage_key,payload) VALUES (?,?) ON CONFLICT(storage_key) DO UPDATE SET payload = excluded.payload', key, payload);
      },
    });
    native.configureUploadServer(service.server()); enabled = true;
    const update = (persist: () => Promise<void>): Promise<void> => serial(async () => {
      await persist();
      try { native.configureUploadServer(service.server()); enabled = true; }
      catch (error) { enabled = false; try { native.configureUploadServer(null); } catch { /* Keep admission unavailable. */ } throw error; }
    });
    return Object.freeze({server: () => closed || !enabled ? null : service.server(),
      replace: (input: string | null) => update(() => service.replace(input)), restoreDefault: () => update(service.restoreDefault),
      close: () => serial(async () => { closed = true; try {native.configureUploadServer(null);} finally {await db.closeAsync();} }),
    });
  } catch (error) {
    try { native.configureUploadServer(null); } catch { /* Preserve startup failure. */ }
    try { await db.closeAsync(); } catch { /* Preserve startup failure. */ }
    throw error;
  }
}
