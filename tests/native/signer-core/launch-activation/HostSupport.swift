import Foundation

// Only UIKit/Expo ownership and storage dispatch are doubles. The session methods,
// launch gate, mutation gate and failure enum are compiled from their owning sources.
@MainActor final class UIApplication {
  enum State { case active, inactive, background }
  static let shared = UIApplication()
  var applicationState: State = .inactive
  var isProtectedDataAvailable = true
}
final class TestAuthority: @unchecked Sendable {
  let gate = NativeVaultMutationGate()
  var owner = true
  func update(foreground: Bool, protectedData: Bool) { gate.update(foreground: foreground, protectedData: protectedData) }
  func epoch() throws -> UInt64 { guard owner else { throw NativeVaultFailure.stale }; return try gate.epoch() }
  func current(_ epoch: UInt64, requireForeground: Bool = true) -> Bool { owner && gate.current(epoch, requireForeground: requireForeground) }
  func permit(_ epoch: UInt64) -> TestPermit { TestPermit(authority: self, epoch: epoch) }
}
struct TestPermit {
  let authority: TestAuthority
  let epoch: UInt64
  func mutate(_ work: () -> Void) throws {
    guard authority.owner else { throw NativeVaultFailure.stale }
    try authority.gate.mutate(epoch, operation: work)
  }
}
@MainActor final class TestCore {
  var calls = 0, writes = 0
  func open(authority: TestPermit, current: @Sendable () -> Bool) async throws -> String {
    calls += 1
    guard current() else { throw NativeVaultFailure.denied }
    try authority.mutate { writes += 1 }
    return "public-snapshot"
  }
}
@MainActor final class SessionUnderTest {
  let authority = TestAuthority(), core = TestCore(), launch = NativeVaultLaunchGate()
  var importReply: Int?, remoteReply: Int?, signReply: Int?, authentication: Int?, confirmation: Int?, safari: Int?
  init(active: Bool = false, protectedData: Bool = true) {
    UIApplication.shared.applicationState = active ? .active : .inactive
    UIApplication.shared.isProtectedDataAvailable = protectedData
    refresh()
  }
  func notification() { refresh(); launch.changed() }
  // ACTUAL_SESSION_METHODS
}
