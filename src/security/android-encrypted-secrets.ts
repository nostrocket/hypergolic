import { VaultError, type EncryptedSecrets, type Inventory } from './identity-vault.ts';
import { decodeInventory, decodeSecret, decodeStage, encodeInventory, encodeSecret, encodeStage, publicKey } from './identity-codec.ts';

export type NativePlatform = 'android' | 'ios';
export type ProtectedOptions = Readonly<{ keychainService: string; requireAuthentication: false }>;
/** Android runtime subset, checked against Expo SecureStore 57.0.3 source and declarations. */
export interface SecureStoreModule {
  isAvailableAsync(): Promise<boolean>;
  getItemAsync(key: string, options?: ProtectedOptions): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: ProtectedOptions): Promise<void>;
  deleteItemAsync(key: string, options?: ProtectedOptions): Promise<void>;
}
export const VAULT_SERVICE = 'org.nostrocket.hypergolic.identity.v1';
export const INVENTORY_KEY = 'inventory';
export const STAGE_KEY = 'stage';
export function secretStorageKey(pubkey: string): string { return `secret.${publicKey(pubkey)}`; }

function storageFailure(error: unknown): never {
  // Do not retain raw native messages/cause: they may contain keys or the supplied value.
  throw error instanceof VaultError ? error : new VaultError('STORAGE_FAILURE');
}
/** Android only. iOS uses the backup-excluded native encrypted file store. */
export async function createProtectedSecrets(module: SecureStoreModule, platform: NativePlatform, deletion?: Pick<EncryptedSecrets, 'deleteSecret'>): Promise<EncryptedSecrets> {
  if (platform !== 'android') throw new VaultError('STORAGE_FAILURE');
  try {
    if (!await module.isAvailableAsync()) throw new VaultError('STORAGE_FAILURE');
  } catch (error) { storageFailure(error); }
  const options: ProtectedOptions = Object.freeze({ keychainService: VAULT_SERVICE, requireAuthentication: false });
  async function read<T>(key: string, decode: (text: string) => T): Promise<T | null> {
    try {
      const text = await module.getItemAsync(key, options);
      return text === null ? null : decode(text);
    } catch (error) { return storageFailure(error); }
  }
  async function writeOnce(key: string, encoded: string): Promise<void> {
    try {
      const existing = await module.getItemAsync(key, options);
      if (existing === encoded) return;
      if (existing !== null) throw new VaultError('RECOVERY_REQUIRED');
      await module.setItemAsync(key, encoded, options);
    } catch (error) { storageFailure(error); }
  }
  async function writeInventory(value: Inventory): Promise<void> {
    const encoded = encodeInventory(value), next = decodeInventory(encoded);
    try {
      const existing = await module.getItemAsync(INVENTORY_KEY, options);
      if (existing === encoded) return;
      if (existing !== null) {
        const previous = decodeInventory(existing);
        // Journal recovery may restore the prior selection at the prepared receipt's same revision.
        if (previous.vaultId !== next.vaultId || previous.revision > next.revision) throw new VaultError('RECOVERY_REQUIRED');
      }
      await module.setItemAsync(INVENTORY_KEY, encoded, options);
    } catch (error) { storageFailure(error); }
  }
  async function remove(key: string): Promise<void> {
    // Deliberately no awaited preflight between the core's grant recheck and this native call.
    try { await module.deleteItemAsync(key, options); } catch (error) { storageFailure(error); }
  }
  const adapter: EncryptedSecrets = {
    readInventory: () => read(INVENTORY_KEY, decodeInventory), writeInventory,
    readStage: () => read(STAGE_KEY, decodeStage), writeStage: value => writeOnce(STAGE_KEY, encodeStage(value)),
    deleteStage: () => remove(STAGE_KEY),
    readSecret: pubkey => read(secretStorageKey(pubkey), text => decodeSecret(text, pubkey)),
    writeSecret: (pubkey, value) => {
      const encoded = encodeSecret(value);
      if (publicKey(pubkey) !== value.pubkey) throw new VaultError('INVALID_SECRET');
      return writeOnce(secretStorageKey(pubkey), encoded);
    },
    deleteSecret: (pubkey, grant) => {
      const key = publicKey(pubkey);
      if (!deletion) throw new VaultError('AUTHORIZATION_DENIED');
      try { grant.assertActive(); } catch { throw new VaultError('AUTHORIZATION_DENIED'); }
      return deletion.deleteSecret(key, grant);
    },
  };
  return Object.freeze(adapter);
}
