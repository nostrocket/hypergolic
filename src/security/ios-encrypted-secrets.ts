import { IdentityDeviceRequired } from './identity-device-required.ts';
import { VaultError, type DeletionGrant, type EncryptedSecrets, type VaultErrorCode } from './identity-vault.ts';
import { decodeInventory, decodeSecret, decodeStage, encodeInventory, encodeSecret, encodeStage, publicKey } from './identity-codec.ts';

/** Exact positional Expo contract. No service/path/crypto/key-reset/debug parameters exist. */
export interface IdentityStoreModule {
  isAvailableAsync(): Promise<boolean>;
  readInventoryAsync(): Promise<string | null>;
  writeInventoryAsync(value: string): Promise<void>;
  readStageAsync(): Promise<string | null>;
  writeStageAsync(value: string): Promise<void>;
  deleteStageAsync(): Promise<void>;
  readSecretAsync(pubkey: string): Promise<string | null>;
  writeSecretAsync(pubkey: string, value: string): Promise<void>;
  deleteSecretAsync(pubkey: string, token: string): Promise<void>;
}

/** Supplied by trusted identity-actions: private grant-object binding to a native-authenticated token.
 * Consume only the token belonging to this exact grant and target. No mutable latest-grant fallback.
 * The native action owner independently consumes/rechecks that token immediately before file erase.
 */
export interface NativeDeletionTokens {
  consume(grant: DeletionGrant, targetPubkey: string): string;
}
const errorCodes = new Map<string, VaultErrorCode>([
  ['ERR_IDENTITY_STORE_UNAVAILABLE', 'STORAGE_FAILURE'],
  ['ERR_IDENTITY_STORE_CORRUPT', 'RECOVERY_REQUIRED'],
  ['ERR_IDENTITY_STORE_RECOVERY_REQUIRED', 'RECOVERY_REQUIRED'],
  ['ERR_IDENTITY_STORE_INVALID_INPUT', 'CORRUPT_METADATA'],
  ['ERR_IDENTITY_STORE_CONFLICT', 'RECOVERY_REQUIRED'],
  ['ERR_IDENTITY_STORE_UNAUTHORIZED', 'AUTHORIZATION_DENIED'],
]);
function nativeFailure(error: unknown): never {
  let code: unknown;
  // Avoid calling a native/proxy error getter or retaining its message, stack or cause.
  try { if (typeof error === 'object' && error !== null) code = Object.getOwnPropertyDescriptor(error, 'code')?.value; }
  catch { throw new VaultError('STORAGE_FAILURE'); }
  throw new VaultError(typeof code === 'string' ? errorCodes.get(code) ?? 'STORAGE_FAILURE' : 'STORAGE_FAILURE');
}
async function nativeCall<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) { return nativeFailure(error); }
}

/** Create once with the whole-shell vault owner. No SecureStore fallback on iOS failure. */
export async function createIOSEncryptedSecrets(module: IdentityStoreModule, platform: string, tokens: NativeDeletionTokens): Promise<EncryptedSecrets> {
  if (platform !== 'ios') throw new VaultError('STORAGE_FAILURE');
  const available = await nativeCall(() => module.isAvailableAsync());
  if (available === false) throw new IdentityDeviceRequired();
  if (available !== true) throw new VaultError('STORAGE_FAILURE');
  async function read<T>(operation: () => Promise<string | null>, decode: (text: string) => T): Promise<T | null> {
    const value = await nativeCall(operation);
    return value === null ? null : decode(value);
  }
  async function erase(key: string, token: string): Promise<void> {
    try { await nativeCall(() => module.deleteSecretAsync(key, token)); } catch (error) {
      if (error instanceof VaultError && error.code === 'AUTHORIZATION_DENIED') throw error;
      // Native unlink/flush or transport failure cannot be promoted to durable success by a later absence read.
      throw new VaultError('READBACK_FAILED');
    }
  }
  const adapter: EncryptedSecrets = {
    readInventory: () => read(() => module.readInventoryAsync(), decodeInventory),
    writeInventory: value => {
      const encoded = encodeInventory(value);
      return nativeCall(() => module.writeInventoryAsync(encoded));
    },
    readStage: () => read(() => module.readStageAsync(), decodeStage),
    writeStage: value => {
      const encoded = encodeStage(value);
      return nativeCall(() => module.writeStageAsync(encoded));
    },
    deleteStage: () => nativeCall(() => module.deleteStageAsync()),
    readSecret: pubkey => {
      const key = publicKey(pubkey);
      return read(() => module.readSecretAsync(key), text => decodeSecret(text, key));
    },
    writeSecret: (pubkey, value) => {
      const key = publicKey(pubkey), encoded = encodeSecret(value);
      if (key !== value.pubkey) throw new VaultError('INVALID_SECRET');
      return nativeCall(() => module.writeSecretAsync(key, encoded));
    },
    deleteSecret: (pubkey, grant) => {
      const key = publicKey(pubkey);
      let token: string;
      try {
        grant.assertActive();
        token = tokens.consume(grant, key);
        if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(token)) throw new VaultError('AUTHORIZATION_DENIED');
      } catch { throw new VaultError('AUTHORIZATION_DENIED'); }
      // This invokes the bridge synchronously before the first await. Token belongs to this grant.
      return erase(key, token);
    },
  };
  return Object.freeze(adapter);
}
