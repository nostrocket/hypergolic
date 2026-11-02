import { normalizeUploadServer, UploadError } from './upload-contract.ts';
import type { RelaySettingsStoragePort } from '../network/relay-settings.ts';

export const UPLOAD_SETTINGS_KEY = 'trusted-upload-server-v1';
export const DEFAULT_UPLOAD_SERVER = 'https://blossom.nostr.build';
export interface UploadSettings {
  server(): string | null;
  replace(input: string | null): Promise<void>;
  restoreDefault(): Promise<void>;
}
/** One trusted upload destination. Download settings and guest metadata never supply a fallback. */
export async function openUploadSettings(storage: RelaySettingsStoragePort): Promise<UploadSettings> {
  const saved = await storage.getItem(UPLOAD_SETTINGS_KEY);
  let current: string | null;
  if (saved === null) {
    current = normalizeUploadServer(DEFAULT_UPLOAD_SERVER);
    await storage.setItem(UPLOAD_SETTINGS_KEY, JSON.stringify({schema: 1, server: current}));
  } else {
    try {
      const value = JSON.parse(saved);
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 ||
        value.schema !== 1 || !Object.hasOwn(value, 'server')) throw new UploadError('policy denied');
      current = value.server === null ? null : normalizeUploadServer(value.server);
    } catch { throw new UploadError('policy denied'); }
  }
  let writes = Promise.resolve();
  const replace = (input: string | null): Promise<void> => {
    const captured = input === null ? null : normalizeUploadServer(input);
    const write = writes.then(async () => {
      await storage.setItem(UPLOAD_SETTINGS_KEY, JSON.stringify({schema: 1, server: captured})); current = captured;
    });
    writes = write.catch(() => {}); return write;
  };
  return Object.freeze({server: () => current, replace, restoreDefault: () => replace(DEFAULT_UPLOAD_SERVER)});
}
