import Foundation
import ExpoModulesCore
import HypergolicNappletHost

/// A single lifetime binding for the actual admitted AppContext. Backgrounding cancels operations;
/// runtime teardown closes authority permanently, rather than resetting the process owner claim.
final class NativeVaultBinding: @unchecked Sendable {
  private let lock = NSLock()
  private var value: NativeVaultLease?
  func activate(_ context: AppContext) throws -> Bool {
    try lock.withLock {
      if let value {
        guard value.authority.owns(context), value.authority.isAlive else { throw NativeVaultFailure.stale }
        return false
      }
      value = NativeVaultLease(context: context); return true
    }
  }
  func lease() throws -> NativeVaultLease {
    let lease = try lock.withLock { guard let value else { throw NativeVaultFailure.stale }; return value }
    guard lease.authority.isOwner() else { throw NativeVaultFailure.stale }; return lease
  }
  func close() { let lease = lock.withLock { value }; lease?.close() }
}
final class NativeVaultLease: @unchecked Sendable {
  let authority: NativeVaultRuntimeAuthority
  let candidates = NativeVaultCandidatePool()
  let remoteCandidates = NativeVaultRemoteCandidates()
  let handoffs = NativeNip46HandoffRegistry()
  private weak var context: AppContext?
  @MainActor private var ui: NativeVaultSession?
  init(context: AppContext) { self.context = context; authority = NativeVaultRuntimeAuthority(context: context) }
  @MainActor func session() throws -> NativeVaultSession {
    guard authority.isOwner(), let context else { throw NativeVaultFailure.stale }
    if let ui { return ui }
    let created = NativeVaultSession(context: context, authority: authority, candidates: candidates, remoteCandidates: remoteCandidates, handoffs: handoffs)
    ui = created; return created
  }
  func cancelImport(_ handle: String) { candidates.cancel(handle, beforeDestroy: { self.authority.invalidateActions() }) }
  func cancelRemote(_ handle: String) { remoteCandidates.cancel(handle, beforeDestroy: { self.authority.invalidateActions() }) }
  func cancelActions() {
    authority.invalidateActions(); handoffs.cancelAll(); candidates.cancelAll(); remoteCandidates.cancelAll()
    Task { @MainActor [weak self] in self?.ui?.cancelAll() }
  }
  func cancelSigning(kind: String, token: String) {
    // Native source revocation completes before the synchronous Expo function returns.
    handoffs.cancelSigning(kind: kind, token: token)
    NativeSigningSourceFacade.cancel(kind: kind, token: token)
    Task { @MainActor [weak self] in self?.ui?.cancelSigning(kind: kind, token: token) }
  }
  func close() {
    authority.close(); handoffs.cancelAll(); candidates.cancelAll(); remoteCandidates.cancelAll()
    Task { @MainActor [weak self] in self?.ui?.cancelAll() }
  }
}
