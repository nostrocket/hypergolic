import { VaultError, type VaultSnapshot } from '../../src/security/identity-vault-model.ts';
import type { IdentityVaultPort } from '../../src/security/native-identity-vault.ts';

type Methods = Pick<IdentityVaultPort, 'cancelAction' | 'getSigningMethods' | 'prepareRemoteConnection' | 'cancelRemotePreparation' |
  'isRemotePreparationHandoffPending' | 'cancelRemoteConnection' | 'commitRemoteConnection' | 'prepareRemoteRefresh' | 'cancelRemoteRefresh' | 'commitRemoteRefresh' |
  'prepareAndroidSigner' | 'cancelAndroidSigner' | 'commitAndroidSigner' | 'selectSigningMethod' | 'disconnectSigningMethod' | 'deleteLocalKey'>;
const unavailable = async (): Promise<never> => { throw new VaultError('SIGNER_UNSUPPORTED'); };

/** Public UI fixtures have no saved key or external signing capability. */
export function publicFixtureSigningMethods(snapshot: () => VaultSnapshot): Methods {
  return {
    async getSigningMethods(pubkey) {
      const current = snapshot();
      if (!current.identities.some(identity => identity.pubkey === pubkey)) throw new VaultError('NOT_FOUND');
      return { vaultId: current.vaultId, revision: current.revision, pubkey, selectedMethod: null, methods: [] };
    },
    prepareRemoteConnection: unavailable, commitRemoteConnection: unavailable,
    prepareRemoteRefresh: unavailable, commitRemoteRefresh: unavailable, cancelRemoteRefresh() {},
    prepareAndroidSigner: unavailable, commitAndroidSigner: unavailable, cancelAndroidSigner() {},
    selectSigningMethod: unavailable, disconnectSigningMethod: unavailable, deleteLocalKey: unavailable,
    isRemotePreparationHandoffPending() { return false; },
    cancelAction() {}, cancelRemotePreparation() {}, cancelRemoteConnection() {},
  };
}
