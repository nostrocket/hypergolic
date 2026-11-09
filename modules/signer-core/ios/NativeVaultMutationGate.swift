import Foundation
import Synchronization

/// Revocation, deadline and protected mutation share one synchronous native critical section.
/// Runtime ownership is checked by NativeVaultRuntimeAuthority before entering this gate.
final class NativeVaultMutationGate: @unchecked Sendable {
  private struct State: Sendable {
    var alive = true
    var foreground = false
    var protectedData = false
    var epoch: UInt64 = 1
    var localActive = false
    var localEpoch: UInt64 = 1
  }
  private let state = Mutex(State())
  var isAlive: Bool { state.withLock { $0.alive } }
  func epoch() throws -> UInt64 {
    try state.withLock { guard $0.alive else { throw NativeVaultFailure.stale }; return $0.epoch }
  }
  func current(_ epoch: UInt64, requireForeground: Bool = true) -> Bool {
    state.withLock { $0.alive && $0.epoch == epoch && $0.protectedData && (!requireForeground || $0.foreground) }
  }
  func update(foreground: Bool, protectedData: Bool) {
    state.withLock { value in
      if (!foreground || !protectedData) && (value.foreground || value.protectedData) {
        if value.epoch < UInt64.max { value.epoch += 1 } else { value.alive = false }
      }
      if value.localActive && (!foreground || !protectedData) { value.localEpoch += 1 }
      value.localActive = value.alive && foreground && protectedData && value.localEpoch < UInt64.max
      value.foreground = foreground; value.protectedData = protectedData
    }
  }
  /// System authentication can preserve the signer epoch while the app resigns active.
  func suspendLocalLeases() {
    state.withLock { value in
      if value.localActive { value.localEpoch += 1 }
      value.localActive = false
    }
  }
  func localLeaseEpoch(_ epoch: UInt64) throws -> UInt64 {
    try state.withLock { value in
      guard value.alive, value.epoch == epoch, value.localActive else { throw NativeVaultFailure.stale }
      return value.localEpoch
    }
  }
  func currentLocalLease(_ epoch: UInt64, localEpoch: UInt64) -> Bool {
    state.withLock { $0.alive && $0.epoch == epoch && $0.localActive && $0.localEpoch == localEpoch }
  }
  func invalidateActions() {
    state.withLock { value in if value.epoch < UInt64.max { value.epoch += 1 } else { value.alive = false } }
  }
  func close() { state.withLock { $0.alive = false; $0.foreground = false; $0.protectedData = false } }
  func mutate(_ epoch: UInt64, deadline: ContinuousClock.Instant? = nil, operation: () throws -> Void) throws {
    try state.withLock { value in
      guard value.alive, value.foreground, value.protectedData, value.epoch == epoch,
        deadline.map({ ContinuousClock.now < $0 }) ?? true else { throw NativeVaultFailure.stale }
      try operation()
    }
  }
}
