import Synchronization

/// One accepted Expo module binding. Only native activation can install its private lease.
final class IdentityActionsBinding: Sendable {
  private struct State: Sendable { var lease: NativeIdentityRuntimeLease?; var opening = false }
  private let state = Mutex(State())
  func install(_ lease: NativeIdentityRuntimeLease) throws {
    try state.withLock { state in
      guard state.lease == nil else { throw DeletionActionFailure.unavailable }
      state.lease = lease
    }
  }
  private func lease() throws -> NativeIdentityRuntimeLease {
    guard let lease = state.withLock({ $0.lease }) else { throw DeletionActionFailure.unavailable }
    return lease
  }
  func beginSettings(selected: String, revision: UInt64) async throws -> String {
    let owner = try state.withLock { state in
      guard let lease = state.lease else { throw DeletionActionFailure.unavailable }
      guard !state.opening else { throw DeletionActionFailure.busy }
      state.opening = true; return lease
    }
    defer { state.withLock { $0.opening = false } }
    try await owner.setContext(expectedSelected: selected, expectedRevision: revision)
    return try owner.beginSettings()
  }
  func endSettings(_ session: String) throws {
    guard BridgeBounds.isToken(session) else { throw DeletionActionFailure.invalidInput }
    try lease().dismissSettings(session)
  }
  func cancelDeletion(_ session: String) throws {
    guard BridgeBounds.isToken(session) else { throw DeletionActionFailure.invalidInput }
    try lease().cancelDeletion(session)
  }
  func cancelBackup(_ session: String) throws {
    guard BridgeBounds.isToken(session) else { throw DeletionActionFailure.invalidInput }
    try lease().cancelBackup(session)
  }
  func authorizeDeletion(session: String, target: String, selected: String, revision: UInt64) async throws -> String {
    let owner = try lease()
    try owner.assertExpectedContext(settings: session, selected: selected, revision: revision)
    return try await owner.authorizeDeletion(settings: session, target: target)
  }
  func assertDeletionGrant(session: String, token: String, target: String) throws {
    try lease().assertDeletionGrant(settings: session, token: token, target: target)
  }
  func showBackup(session: String, target: String, selected: String, revision: UInt64) async throws {
    let owner = try lease()
    try owner.assertExpectedContext(settings: session, selected: selected, revision: revision)
    guard target == selected else { throw DeletionActionFailure.denied }
    try await owner.showBackup(settings: session, target: target)
  }
}
