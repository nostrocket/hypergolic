import Foundation

/// Native-only reuse of the existing fresh system-authentication and protected backup surfaces.
public enum NativeSignerIdentityActions {
  public enum Action: Sendable { case backup, deletion }
  @MainActor public static func isAvailable() -> Bool { SystemDeviceDeletionAuthentication.isAvailable() }
  @MainActor public static func authenticate(_ action: Action, attemptID: UInt64,
    canPresent: @escaping @Sendable () -> Bool) async throws {
    switch action {
    case .backup: try await SystemDeviceBackupAuthentication().authenticateBackup(attemptID: attemptID, canPresent: canPresent)
    case .deletion: try await SystemDeviceDeletionAuthentication().authenticate(attemptID: attemptID, canPresent: canPresent)
    }
  }
  @MainActor public static func cancel(_ action: Action, attemptID: UInt64) {
    switch action {
    case .backup: SystemDeviceBackupAuthentication().cancelBackupAuthentication(attemptID: attemptID)
    case .deletion: SystemDeviceDeletionAuthentication().cancel(attemptID: attemptID)
    }
  }
  @MainActor public static func showBackup(attemptID: UInt64, secret: Data,
    canPresent: @escaping @Sendable () -> Bool) async throws {
    try await NativeBackupPanelProcess.shared.presentBackup(attemptID: attemptID, secret: secret, canPresent: canPresent)
  }
  @MainActor public static func clearBackup() { NativeBackupPanelProcess.shared.applicationWillResignActive() }
}
