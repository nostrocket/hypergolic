import { requireNativeModule } from 'expo';
import { createIdentityActions, type IdentityActionsModule } from './identity-actions.ts';
import { createAndroidDeletionPort, type AndroidIdentityDeletionModule } from './android-identity-deletion.ts';
import { VaultError } from './identity-vault.ts';

/** Native process admission must already have succeeded in the one trusted bootstrap. */
export function loadIdentityActions(platform: string) {
  if (platform !== 'ios' && platform !== 'android') throw new VaultError('STORAGE_FAILURE');
  let module: IdentityActionsModule & AndroidIdentityDeletionModule;
  try { module = requireNativeModule<IdentityActionsModule & AndroidIdentityDeletionModule>('HypergolicIdentityActions'); }
  catch { throw new VaultError('STORAGE_FAILURE'); }
  const actions = createIdentityActions(module, platform);
  return Object.freeze({ ...actions, androidDeletion: platform === 'android' ? createAndroidDeletionPort(module, actions.tokens) : undefined });
}
