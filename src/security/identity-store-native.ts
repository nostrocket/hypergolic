import { requireNativeModule } from 'expo';
import { createIOSEncryptedSecrets, type IdentityStoreModule, type NativeDeletionTokens } from './ios-encrypted-secrets.ts';
import { VaultError, type EncryptedSecrets } from './identity-vault.ts';

/** The app's single vault composition root calls this only for iOS. Module lookup failure is fatal. */
export function loadIOSIdentitySecrets(platform: string, tokens: NativeDeletionTokens): Promise<EncryptedSecrets> {
  if (platform !== 'ios') return Promise.reject(new VaultError('STORAGE_FAILURE'));
  let module: IdentityStoreModule;
  try { module = requireNativeModule<IdentityStoreModule>('HypergolicIdentityStore'); }
  catch { return Promise.reject(new VaultError('STORAGE_FAILURE')); }
  return createIOSEncryptedSecrets(module, platform, tokens);
}
