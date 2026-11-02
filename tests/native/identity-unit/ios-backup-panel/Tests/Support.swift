import Foundation

enum DeletionActionFailure: String, Error, Sendable {
  case unavailable, denied, busy, staleContext, invalidInput
}

protocol NativeBackupPresenter: Sendable {
  @MainActor func presentBackup(attemptID: UInt64, secret: Data,
    canPresent: @escaping @Sendable () -> Bool) async throws
  @MainActor func cancelBackupPresentation(attemptID: UInt64)
  @MainActor func applicationWillResignActive()
}
