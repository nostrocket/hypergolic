import { publicKey } from './identity-codec.ts';
import { VaultError, type EncryptedSecrets } from './identity-vault.ts';
import type { NativeDeletionTokens } from './ios-encrypted-secrets.ts';

export interface AndroidIdentityDeletionModule { deleteSecretAsync(target: string, token: string): Promise<void> }
/** Final Android effect uses the exact native grant, never SecureStore's unauthenticated delete API. */
export function createAndroidDeletionPort(module: AndroidIdentityDeletionModule, tokens: NativeDeletionTokens): Pick<EncryptedSecrets, 'deleteSecret'> {
  return Object.freeze({ deleteSecret(pubkey, grant) {
    const target = publicKey(pubkey);
    let token: string;
    try {
      grant.assertActive(); token = tokens.consume(grant, target);
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(token)) throw new VaultError('AUTHORIZATION_DENIED');
    } catch { throw new VaultError('AUTHORIZATION_DENIED'); }
    async function erase() {
      try { await module.deleteSecretAsync(target, token); } catch (error) {
        let code: unknown;
        try { if (typeof error === 'object' && error !== null) code = Object.getOwnPropertyDescriptor(error, 'code')?.value; } catch { /* Constant failure below. */ }
        if (code === 'ERR_IDENTITY_ACTION_DENIED') throw new VaultError('AUTHORIZATION_DENIED');
        // A native commit failure or unknown transport outcome cannot be promoted to durable success.
        throw new VaultError('READBACK_FAILED');
      }
    }
    return erase();
  } });
}
