import {routingPayload, routingRecord, routingText} from '../routing/routing-contract.ts';
import {publicKey} from '../storage/codec.ts';
import {ShellStorageError, type TrustedRegistration} from '../storage/ports.ts';
import {CONFIG_LIMITS, type ConfigValues, type ConfigValue} from './config-schema.ts';
/** This service and its scope keys are separate from all identity inventory/nsec slots. */
export const CONFIG_STORE_SERVICE = 'org.nostrocket.hypergolic.napplet-config.v1';
export interface ConfigProtectedOptions {readonly keychainService: string; readonly requireAuthentication: false; readonly keychainAccessible: number}
export interface ConfigSecureStore {
  isAvailableAsync(): Promise<boolean>;
  getItemAsync(key: string, options: ConfigProtectedOptions): Promise<string | null>;
  setItemAsync(key: string, value: string, options: ConfigProtectedOptions): Promise<void>;
}
export type ConfigRecord = Readonly<{format: 1; ordinary: ConfigValues; secrets: Readonly<Record<string, ConfigValue>>}>;
export const EMPTY_CONFIG: ConfigRecord = Object.freeze({format: 1, ordinary: Object.freeze({}), secrets: Object.freeze({})});
export interface ConfigStore {
  read(owner: TrustedRegistration): Promise<ConfigRecord>;
  change(owner: TrustedRegistration, update: (current: ConfigRecord) => ConfigRecord): Promise<ConfigRecord>;
}
function captureRecord(value: unknown): ConfigRecord {
  const row = routingRecord(routingPayload(value), ['format', 'ordinary', 'secrets']);
  if (row.format !== 1) throw new ShellStorageError('CORRUPT_STORAGE');
  routingRecord(row.ordinary, [], Object.keys(row.ordinary as object));
  const secrets = routingRecord(row.secrets, [], Object.keys(row.secrets as object));
  if (Object.keys(secrets).length > CONFIG_LIMITS.properties) throw new ShellStorageError('QUOTA_EXCEEDED');
  for (const [path, secret] of Object.entries(secrets)) {
    let parts: unknown; try {parts = JSON.parse(path);} catch {throw new ShellStorageError('CORRUPT_STORAGE');}
    if (!Array.isArray(parts) || parts.length < 1 || parts.length > CONFIG_LIMITS.depth || parts.some(part => typeof part !== 'string' || part.length < 1 || part.length > 128 || ['__proto__', 'constructor', 'prototype'].includes(part)) || JSON.stringify(parts) !== path || !((typeof secret === 'string' && Array.from(secret).length <= CONFIG_LIMITS.stringLength) || Array.isArray(secret) && secret.length <= CONFIG_LIMITS.items && secret.every(value => typeof value === 'string' && Array.from(value).length <= CONFIG_LIMITS.stringLength))) throw new ShellStorageError('CORRUPT_STORAGE');
  }
  return Object.freeze({format: 1, ordinary: row.ordinary as ConfigValues, secrets: secrets as Readonly<Record<string, ConfigValue>>});
}
/** One encrypted record contains the full config, avoiding a split SQLite/secret commit.
 * The public scope is captured from the attested owner; instance IDs never alter persistence.
 * A native write already entered may finish in its original scope after revocation, but
 * no revoked completion/delivery is reported. Native failure is never success by readback.
 */
export async function openConfigStore(native: ConfigSecureStore, hash: (text: string) => Promise<string>, accessibility: number): Promise<ConfigStore> {
  try {if (!await native.isAvailableAsync()) throw new Error();} catch {throw new ShellStorageError('STORAGE_FAILURE');}
  const options: ConfigProtectedOptions = Object.freeze({keychainService: CONFIG_STORE_SERVICE, requireAuthentication: false, keychainAccessible: accessibility});
  const pending = new Map<string, Promise<unknown>>();
  async function request(owner: TrustedRegistration, update?: (current: ConfigRecord) => ConfigRecord): Promise<ConfigRecord> {
    const user = publicKey(owner.user), publisher = publicKey(owner.publisher), appId = routingText(owner.appId, 1024), version = publicKey(owner.version), assert = owner.assertActive;
    const scope = JSON.stringify([user, publisher, appId, version]);
    const check = () => {if (owner.user !== user || owner.publisher !== publisher || owner.appId !== appId || owner.version !== version || owner.assertActive !== assert) throw new ShellStorageError('REVOKED'); assert();};
    check(); const key = 'scope.' + await hash(scope); check();
    if (!/^scope\.[0-9a-f]{64}$/.test(key)) throw new ShellStorageError('STORAGE_FAILURE');
    if (!pending.has(key) && pending.size >= 64) throw new ShellStorageError('BUSY');
    const previous = pending.get(key) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(async () => {
      check();
      let raw: string | null;
      try {raw = await native.getItemAsync(key, options);} catch {throw new ShellStorageError('STORAGE_FAILURE');}
      check();
      let current: ConfigRecord;
      try {if (raw !== null && (typeof raw !== 'string' || new TextEncoder().encode(raw).length > CONFIG_LIMITS.bytes)) throw new Error(); current = raw === null ? EMPTY_CONFIG : captureRecord(JSON.parse(raw));}
      catch {throw new ShellStorageError('CORRUPT_STORAGE');}
      if (!update) return current;
      const next = captureRecord(update(current)), encoded = JSON.stringify(next);
      if (new TextEncoder().encode(encoded).length > CONFIG_LIMITS.bytes) throw new ShellStorageError('QUOTA_EXCEEDED');
      if (raw === encoded) return next;
      check();
      try {await native.setItemAsync(key, encoded, options);} catch {throw new ShellStorageError('STORAGE_INDETERMINATE');}
      check();
      let verified: string | null;
      try {verified = await native.getItemAsync(key, options);} catch {throw new ShellStorageError('STORAGE_INDETERMINATE');}
      check(); if (verified !== encoded) throw new ShellStorageError('STORAGE_INDETERMINATE');
      return next;
    });
    pending.set(key, work);
    try {return await work;} finally {if (pending.get(key) === work) pending.delete(key);}
  }
  return Object.freeze({read: (owner: TrustedRegistration) => request(owner), change: (owner: TrustedRegistration, update: (current: ConfigRecord) => ConfigRecord) => request(owner, update)});
}
