#if os(iOS)
import Foundation
import Synchronization

/// One process owner. Initialization never reads or creates an identity key, and does not prompt.
/// Trusted runtime activation and UIApplication observation precede all settings authorization.
final class NativeIdentityAuthorizationServices: Sendable {
  let store: IdentityFileStore
  let authority: DeletionGrantAuthority
  @MainActor private var applicationLifecycle: ApplicationIdentityLifecycle?
  private init(store: IdentityFileStore, authority: DeletionGrantAuthority) {
    self.store = store; self.authority = authority
  }
  private static let initialized: Result<NativeIdentityAuthorizationServices, StoreFailure> = {
    do {
      let handle = IdentityStoreHandle()
      let authority = DeletionGrantAuthority(readInventory: {
        guard let store = handle.value.withLock({ $0 }) else { throw StoreFailure.unavailable }
        return try await store.validatedInventory()
      }, authentication: SystemDeviceDeletionAuthentication(),
      backupAuthentication: SystemDeviceBackupAuthentication(),
      backupSecretReader: StoreBackupSecretReader(handle: handle),
      backupPresenter: SystemNativeBackupPresenter())
      let store = IdentityFileStore(keychain: SystemKeychain(), files: try ExcludedAtomicFiles.applicationStore(),
        entropy: SystemEntropy(), authorization: NativeIdentityDeletionAuthority.shared, stateObserver: authority)
      handle.value.withLock { $0 = store }
      try NativeIdentityDeletionAuthority.shared.install(authority)
      return .success(NativeIdentityAuthorizationServices(store: store, authority: authority))
    } catch { return .failure(.unavailable) }
  }()
  static func shared() throws -> NativeIdentityAuthorizationServices { try initialized.get() }
  @MainActor func observeApplication() {
    if applicationLifecycle == nil { applicationLifecycle = ApplicationIdentityLifecycle(authority: authority) }
  }
  /// Trusted activation has checked the process claim and exact native main AppContext.
  /// Attach this private lease to that runtime synchronously before exposing its binding.
  func createClaimedRuntimeLease() throws -> NativeIdentityRuntimeLease {
    try NativeIdentityRuntimeLease(authority: authority)
  }
}

private final class IdentityStoreHandle: Sendable {
  let value = Mutex<IdentityFileStore?>(nil)
}
private final class StoreBackupSecretReader: NativeBackupSecretReader, Sendable {
  let handle: IdentityStoreHandle
  init(handle: IdentityStoreHandle) { self.handle = handle }
  func readBackupSecret(pubkey: String, inventory: NativeVaultInventory) async throws -> Data {
    guard let store = handle.value.withLock({ $0 }) else { throw StoreFailure.unavailable }
    return try await store.readBackupSecret(pubkey: pubkey, inventory: inventory)
  }
}
#endif
