import { publicResourceHttps, ResourceError } from './resource-contract.ts';
import type { RelaySettingsStoragePort } from '../network/relay-settings.ts';
export const RESOURCE_SETTINGS_KEY = 'trusted-resource-servers-v1';
export const DEFAULT_RESOURCE_SERVERS = Object.freeze(['https://blossom.primal.net', 'https://cdn.satellite.earth']);
export function normalizeResourceServers(input: unknown): readonly string[] {
  if (!Array.isArray(input) || input.length > 4) throw new ResourceError('blocked-by-policy');
  const servers = input.map(value => {
    if (typeof value !== 'string') throw new ResourceError('blocked-by-policy');
    const url = new URL(publicResourceHttps(value));
    if (url.pathname !== '/' || url.search !== '') throw new ResourceError('blocked-by-policy');
    return url.origin;
  });
  if (new Set(servers).size !== servers.length) throw new ResourceError('invalid-request');
  return Object.freeze(servers);
}
export interface ResourceSettings {
  servers(): readonly string[];
  replace(input: readonly string[]): Promise<void>;
  restoreDefaults(): Promise<void>;
}
/** Trusted app settings. Empty lists disable Blossom; no resource request can add a server. */
export async function openResourceSettings(storage: RelaySettingsStoragePort): Promise<ResourceSettings> {
  const saved = await storage.getItem(RESOURCE_SETTINGS_KEY);
  let current: readonly string[];
  if (saved === null) {
    current = normalizeResourceServers(DEFAULT_RESOURCE_SERVERS);
    await storage.setItem(RESOURCE_SETTINGS_KEY, JSON.stringify({ schema: 1, servers: current }));
  } else {
    const record = JSON.parse(saved);
    if (!record || Object.keys(record).length !== 2 || record.schema !== 1) throw new ResourceError('blocked-by-policy');
    current = normalizeResourceServers(record.servers);
  }
  let writes = Promise.resolve();
  const replace = (input: readonly string[]): Promise<void> => {
    const normalized = normalizeResourceServers(input);
    const operation = writes.then(async () => {
      await storage.setItem(RESOURCE_SETTINGS_KEY, JSON.stringify({schema:1,servers:normalized})); current = normalized;
    });
    writes = operation.catch(() => {}); return operation;
  };
  return Object.freeze({servers:() => Object.freeze([...current]), replace, restoreDefaults:() => replace(DEFAULT_RESOURCE_SERVERS)});
}
