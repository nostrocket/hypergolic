import Foundation
import LocalAuthentication
import UIKit

private enum NativeAuthenticationAction: Sendable { case deletion, backup }

struct SystemDeviceDeletionAuthentication: DeviceDeletionAuthentication {
  @MainActor static func isAvailable() -> Bool {
    guard let description = Bundle.main.object(forInfoDictionaryKey: "NSFaceIDUsageDescription") as? String,
      !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
    let context = LAContext()
    defer { context.invalidate() }
    var error: NSError?
    return context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) && error == nil
  }
  @MainActor func authenticate(attemptID: UInt64, canPresent: @escaping @Sendable () -> Bool) async throws {
    try await DeviceAuthenticationProcess.shared.authenticate(action: .deletion, attemptID: attemptID,
      reason: "Authenticate to delete this identity.", canPresent: canPresent)
  }
  @MainActor func cancel(attemptID: UInt64) {
    DeviceAuthenticationProcess.shared.cancel(action: .deletion, attemptID: attemptID)
  }
}

struct SystemDeviceBackupAuthentication: DeviceBackupAuthentication {
  @MainActor static func isAvailable() -> Bool { SystemDeviceDeletionAuthentication.isAvailable() }
  @MainActor func authenticateBackup(attemptID: UInt64,
    canPresent: @escaping @Sendable () -> Bool) async throws {
    try await DeviceAuthenticationProcess.shared.authenticate(action: .backup, attemptID: attemptID,
      reason: "Authenticate to reveal the backup for your selected identity.", canPresent: canPresent)
    // Face ID's reply can precede UIKit becoming active. Do not read backup
    // material until presentation is active and the same native attempt is live.
    try await BackupForegroundGate.wait(canPresent: canPresent) {
      guard UIApplication.shared.isProtectedDataAvailable,
        UIApplication.shared.applicationState != .background else { return .revoked }
      return UIApplication.shared.applicationState == .active ? .active : .inactive
    }
  }
  @MainActor func cancelBackupAuthentication(attemptID: UInt64) {
    DeviceAuthenticationProcess.shared.cancel(action: .backup, attemptID: attemptID)
  }
}

/// LAContext and its continuation are confined to MainActor; the system callback has no authority.
@MainActor private final class DeviceAuthenticationProcess {
  static let shared = DeviceAuthenticationProcess()
  private struct Pending {
    let action: NativeAuthenticationAction
    let id: UInt64
    let context: LAContext
    let continuation: CheckedContinuation<Void, any Error>
  }
  private var pending: Pending?
  func authenticate(action: NativeAuthenticationAction, attemptID: UInt64, reason: String,
    canPresent: @escaping @Sendable () -> Bool) async throws {
    guard pending == nil else { throw DeletionActionFailure.busy }
    guard canPresent(), !Task.isCancelled else { throw DeletionActionFailure.denied }
    // Always configure this in the app bundle before exposing the feature; no Face ID crash path.
    guard let description = Bundle.main.object(forInfoDictionaryKey: "NSFaceIDUsageDescription") as? String,
      !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw DeletionActionFailure.unavailable }
    let context = LAContext()
    context.localizedCancelTitle = "Cancel"
    context.interactionNotAllowed = false
    context.touchIDAuthenticationAllowableReuseDuration = 0
    var error: NSError?
    // This policy supports passcode fallback and fails when a device passcode is not enabled.
    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error), error == nil else {
      context.invalidate(); throw DeletionActionFailure.unavailable
    }
    guard canPresent(), !Task.isCancelled else { context.invalidate(); throw DeletionActionFailure.denied }
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        pending = Pending(action: action, id: attemptID, context: context, continuation: continuation)
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { [weak self] success, error in
          let accepted = success && error == nil
          Task { @MainActor in self?.complete(action: action, attemptID: attemptID, accepted: accepted) }
        }
      }
    } onCancel: { [weak self] in
      Task { @MainActor in self?.cancel(action: action, attemptID: attemptID) }
    }
  }
  private func complete(action: NativeAuthenticationAction, attemptID: UInt64, accepted: Bool) {
    guard let pending, pending.action == action, pending.id == attemptID else { return }
    self.pending = nil
    pending.context.invalidate()
    if accepted { pending.continuation.resume() }
    else { pending.continuation.resume(throwing: DeletionActionFailure.denied) }
  }
  func cancel(action: NativeAuthenticationAction, attemptID: UInt64) {
    guard let pending, pending.action == action, pending.id == attemptID else { return }
    self.pending = nil
    pending.context.invalidate()
    pending.continuation.resume(throwing: DeletionActionFailure.denied)
  }
}
