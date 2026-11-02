import { VaultError } from './identity-vault-model.ts';
import type { NativeIdentityVault } from './native-identity-vault.ts';

type SettingsContext = Readonly<{ selectedPubkey: string; revision: number }>;
type BackupRequest = SettingsContext & Readonly<{ pubkey: string }>;
export interface IdentitySettingsActions {
  beginSettings(context: SettingsContext): Promise<void>;
  endSettings(): void;
  backgroundSettings(): void;
  cancelDeletion(): void;
  cancelBackup(): void;
  showBackup(request: BackupRequest): Promise<void>;
  isDeletionAvailable(): Promise<boolean>;
  isBackupAvailable(): Promise<boolean>;
  dispose(): void;
}

/** Presentation lifetime only. Native code performs fresh authentication and owns key access. */
export function createNativeIdentityActions(vault: NativeIdentityVault): IdentitySettingsActions {
  let context: SettingsContext | null = null;
  let disposed = false;
  let backup: { context: SettingsContext } | null = null;
  const cancel = () => vault.module.cancelNativeVaultAction();
  const cancelBackup = () => {
    if (!backup) return;
    backup = null; context = null; cancel();
  };
  const endSettings = () => { context = null; backup = null; cancel(); };
  const available = async () => {
    if (disposed) return false;
    try { return await vault.module.isNativeVaultAuthenticationAvailableAsync() === true && !disposed; }
    catch { return false; }
  };
  return Object.freeze<IdentitySettingsActions>({
    async beginSettings(expected) {
      const current = vault.getSnapshot();
      if (disposed || current.selectedPubkey !== expected.selectedPubkey || current.revision !== expected.revision) throw new VaultError('AUTHORIZATION_DENIED');
      endSettings();
      context = Object.freeze({ selectedPubkey: expected.selectedPubkey, revision: expected.revision });
    },
    endSettings,
    backgroundSettings() { context = null; cancelBackup(); },
    cancelDeletion: cancel,
    cancelBackup,
    async showBackup(request) {
      const current = vault.getSnapshot(), captured = context;
      if (disposed || backup || !captured || request.pubkey !== current.selectedPubkey ||
          request.selectedPubkey !== captured.selectedPubkey || request.revision !== captured.revision ||
          current.revision !== captured.revision || current.selectedPubkey !== captured.selectedPubkey) throw new VaultError('AUTHORIZATION_DENIED');
      const operation = { context: captured };
      backup = operation;
      try {
        await vault.module.showNativeBackupAsync(request.pubkey, current.vaultId, current.revision);
        if (disposed || backup !== operation || context !== operation.context) throw new VaultError('AUTHORIZATION_DENIED');
      } finally {
        if (backup === operation) backup = null;
      }
    },
    isDeletionAvailable: available,
    isBackupAvailable: available,
    dispose() { disposed = true; endSettings(); },
  });
}
