import assert from 'node:assert/strict';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { NativeIdentityVault } from '../../src/security/native-identity-vault.ts';
import type { NativeVaultModule } from '../../src/security/native-vault-contract.ts';
import type { EffectAuthority } from '../../src/security/approval-service.ts';
import { captureEventSnapshot } from '../../src/security/event-snapshot.ts';
import { VaultError, type VaultSnapshot } from '../../src/security/identity-vault-model.ts';

// Disposable test data used only by this bridge double, never by the application.
export const secret = new Uint8Array(32).fill(17);
export const pubkey = getPublicKey(secret), second = getPublicKey(new Uint8Array(32).fill(18));
export const first: VaultSnapshot = { vaultId: 'native_vault_test_0001', revision: 1, selectedPubkey: pubkey,
  identities: [{ pubkey, addedAt: 1, origin: 'generated', status: 'active' }], pendingDeletion: null };
export const candidate = { handle: 'native_candidate_test_0001', pubkey: second };
export function harness() {
  let saved = first;
  const calls: string[] = [];
  const module: NativeVaultModule = {
    activateNativeVault: () => true,
    isNativeVaultAvailableAsync: async () => true,
    openNativeVaultAsync: async () => JSON.stringify(saved),
    prepareNativeImportAsync: async () => JSON.stringify(candidate),
    cancelNativeImport: handle => { calls.push(`cancel:${handle}`); },
    commitNativeImportAsync: async () => {
      calls.push('commit');
      saved = { ...saved, revision: saved.revision + 1, selectedPubkey: second,
        identities: [...saved.identities, { pubkey: second, addedAt: 2, origin: 'imported', status: 'active' }] };
      return JSON.stringify(saved);
    },
    selectNativeIdentityAsync: async selected => {
      calls.push('select'); saved = { ...saved, revision: saved.revision + 1, selectedPubkey: selected };
      return JSON.stringify(saved);
    },
    isNativeVaultAuthenticationAvailableAsync: async () => true,
    showNativeBackupAsync: async () => { calls.push('backup'); },
    deleteNativeIdentityAsync: async target => {
      calls.push('delete'); saved = { ...saved, revision: saved.revision + 1, identities: saved.identities.filter(item => item.pubkey !== target) };
      return JSON.stringify(saved);
    },
    getNativeSigningMethodsAsync: async account => JSON.stringify({ vaultId: saved.vaultId, revision: saved.revision,
      pubkey: account, selectedMethod: 'local', methods: [{ kind: 'local' }] }),
    prepareNativeRemoteConnectionAsync: async () => JSON.stringify(candidate),
    cancelNativeRemoteConnection: handle => { calls.push(`cancel-remote:${handle}`); },
    commitNativeRemoteConnectionAsync: async () => { throw new VaultError('SIGNER_UNSUPPORTED'); },
    prepareNativeRemoteRefreshAsync: async () => JSON.stringify({ handle: 'native_refresh_test_0001', pubkey }),
    cancelNativeRemoteRefresh: handle => { calls.push(`cancel-refresh:${handle}`); },
    commitNativeRemoteRefreshAsync: async () => { throw new VaultError('SIGNER_UNSUPPORTED'); },
    prepareNativeAndroidSignerAsync: async () => JSON.stringify(candidate),
    cancelNativeAndroidSigner: handle => { calls.push(`cancel-android:${handle}`); },
    commitNativeAndroidSignerAsync: async () => { throw new VaultError('SIGNER_UNSUPPORTED'); },
    selectNativeSigningMethodAsync: async () => { throw new VaultError('SIGNER_UNSUPPORTED'); },
    disconnectNativeSigningMethodAsync: async () => { throw new VaultError('SIGNER_UNSUPPORTED'); },
    deleteNativeLocalKeyAsync: async () => { throw new VaultError('SIGNER_UNSUPPORTED'); },
    nativeSigningHandoffState: () => null,
    nativeRemotePreparationHandoffState: () => null,
    cancelNativeVaultAction: () => { calls.push('cancel-action'); },
    reviewAndSignNativeEventAsync: async (kind, token, wire, vaultId, revision) => {
      calls.push(`sign:${kind}:${token}`);
      assert.equal(vaultId, saved.vaultId); assert.equal(revision, saved.revision);
      return JSON.stringify(finalizeEvent(JSON.parse(wire), secret));
    },
    cancelNativeSigning: (kind, token) => { calls.push(`cancel-sign:${kind}:${token}`); },
  };
  return { module, calls, vault: new NativeIdentityVault(module) };
}
export const event = captureEventSnapshot({ kind: 1, created_at: 1_790_000_000, tags: [['t', 'native-vault']], content: 'Exact reviewed content' }, pubkey, ['wss://relay.damus.io/']);
export function authority(controller = new AbortController()): EffectAuthority {
  return { signal: controller.signal, assertActive() { if (controller.signal.aborted) throw new VaultError('AUTHORIZATION_DENIED'); },
    nativeSource: { kind: 'approval', token: 'native_source_token_0001' } };
}
