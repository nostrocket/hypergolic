import Foundation
import Testing
@testable import IdentitySecretStore

@MainActor private final class ForegroundState {
  var phase: BackupPresentationState = .inactive
  var reads = 0
  func read() -> BackupPresentationState { reads += 1; return phase }
}
private final class BackupLiveness: @unchecked Sendable {
  private let lock = NSLock()
  private var allowed = true
  func get() -> Bool { lock.withLock { allowed } }
  func revoke() { lock.withLock { allowed = false } }
}

@Test @MainActor func authenticatedBackupWaitsForActiveBeforeSecretRead() async throws {
  let state = ForegroundState(), liveness = BackupLiveness()
  let activation = Task { @MainActor in
    try await Task.sleep(for: .milliseconds(30)); state.phase = .active
  }
  defer { activation.cancel() }
  try await BackupForegroundGate.wait(canPresent: { liveness.get() }, state: { state.read() })
  #expect(state.phase == .active)
  #expect(state.reads >= 2)
}
@Test @MainActor func activeBackupDoesNotWaitOrRepeatAuthentication() async throws {
  let state = ForegroundState(); state.phase = .active
  try await BackupForegroundGate.wait(canPresent: { true }, state: { state.read() })
  #expect(state.reads == 1)
}
@Test @MainActor func backupRevocationDuringInactiveCannotResumeOnActivation() async {
  let state = ForegroundState(), liveness = BackupLiveness()
  let revoke = Task { @MainActor in
    try await Task.sleep(for: .milliseconds(30)); liveness.revoke(); state.phase = .active
  }
  defer { revoke.cancel() }
  await #expect(throws: DeletionActionFailure.denied) {
    try await BackupForegroundGate.wait(canPresent: { liveness.get() }, state: { state.read() })
  }
  #expect(state.reads >= 2)
}
@Test @MainActor func backgroundOrProtectedDataLossRejectsBackupWait() async {
  let state = ForegroundState(); state.phase = .revoked
  await #expect(throws: DeletionActionFailure.denied) {
    try await BackupForegroundGate.wait(canPresent: { true }, state: { state.read() })
  }
}
@Test @MainActor func cancelledInactiveBackupCannotReveal() async {
  let state = ForegroundState()
  let wait = Task { @MainActor in
    try await BackupForegroundGate.wait(canPresent: { true }, state: { state.read() })
  }
  try? await Task.sleep(for: .milliseconds(30))
  wait.cancel()
  await #expect(throws: DeletionActionFailure.denied) { try await wait.value }
}
@Test @MainActor func inactiveBackupWaitHasBoundedTimeout() async {
  let state = ForegroundState(), clock = ContinuousClock(), start = ContinuousClock.now
  await #expect(throws: DeletionActionFailure.unavailable) {
    try await BackupForegroundGate.wait(canPresent: { true }, state: { state.read() }, lifetime: .milliseconds(30))
  }
  #expect(clock.now - start < .seconds(1))
}
