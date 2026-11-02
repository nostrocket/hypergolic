import Foundation
import Synchronization
import ExpoModulesCore
import HypergolicIdentityOwner
import HypergolicIdentityStore

/// Runtime admission is the actual native object. No bridge field supplies its identity or epoch.
final class NativeVaultRuntimeAuthority: @unchecked Sendable {
  private weak var context: AppContext?
  private let gate = NativeVaultMutationGate()
  init(context: AppContext) { self.context = context }
  func owns(_ context: AppContext) -> Bool { self.context === context }
  var isAlive: Bool { gate.isAlive }
  func isOwner() -> Bool {
    guard let context, NativeIdentityOwnerContext.owns(context) else { return false }
    return gate.isAlive
  }
  func epoch() throws -> UInt64 { guard isOwner() else { throw NativeVaultFailure.stale }; return try gate.epoch() }
  func current(_ epoch: UInt64, requireForeground: Bool = true) -> Bool {
    guard isOwner() else { return false }
    return gate.current(epoch, requireForeground: requireForeground)
  }
  func update(foreground: Bool, protectedData: Bool) { gate.update(foreground: foreground, protectedData: protectedData) }
  func invalidateActions() { gate.invalidateActions() }
  func close() { gate.close() }
  func permit(_ epoch: UInt64, deadline: ContinuousClock.Instant? = nil) -> any NativeSignerStorageAuthority { NativeVaultMutationPermit(authority: self, epoch: epoch, deadline: deadline) }
  fileprivate func mutate(_ epoch: UInt64, deadline: ContinuousClock.Instant?, operation: () throws -> Void) throws {
    // Read native registry before this lock: its synchronous retirement callback closes this authority,
    // and must never reenter the registry while holding the same mutation/revocation lock.
    guard isOwner() else { throw NativeVaultFailure.stale }
    try gate.mutate(epoch, deadline: deadline, operation: operation)
  }
}
private struct NativeVaultMutationPermit: NativeSignerStorageAuthority {
  let authority: NativeVaultRuntimeAuthority
  let epoch: UInt64
  let deadline: ContinuousClock.Instant?
  func performMutation(_ operation: () throws -> Void) throws { try authority.mutate(epoch, deadline: deadline, operation: operation) }
}
