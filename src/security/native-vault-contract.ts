import type { VaultSnapshot } from './identity-vault-model.ts';
import type { SigningMethodKind } from './signing-methods.ts';

export type NativeSigningSource = Readonly<{
  kind: 'approval' | 'upload' | 'fixture-manifest' | 'fixture-upload';
  token: string;
}>;
export type NativeSigningHandoffState = 'pending' | 'resumed' | null;
export type NativeImportCandidate = Readonly<{ handle: string; pubkey: string }>;
export type NativeRemoteCandidate = Readonly<{ handle: string; pubkey: string }>;
export type NativeAndroidSignerCandidate = Readonly<{ handle: string; pubkey: string }>;

/** AppContext-bound, public-only Expo surface. Secret entry and approval are native UI. */
export interface NativeVaultModule {
  activateNativeVault(): boolean;
  isNativeVaultAvailableAsync(): Promise<boolean>;
  openNativeVaultAsync(): Promise<string>;
  prepareNativeImportAsync(vaultId: string, revision: number): Promise<string | null>;
  cancelNativeImport(handle: string): void;
  commitNativeImportAsync(handle: string, vaultId: string, revision: number): Promise<string>;
  selectNativeIdentityAsync(pubkey: string, vaultId: string, revision: number): Promise<string>;
  isNativeVaultAuthenticationAvailableAsync(): Promise<boolean>;
  showNativeBackupAsync(pubkey: string, vaultId: string, revision: number): Promise<void>;
  deleteNativeIdentityAsync(pubkey: string, vaultId: string, revision: number): Promise<string>;
  getNativeSigningMethodsAsync(pubkey: string, vaultId: string, revision: number): Promise<string>;
  prepareNativeRemoteConnectionAsync(vaultId: string, revision: number, attemptId: string): Promise<string | null>;
  cancelNativeRemoteConnection(handle: string): void;
  commitNativeRemoteConnectionAsync(handle: string, vaultId: string, revision: number): Promise<string>;
  prepareNativeRemoteRefreshAsync(pubkey: string, vaultId: string, revision: number, attemptId: string): Promise<string | null>;
  cancelNativeRemoteRefresh(handle: string): void;
  commitNativeRemoteRefreshAsync(handle: string, vaultId: string, revision: number): Promise<string>;
  prepareNativeAndroidSignerAsync(vaultId: string, revision: number, attemptId: string): Promise<string | null>;
  cancelNativeAndroidSigner(handle: string): void;
  commitNativeAndroidSignerAsync(handle: string, vaultId: string, revision: number): Promise<string>;
  selectNativeSigningMethodAsync(pubkey: string, method: SigningMethodKind, vaultId: string, revision: number): Promise<string>;
  disconnectNativeSigningMethodAsync(pubkey: string, method: 'nip46' | 'nip55', vaultId: string, revision: number): Promise<string>;
  deleteNativeLocalKeyAsync(pubkey: string, vaultId: string, revision: number): Promise<string>;
  nativeSigningHandoffState(kind: NativeSigningSource['kind'], token: string): NativeSigningHandoffState;
  nativeRemotePreparationHandoffState(vaultId: string, revision: number, attemptId: string): NativeSigningHandoffState;
  cancelNativeVaultAction(): void;
  reviewAndSignNativeEventAsync(kind: NativeSigningSource['kind'], token: string,
    unsignedJSON: string, vaultId: string, revision: number): Promise<string>;
  cancelNativeSigning(kind: NativeSigningSource['kind'], token: string): void;
}

/** Native returns the same public inventory after a durable write and readback. */
export type NativeVaultSnapshot = VaultSnapshot;
