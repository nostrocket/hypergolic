import Foundation
import Synchronization

/// Created synchronously for the accepted native one-shot owner, never from Module.OnCreate.
/// Kept on that exact main AppContext binding; never accepts a runtime ID from JS.
final class NativeIdentityRuntimeLease: Sendable {
  private let authority: DeletionGrantAuthority
  private let runtimeID: String
  private enum Phase { case fresh, bound, closed }
  private let phase = Mutex(Phase.fresh)
  init(authority: DeletionGrantAuthority, entropy: any EntropySource = SystemEntropy()) throws {
    self.runtimeID = try authority.reserveRuntimeReplacement(entropy: entropy)
    self.authority = authority
  }
  /// Native lifetime registration succeeds before the lease can enable any settings operation.
  func didBindMainRuntime() throws {
    try phase.withLock { phase in
      guard phase == .fresh else { throw DeletionActionFailure.staleContext }
      phase = .bound
    }
  }
  func dispose() {
    phase.withLock { $0 = .closed }
    authority.disposeRuntime(runtimeID)
  }
  private func requireBound() throws {
    guard phase.withLock({ $0 == .bound }) else { throw DeletionActionFailure.staleContext }
  }
  func setContext(expectedSelected: String, expectedRevision: UInt64) async throws {
    try requireBound()
    try await authority.setContext(runtime: runtimeID, expectedSelected: expectedSelected, expectedRevision: expectedRevision)
  }
  func beginSettings() throws -> String { try requireBound(); return try authority.beginSettings(runtime: runtimeID) }
  func dismissSettings(_ settings: String) { authority.dismissSettings(runtime: runtimeID, settings: settings) }
  func cancelDeletion(_ settings: String) { authority.cancelDeletion(runtime: runtimeID, settings: settings) }
  func cancelBackup(_ settings: String) { authority.cancelBackup(runtime: runtimeID, settings: settings) }
  func assertExpectedContext(settings: String, selected: String, revision: UInt64) throws {
    try requireBound()
    try authority.assertExpectedContext(runtime: runtimeID, settings: settings, selected: selected, revision: revision)
  }
  func assertDeletionGrant(settings: String, token: String, target: String) throws {
    try requireBound()
    try authority.assertDeletionGrant(runtime: runtimeID, settings: settings, token: token, target: target)
  }
  func authorizeDeletion(settings: String, target: String) async throws -> String {
    try requireBound()
    return try await authority.authorizeDeletion(runtime: runtimeID, settings: settings, target: target)
  }
  func showBackup(settings: String, target: String) async throws {
    try requireBound()
    try await authority.showBackup(runtime: runtimeID, settings: settings, target: target)
  }
}
