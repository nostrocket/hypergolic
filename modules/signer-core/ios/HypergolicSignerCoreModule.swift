import ExpoModulesCore
import ExpoModulesJSI
import HypergolicIdentityOwner
import HypergolicIdentityStore
import Foundation
import UIKit

/// Native vault and signing authority; the disposable trusted-shell tracer stays separately scoped.
public final class HypergolicSignerCoreModule: Module {
  private let binding = EphemeralSignerBinding()
  private let nativeVault = NativeVaultBinding()
  public func definition() -> ModuleDefinition {
    let binding = self.binding
    let nativeVault = self.nativeVault
    Name("HypergolicSignerCore")
    Function("activateEphemeralSigner") { () throws -> Bool in
      try signerResult {
        guard let appContext, NativeIdentityOwnerContext.owns(appContext) else { throw SignerFailure.staleOwner }
        let runtime = try appContext.runtime
        guard runtime.isOnJavaScriptThread() else { throw SignerFailure.staleOwner }
        try JavaScriptActor.assumeIsolated {
          if try binding.activate(appContext) {
            runtime.longLivedObjects.add(EphemeralSignerLifetime(binding: binding))
          }
        }
        return true
      }
    }
    AsyncFunction("generateDisposableIdentityAsync") { () async throws -> String in
      try await signerResult { try await binding.lease().coordinator().generate() }
    }
    AsyncFunction("reviewAndSignDisposableEventAsync") { (json: String) async throws -> String in
      try await signerResult {
        let lease = try binding.lease()
        return try await lease.reviewAndSign(json)
      }
    }
    AsyncFunction("cancelDisposableReviewAsync") { () async throws in
      try await signerResult { await (try binding.lease()).coordinator().cancel() }
    }
    Function("activateNativeVault") { () throws -> Bool in
      try nativeVaultResult {
        guard let appContext, NativeIdentityOwnerContext.owns(appContext) else { throw NativeVaultFailure.stale }
        let runtime = try appContext.runtime
        guard runtime.isOnJavaScriptThread() else { throw NativeVaultFailure.stale }
        try JavaScriptActor.assumeIsolated {
          if try nativeVault.activate(appContext) {
            guard NativeIdentityOwnerContext.registerRevocation(appContext, revoke: { nativeVault.close() }) else {
              nativeVault.close(); throw NativeVaultFailure.stale
            }
            runtime.longLivedObjects.add(NativeVaultLifetime(binding: nativeVault))
          }
        }
        return true
      }
    }
    AsyncFunction("isNativeVaultAvailableAsync") { () throws -> Bool in
      try nativeVaultResult { _ = try nativeVault.lease(); return NativeSignerVaultStorage.isSupportedEnvironment }
    }
    AsyncFunction("openNativeVaultAsync") { () async throws -> String in
      try await nativeVaultResult { try await nativeVault.lease().session().open() }
    }
    AsyncFunction("getNativeSigningMethodsAsync") { (pubkey: String, vaultID: String, revision: Double) async throws -> String in
      try await nativeVaultResult {
        let revision = try nativeVaultRevision(revision); try nativeVaultID(vaultID); try nativeVaultPubkey(pubkey)
        return try await nativeVault.lease().session().methods(pubkey: pubkey, vaultID: vaultID, revision: revision)
      }
    }
    AsyncFunction("prepareNativeRemoteConnectionAsync") { (vaultID: String, revision: Double, attemptID: String) async throws -> String? in
      try await nativeVaultResult {
        let revision = try nativeVaultRevision(revision); try nativeVaultID(vaultID); try nativeVaultAttemptID(attemptID)
        return try await nativeVault.lease().session().prepareRemote(vaultID: vaultID, revision: revision, attemptID: attemptID)
      }
    }
    Function("cancelNativeRemoteConnection") { (handle: String) throws in
      try nativeVaultResult { try nativeVault.lease().cancelRemote(handle) }
    }
    AsyncFunction("commitNativeRemoteConnectionAsync") { (handle: String, vaultID: String, revision: Double) async throws -> String in
      try await nativeVaultResult {
        let revision = try nativeVaultRevision(revision); try nativeVaultID(vaultID)
        return try await nativeVault.lease().session().commitRemote(handle: handle, vaultID: vaultID, revision: revision)
      }
    }
    AsyncFunction("prepareNativeRemoteRefreshAsync") { (pubkey: String, vaultID: String, revision: Double, attemptID: String) async throws -> String? in
      try await nativeVaultResult {
        let revision = try nativeVaultRevision(revision); try nativeVaultID(vaultID); try nativeVaultPubkey(pubkey); try nativeVaultAttemptID(attemptID)
        return try await nativeVault.lease().session().prepareRemoteRefresh(pubkey: pubkey, vaultID: vaultID, revision: revision, attemptID: attemptID)
      }
    }
    Function("cancelNativeRemoteRefresh") { (handle: String) throws in
      try nativeVaultResult { try nativeVault.lease().cancelRemote(handle) }
    }
    AsyncFunction("commitNativeRemoteRefreshAsync") { (handle: String, vaultID: String, revision: Double) async throws -> String in
      try await nativeVaultResult {
        let revision = try nativeVaultRevision(revision); try nativeVaultID(vaultID)
        return try await nativeVault.lease().session().commitRemoteRefresh(handle: handle, vaultID: vaultID, revision: revision)
      }
    }
    AsyncFunction("prepareNativeAndroidSignerAsync") { (_: String, _: Double, _: String) async throws -> String? in
      try await nativeVaultResult { () async throws -> String? in _ = try nativeVault.lease(); throw NativeVaultFailure.signerUnsupported }
    }
    AsyncFunction("commitNativeAndroidSignerAsync") { (_: String, _: String, _: Double) async throws -> String in
      try await nativeVaultResult { () async throws -> String in _ = try nativeVault.lease(); throw NativeVaultFailure.signerUnsupported }
    }
    Function("cancelNativeAndroidSigner") { (_: String) in }
    Function("nativeSigningHandoffState") { (kind: String, token: String) throws -> String? in
      try nativeVaultResult { try nativeVault.lease().handoffs.signingState(kind: kind, token: token) }
    }
    Function("nativeRemotePreparationHandoffState") { (vaultID: String, revision: Double, attemptID: String) throws -> String? in
      guard let revision = try? nativeVaultRevision(revision) else { return nil }
      return try nativeVaultResult { try nativeVault.lease().handoffs.preparationState(vaultID: vaultID, revision: revision, attemptID: attemptID) }
    }
    AsyncFunction("prepareNativeImportAsync") { (vaultID: String, revision: Double) async throws -> String? in
      try await nativeVaultResult {
        let revision = try nativeVaultRevision(revision); try nativeVaultID(vaultID)
        return try await nativeVault.lease().session().prepareImport(vaultID: vaultID, revision: revision)
      }
    }
    Function("cancelNativeImport") { (handle: String) throws in
      try nativeVaultResult { try nativeVault.lease().cancelImport(handle) }
    }
    AsyncFunction("commitNativeImportAsync") { (handle: String, vaultID: String, revision: Double) async throws -> String in
      try await nativeVaultResult {
        let revision = try nativeVaultRevision(revision); try nativeVaultID(vaultID)
        return try await nativeVault.lease().session().commitImport(handle: handle, vaultID: vaultID, revision: revision)
      }
    }
    AsyncFunction("selectNativeIdentityAsync") { (pubkey: String, vaultID: String, revision: Double) async throws -> String in
      try await nativeVaultResult {
        let revision = try nativeVaultRevision(revision); try nativeVaultID(vaultID); try nativeVaultPubkey(pubkey)
        return try await nativeVault.lease().session().select(pubkey: pubkey, vaultID: vaultID, revision: revision)
      }
    }
    AsyncFunction("selectNativeSigningMethodAsync") { (pubkey: String, method: String, vaultID: String, revision: Double) async throws -> String in
      try await nativeVaultResult {
        let revision = try nativeVaultRevision(revision); try nativeVaultID(vaultID); try nativeVaultPubkey(pubkey)
        guard let method = NativeSigningMethod(rawValue: method) else { throw NativeVaultFailure.signerUnsupported }
        return try await nativeVault.lease().session().selectMethod(pubkey: pubkey, method: method, vaultID: vaultID, revision: revision)
      }
    }
    AsyncFunction("disconnectNativeSigningMethodAsync") { (pubkey: String, method: String, vaultID: String, revision: Double) async throws -> String in
      try await nativeVaultResult {
        let revision = try nativeVaultRevision(revision); try nativeVaultID(vaultID); try nativeVaultPubkey(pubkey)
        guard method == "nip46" else { throw NativeVaultFailure.signerUnsupported }
        return try await nativeVault.lease().session().disconnectRemote(pubkey: pubkey, vaultID: vaultID, revision: revision)
      }
    }
    AsyncFunction("deleteNativeLocalKeyAsync") { (pubkey: String, vaultID: String, revision: Double) async throws -> String in
      try await nativeVaultResult {
        let revision = try nativeVaultRevision(revision); try nativeVaultID(vaultID); try nativeVaultPubkey(pubkey)
        return try await nativeVault.lease().session().deleteLocalKey(pubkey: pubkey, vaultID: vaultID, revision: revision)
      }
    }
    AsyncFunction("isNativeVaultAuthenticationAvailableAsync") { () async throws -> Bool in
      try await nativeVaultResult {
        _ = try nativeVault.lease()
        guard NativeSignerVaultStorage.isSupportedEnvironment else { return false }
        return await NativeSignerIdentityActions.isAvailable()
      }
    }
    AsyncFunction("showNativeBackupAsync") { (pubkey: String, vaultID: String, revision: Double) async throws in
      try await nativeVaultResult {
        let revision = try nativeVaultRevision(revision); try nativeVaultID(vaultID); try nativeVaultPubkey(pubkey)
        try await nativeVault.lease().session().backup(pubkey: pubkey, vaultID: vaultID, revision: revision)
      }
    }
    AsyncFunction("deleteNativeIdentityAsync") { (pubkey: String, vaultID: String, revision: Double) async throws -> String in
      try await nativeVaultResult {
        let revision = try nativeVaultRevision(revision); try nativeVaultID(vaultID); try nativeVaultPubkey(pubkey)
        return try await nativeVault.lease().session().delete(pubkey: pubkey, vaultID: vaultID, revision: revision)
      }
    }
    Function("cancelNativeVaultAction") { () throws in
      try nativeVaultResult { try nativeVault.lease().cancelActions() }
    }
    AsyncFunction("reviewAndSignNativeEventAsync") { (kind: String, token: String, json: String, vaultID: String, revision: Double) async throws -> String in
      try await nativeVaultResult {
        let revision = try nativeVaultRevision(revision); try nativeVaultID(vaultID)
        return try await nativeVault.lease().session().reviewAndSign(kind: kind, token: token, unsignedJSON: json, vaultID: vaultID, revision: revision)
      }
    }
    Function("cancelNativeSigning") { (kind: String, token: String) throws in
      try nativeVaultResult { try nativeVault.lease().cancelSigning(kind: kind, token: token) }
    }
    OnDestroy { binding.revoke(); nativeVault.close() }
  }
}

private final class EphemeralSignerBinding: @unchecked Sendable {
  private let lock = NSLock()
  private var value: EphemeralSignerLease?
  private var lifetimeInstalled = false
  /// Explicit activation reuses a live lease, or replaces a revoked disposable key.
  /// Only one runtime lifetime object is installed for this binding.
  func activate(_ context: AppContext) throws -> Bool {
    try lock.withLock {
      guard NativeIdentityOwnerContext.owns(context) else { throw SignerFailure.staleOwner }
      if let value {
        guard value.owns(context) else { throw SignerFailure.staleOwner }
        if value.isCurrent() { return false }
        value.revoke()
      }
      value = EphemeralSignerLease(context: context)
      let attach = !lifetimeInstalled
      lifetimeInstalled = true
      return attach
    }
  }
  func lease() throws -> EphemeralSignerLease {
    try lock.withLock { guard let value, value.isCurrent() else { throw SignerFailure.staleOwner }; return value }
  }
  func revoke() { lock.withLock { value?.revoke() } }
}
private final class EphemeralSignerLease: @unchecked Sendable {
  private weak var context: AppContext?
  private let owner = SignerOwner()
  private let core: NativeSignerCore
  @MainActor private var presenter: NativeSignerReviewCoordinator?
  init(context: AppContext) { self.context = context; core = NativeSignerCore(owner: owner) }
  func owns(_ candidate: AppContext) -> Bool { context === candidate }
  func isCurrent() -> Bool { guard let context else { return false }; return NativeIdentityOwnerContext.owns(context) && !core.isRevoked }
  @MainActor func reviewAndSign(_ json: String) async throws -> String {
    guard isCurrent(), let presenter = context?.utilities?.currentViewController() else { throw SignerFailure.staleOwner }
    return try await coordinator().reviewAndSign(json, presenter: presenter)
  }
  @MainActor func coordinator() -> NativeSignerReviewCoordinator {
    if let presenter { return presenter }
    let created = NativeSignerReviewCoordinator(core: core, owner: owner, current: { [weak self] in self?.isCurrent() == true })
    presenter = created; return created
  }
  func revoke() {
    core.revoke()
    Task { @MainActor [weak self] in self?.presenter?.cancel(revoke: true, failure: .staleOwner) }
  }
}
@JavaScriptActor private final class EphemeralSignerLifetime: LongLivedObject {
  private let binding: EphemeralSignerBinding
  init(binding: EphemeralSignerBinding) { self.binding = binding }
  func allowRelease() { binding.revoke() }
}
private func signerResult<T>(_ operation: () throws -> T) throws -> T {
  do { return try operation() } catch { throw signerException(error) }
}
private func signerResult<T: Sendable>(_ operation: @Sendable () async throws -> T) async throws -> T {
  do { return try await operation() } catch { throw signerException(error) }
}
private func signerException(_ error: any Error) -> Exception {
  let failure = error as? SignerFailure ?? .unavailable
  return Exception(name: "SignerCoreError", description: "Disposable native signing could not be completed.",
    code: "ERR_SIGNER_" + failure.rawValue.uppercased())
}

@JavaScriptActor private final class NativeVaultLifetime: LongLivedObject {
  let binding: NativeVaultBinding
  init(binding: NativeVaultBinding) { self.binding = binding }
  func allowRelease() { binding.close() }
}
private func nativeVaultAttemptID(_ value: String) throws {
  guard !value.isEmpty, value.utf8.count <= 128, value.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95 }) else { throw NativeVaultFailure.denied }
}
private func nativeVaultRevision(_ value: Double) throws -> UInt64 {
  guard value.isFinite, value >= 1, value <= Double(NativeVaultRecord.maximumRevision), value.rounded(.towardZero) == value else { throw NativeVaultFailure.invalidInput }
  return UInt64(value)
}
private func nativeVaultID(_ value: String) throws {
  guard NativeVaultRecord.isID(value) else { throw NativeVaultFailure.invalidInput }
}
private func nativeVaultPubkey(_ value: String) throws {
  guard NativeVaultRecord.isPubkey(value) else { throw NativeVaultFailure.invalidInput }
}
private func nativeVaultResult<T>(_ operation: () throws -> T) throws -> T {
  do { return try operation() } catch { throw nativeVaultException(error) }
}
private func nativeVaultResult<T: Sendable>(_ operation: @Sendable () async throws -> T) async throws -> T {
  do { return try await operation() } catch { throw nativeVaultException(error) }
}
private func nativeVaultException(_ error: any Error) -> Exception {
  let code: String
  if let failure = error as? NativeVaultFailure { code = failure.bridgeCode }
  else if let failure = error as? StoreFailure {
    switch failure {
    case .corruptState: code = "CORRUPT_METADATA"
    case .recoveryRequired, .itemConflict: code = "RECOVERY_REQUIRED"
    case .unauthorized: code = "AUTHORIZATION_DENIED"
    case .invalidInput: code = "INVALID_SECRET"
    case .unavailable: code = "STORAGE_FAILURE"
    }
  } else { code = "STORAGE_FAILURE" }
  return Exception(name: "NativeVaultError", description: "Native identity operation could not be completed.", code: code)
}
