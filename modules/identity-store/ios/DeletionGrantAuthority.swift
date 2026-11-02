import Foundation
import Synchronization

public struct NativeVaultInventory: Equatable, Sendable {
  let vaultID: String
  let revision: UInt64
  let selectedPubkey: String
  let receiptDigest: Data
  let identityDigests: [String: Data]
}
public protocol NativeVaultStateObserver: Sendable {
  func validatedInventory(_ value: NativeVaultInventory)
  func willMutateVault()
}
protocol DeletionClock: Sendable { func now() -> Duration }
struct ContinuousDeletionClock: DeletionClock {
  private let origin = ContinuousClock.now
  func now() -> Duration { origin.duration(to: .now) }
}
protocol DeviceDeletionAuthentication: Sendable {
  @MainActor func authenticate(attemptID: UInt64, canPresent: @escaping @Sendable () -> Bool) async throws
  @MainActor func cancel(attemptID: UInt64)
}
protocol DeviceBackupAuthentication: Sendable {
  @MainActor func authenticateBackup(attemptID: UInt64, canPresent: @escaping @Sendable () -> Bool) async throws
  @MainActor func cancelBackupAuthentication(attemptID: UInt64)
}
protocol NativeBackupSecretReader: Sendable {
  func readBackupSecret(pubkey: String, inventory: NativeVaultInventory) async throws -> Data
}
protocol NativeBackupPresenter: Sendable {
  @MainActor func presentBackup(attemptID: UInt64, secret: Data,
    canPresent: @escaping @Sendable () -> Bool) async throws
  @MainActor func cancelBackupPresentation(attemptID: UInt64)
  @MainActor func applicationWillResignActive()
}

enum DeletionActionFailure: String, Error, Sendable {
  case unavailable, denied, busy, staleContext, invalidInput
}

/// Native-only state: callers can request a target, but cannot assert its selection, existence or epoch.
/// The synchronous consume port is called by the file actor after a fresh native inventory validation.
final class DeletionGrantAuthority: NativeIdentityGrantOwner, NativeVaultStateObserver, Sendable {
  typealias InventoryReader = @Sendable () async throws -> NativeVaultInventory
  private struct Binding: Equatable, Sendable {
    let runtime: String
    let epoch: UInt64
    let inventory: NativeVaultInventory
  }
  private struct Attempt: Sendable {
    let id: UInt64
    let binding: Binding
    let settings: String
    let target: String
    let deadline: Duration
  }
  private struct Grant: Sendable {
    let attempt: Attempt
    let token: String
    let deadline: Duration
  }
  private struct BackupAttempt: Sendable {
    let id: UInt64
    let binding: Binding
    let settings: String
    let target: String
    let deadline: Duration
  }
  private struct Cancellation: Sendable {
    let deletion: UInt64?
    let backup: UInt64?
  }
  private struct State: Sendable {
    var runtime: String?
    var epoch: UInt64 = 0
    var nextAttempt: UInt64 = 0
    var foreground = false
    var protectedData = false
    var inventory: NativeVaultInventory?
    var binding: Binding?
    var settings: String?
    var attempt: Attempt?
    var grant: Grant?
    var backupAttempt: BackupAttempt?
  }
  private let state = Mutex(State())
  private let readInventory: InventoryReader
  private let authentication: any DeviceDeletionAuthentication
  private let backupAuthentication: (any DeviceBackupAuthentication)?
  private let backupSecretReader: (any NativeBackupSecretReader)?
  private let backupPresenter: (any NativeBackupPresenter)?
  private let clock: any DeletionClock
  private let entropy: any EntropySource
  private let authenticationLifetime: Duration = .seconds(60)
  private let grantLifetime: Duration = .seconds(15)

  init(readInventory: @escaping InventoryReader, authentication: any DeviceDeletionAuthentication,
    backupAuthentication: (any DeviceBackupAuthentication)? = nil,
    backupSecretReader: (any NativeBackupSecretReader)? = nil,
    backupPresenter: (any NativeBackupPresenter)? = nil,
    clock: any DeletionClock = ContinuousDeletionClock(), entropy: any EntropySource = SystemEntropy()) {
    self.readInventory = readInventory; self.authentication = authentication
    self.backupAuthentication = backupAuthentication; self.backupSecretReader = backupSecretReader
    self.backupPresenter = backupPresenter; self.clock = clock; self.entropy = entropy
  }
  private func invalidate(_ value: inout State, clearInventory: Bool = false) -> Cancellation {
    let cancellation = Cancellation(deletion: value.attempt?.id, backup: value.backupAttempt?.id)
    // Exhaustion stays permanently unavailable; never wrap an epoch and revive an old binding.
    if value.epoch < UInt64.max { value.epoch += 1 }
    value.binding = nil; value.settings = nil; value.attempt = nil; value.grant = nil; value.backupAttempt = nil
    if clearInventory { value.inventory = nil }
    return cancellation
  }
  private func cancelPrompts(_ cancellation: Cancellation?) {
    guard let cancellation else { return }
    if let id = cancellation.deletion {
      Task { @MainActor [authentication] in authentication.cancel(attemptID: id) }
    }
    if let id = cancellation.backup {
      Task { @MainActor [backupAuthentication, backupPresenter] in
        backupAuthentication?.cancelBackupAuthentication(attemptID: id)
        backupPresenter?.cancelBackupPresentation(attemptID: id)
      }
    }
  }
  private func opaqueToken(using source: any EntropySource) throws -> String {
    var bytes: Data
    do { bytes = try source.bytes(count: 32) } catch { throw DeletionActionFailure.unavailable }
    defer { bytes.resetBytes(in: 0..<bytes.count) }
    guard bytes.count == 32 else { throw DeletionActionFailure.unavailable }
    return bytes.map { String(format: "%02x", $0) }.joined()
  }
  private func owns(_ value: State, runtime: String) -> Bool {
    value.runtime == runtime && value.epoch < UInt64.max && value.foreground && value.protectedData
  }
  private func matches(_ attempt: Attempt, _ value: State) -> Bool {
    owns(value, runtime: attempt.binding.runtime) && value.binding == attempt.binding
      && value.inventory == attempt.binding.inventory && value.settings == attempt.settings
  }
  private func matches(_ attempt: BackupAttempt, _ value: State) -> Bool {
    owns(value, runtime: attempt.binding.runtime) && value.binding == attempt.binding
      && value.inventory == attempt.binding.inventory && value.settings == attempt.settings
      && attempt.target == attempt.binding.inventory.selectedPubkey
  }
  func reserveRuntimeReplacement(entropy: any EntropySource) throws -> String {
    let (epoch, cancelled) = state.withLock { state -> (UInt64, Cancellation) in
      let old = invalidate(&state); state.runtime = nil; return (state.epoch, old)
    }
    cancelPrompts(cancelled)
    let runtime = try opaqueToken(using: entropy)
    return try state.withLock { state in
      // Another replacement or invalidation can start while native entropy is obtained.
      // An older reservation must never overwrite the newer owner when it finishes late.
      guard state.epoch == epoch, epoch < UInt64.max, state.runtime == nil else { throw DeletionActionFailure.staleContext }
      state.runtime = runtime
      return runtime
    }
  }
  /// IDs originate from the native factory lease; no JS method accepts an owner identity.
  func replaceRuntime(_ runtime: String) throws {
    guard BridgeBounds.isToken(runtime) else { throw DeletionActionFailure.invalidInput }
    let cancelled = state.withLock { state in
      let old = invalidate(&state); state.runtime = runtime; return old
    }
    cancelPrompts(cancelled)
  }
  func disposeRuntime(_ runtime: String) {
    let cancelled = state.withLock { state -> Cancellation? in
      guard state.runtime == runtime else { return nil }
      let old = invalidate(&state); state.runtime = nil; return old
    }
    cancelPrompts(cancelled)
  }
  /// Driven only by UIApplication state/notifications. Inactive does not mean background.
  func updateApplication(foreground: Bool, protectedData: Bool) {
    let cancelled = state.withLock { state -> Cancellation? in
      state.foreground = foreground; state.protectedData = protectedData
      return foreground && protectedData ? nil : invalidate(&state)
    }
    cancelPrompts(cancelled)
  }
  func willMutateVault() {
    let cancelled = state.withLock { invalidate(&$0, clearInventory: true) }
    cancelPrompts(cancelled)
  }
  func validatedInventory(_ value: NativeVaultInventory) {
    let cancelled = state.withLock { state -> Cancellation? in
      let changed = state.inventory != nil && state.inventory != value
      let old: Cancellation? = changed ? invalidate(&state) : nil
      state.inventory = value
      return old
    }
    cancelPrompts(cancelled)
  }
  func setContext(runtime: String, expectedSelected: String, expectedRevision: UInt64) async throws {
    guard Receipt.isPubkey(expectedSelected), expectedRevision > 0,
      expectedRevision <= 9_007_199_254_740_991 else { throw DeletionActionFailure.invalidInput }
    let (epoch, cancelled) = try state.withLock { state -> (UInt64, Cancellation) in
      guard owns(state, runtime: runtime) else { throw DeletionActionFailure.staleContext }
      let old = invalidate(&state); return (state.epoch, old)
    }
    cancelPrompts(cancelled)
    let inventory: NativeVaultInventory
    do { inventory = try await readInventory() } catch { throw DeletionActionFailure.unavailable }
    try state.withLock { state in
      guard owns(state, runtime: runtime), state.epoch == epoch, state.inventory == inventory,
        inventory.selectedPubkey == expectedSelected, inventory.revision == expectedRevision else { throw DeletionActionFailure.staleContext }
      state.binding = Binding(runtime: runtime, epoch: epoch, inventory: inventory)
    }
  }
  func beginSettings(runtime: String) throws -> String {
    let session = try opaqueToken(using: entropy)
    let cancelled = try state.withLock { state -> Cancellation in
      guard owns(state, runtime: runtime), let binding = state.binding,
        binding.epoch == state.epoch, binding.inventory == state.inventory else { throw DeletionActionFailure.staleContext }
      let old = Cancellation(deletion: state.attempt?.id, backup: state.backupAttempt?.id)
      state.settings = session; state.attempt = nil; state.grant = nil; state.backupAttempt = nil
      return old
    }
    cancelPrompts(cancelled)
    return session
  }
  func dismissSettings(runtime: String, settings: String) {
    let cancelled = state.withLock { state -> Cancellation? in
      guard state.runtime == runtime, state.settings == settings else { return nil }
      let old = Cancellation(deletion: state.attempt?.id, backup: state.backupAttempt?.id)
      state.settings = nil; state.attempt = nil; state.grant = nil; state.backupAttempt = nil; return old
    }
    cancelPrompts(cancelled)
  }
  func cancelDeletion(runtime: String, settings: String) {
    let cancelled = state.withLock { state -> Cancellation? in
      guard state.runtime == runtime, state.settings == settings else { return nil }
      let old = state.attempt?.id; state.attempt = nil; state.grant = nil
      return old.map { Cancellation(deletion: $0, backup: nil) }
    }
    cancelPrompts(cancelled)
  }
  func cancelBackup(runtime: String, settings: String) {
    let cancelled = state.withLock { state -> Cancellation? in
      guard state.runtime == runtime, state.settings == settings,
        let id = state.backupAttempt?.id else { return nil }
      state.backupAttempt = nil
      return Cancellation(deletion: nil, backup: id)
    }
    cancelPrompts(cancelled)
  }
  @MainActor func applicationWillResignActive() {
    // An LAContext prompt may make the app inactive before any secret exists in UI.
    // The presenter only closes an already-visible panel and does not cancel authentication.
    backupPresenter?.applicationWillResignActive()
  }
  func assertExpectedContext(runtime: String, settings: String, selected: String, revision: UInt64) throws {
    guard Receipt.isPubkey(selected), revision > 0, revision <= 9_007_199_254_740_991 else { throw DeletionActionFailure.invalidInput }
    try state.withLock { state in
      guard owns(state, runtime: runtime), state.settings == settings, let binding = state.binding,
        binding.epoch == state.epoch, binding.inventory == state.inventory,
        binding.inventory.selectedPubkey == selected, binding.inventory.revision == revision else { throw DeletionActionFailure.staleContext }
    }
  }
  func assertDeletionGrant(runtime: String, settings: String, token: String, target: String) throws {
    guard BridgeBounds.isToken(settings), BridgeBounds.isToken(token), Receipt.isPubkey(target) else { throw DeletionActionFailure.invalidInput }
    try state.withLock { state in
      guard let grant = state.grant, grant.token == token, grant.attempt.target == target,
        grant.attempt.binding.runtime == runtime, grant.attempt.settings == settings,
        matches(grant.attempt, state), clock.now() < grant.deadline else { throw DeletionActionFailure.denied }
    }
  }
  private func currentAttempt(_ id: UInt64) -> Bool {
    state.withLock { state in
      guard let attempt = state.attempt, attempt.id == id else { return false }
      return matches(attempt, state) && clock.now() < attempt.deadline
    }
  }
  private func cancelAttempt(_ id: UInt64) {
    let cancelled = state.withLock { state -> Cancellation? in
      if state.grant?.attempt.id == id { state.grant = nil }
      guard state.attempt?.id == id else { return nil }
      state.attempt = nil; return Cancellation(deletion: id, backup: nil)
    }
    cancelPrompts(cancelled)
  }
  private func currentBackupAttempt(_ id: UInt64) -> Bool {
    state.withLock { state in
      guard let attempt = state.backupAttempt, attempt.id == id else { return false }
      return matches(attempt, state) && clock.now() < attempt.deadline
    }
  }
  private func cancelBackupAttempt(_ id: UInt64) {
    let cancelled = state.withLock { state -> Cancellation? in
      guard state.backupAttempt?.id == id else { return nil }
      state.backupAttempt = nil
      return Cancellation(deletion: nil, backup: id)
    }
    cancelPrompts(cancelled)
  }
  func authorizeDeletion(runtime: String, settings: String, target: String) async throws -> String {
    guard BridgeBounds.isToken(settings), Receipt.isPubkey(target) else { throw DeletionActionFailure.invalidInput }
    let attempt = try state.withLock { state -> Attempt in
      if let grant = state.grant, clock.now() >= grant.deadline { state.grant = nil }
      guard owns(state, runtime: runtime), let binding = state.binding, state.settings == settings,
        binding.inventory == state.inventory, binding.epoch == state.epoch else { throw DeletionActionFailure.staleContext }
      guard binding.inventory.identityDigests.count >= 2, binding.inventory.selectedPubkey != target,
        binding.inventory.identityDigests[target] != nil else { throw DeletionActionFailure.denied }
      guard state.attempt == nil, state.grant == nil, state.backupAttempt == nil else { throw DeletionActionFailure.busy }
      guard state.nextAttempt < UInt64.max else { throw DeletionActionFailure.unavailable }
      state.nextAttempt += 1
      let value = Attempt(id: state.nextAttempt, binding: binding, settings: settings, target: target,
        deadline: clock.now() + authenticationLifetime)
      state.attempt = value; return value
    }
    let timeout = Task { [weak self] in
      do { try await Task.sleep(for: .seconds(60)) } catch { return }
      self?.cancelAttempt(attempt.id)
    }
    defer {
      timeout.cancel()
      state.withLock { if $0.attempt?.id == attempt.id { $0.attempt = nil } }
    }
    return try await withTaskCancellationHandler {
      do {
        let initial = try await readInventory()
        guard initial == attempt.binding.inventory, currentAttempt(attempt.id), !Task.isCancelled else { throw DeletionActionFailure.denied }
        try await authentication.authenticate(attemptID: attempt.id) { [weak self] in self?.currentAttempt(attempt.id) == true }
        guard currentAttempt(attempt.id), !Task.isCancelled else { throw DeletionActionFailure.denied }
        let refreshed = try await readInventory()
        guard refreshed == attempt.binding.inventory else { throw DeletionActionFailure.denied }
        let token = try opaqueToken(using: entropy)
        return try state.withLock { state in
          guard state.attempt?.id == attempt.id, matches(attempt, state), clock.now() < attempt.deadline,
            !Task.isCancelled else { throw DeletionActionFailure.denied }
          state.grant = Grant(attempt: attempt, token: token, deadline: clock.now() + grantLifetime)
          state.attempt = nil
          return token
        }
      } catch {
        cancelAttempt(attempt.id)
        throw error as? DeletionActionFailure ?? .denied
      }
    } onCancel: { [weak self] in self?.cancelAttempt(attempt.id) }
  }
  func showBackup(runtime: String, settings: String, target: String) async throws {
    guard BridgeBounds.isToken(settings), Receipt.isPubkey(target) else { throw DeletionActionFailure.invalidInput }
    guard let backupAuthentication, let backupSecretReader, let backupPresenter else {
      throw DeletionActionFailure.unavailable
    }
    let attempt = try state.withLock { state -> BackupAttempt in
      if let grant = state.grant, clock.now() >= grant.deadline { state.grant = nil }
      guard owns(state, runtime: runtime), let binding = state.binding, state.settings == settings,
        binding.inventory == state.inventory, binding.epoch == state.epoch else { throw DeletionActionFailure.staleContext }
      guard binding.inventory.selectedPubkey == target,
        binding.inventory.identityDigests[target] != nil else { throw DeletionActionFailure.denied }
      guard state.attempt == nil, state.grant == nil, state.backupAttempt == nil else { throw DeletionActionFailure.busy }
      guard state.nextAttempt < UInt64.max else { throw DeletionActionFailure.unavailable }
      state.nextAttempt += 1
      let value = BackupAttempt(id: state.nextAttempt, binding: binding, settings: settings, target: target,
        deadline: clock.now() + authenticationLifetime)
      state.backupAttempt = value
      return value
    }
    let timeout = Task { [weak self] in
      do { try await Task.sleep(for: .seconds(60)) } catch { return }
      self?.cancelBackupAttempt(attempt.id)
    }
    defer {
      timeout.cancel()
      state.withLock { if $0.backupAttempt?.id == attempt.id { $0.backupAttempt = nil } }
    }
    try await withTaskCancellationHandler {
      do {
        let initial = try await readInventory()
        guard initial == attempt.binding.inventory, currentBackupAttempt(attempt.id),
          !Task.isCancelled else { throw DeletionActionFailure.denied }
        try await backupAuthentication.authenticateBackup(attemptID: attempt.id) {
          [weak self] in self?.currentBackupAttempt(attempt.id) == true
        }
        guard currentBackupAttempt(attempt.id), !Task.isCancelled else { throw DeletionActionFailure.denied }
        let refreshed = try await readInventory()
        guard refreshed == attempt.binding.inventory else { throw DeletionActionFailure.denied }
        var secret = try await backupSecretReader.readBackupSecret(pubkey: target, inventory: refreshed)
        defer { secret.resetBytes(in: 0..<secret.count) }
        let finalInventory = try await readInventory()
        guard finalInventory == refreshed, secret.count == 32,
          currentBackupAttempt(attempt.id), !Task.isCancelled else { throw DeletionActionFailure.denied }
        try await backupPresenter.presentBackup(attemptID: attempt.id, secret: secret) {
          [weak self] in self?.currentBackupAttempt(attempt.id) == true
        }
        guard currentBackupAttempt(attempt.id), !Task.isCancelled else { throw DeletionActionFailure.denied }
      } catch {
        cancelBackupAttempt(attempt.id)
        throw error as? DeletionActionFailure ?? .denied
      }
    } onCancel: { [weak self] in self?.cancelBackupAttempt(attempt.id) }
  }
  func consumeDeletionGrant(token: String, targetPubkey: String) throws {
    try state.withLock { state in
      guard let grant = state.grant, grant.token == token, grant.attempt.target == targetPubkey,
        matches(grant.attempt, state), clock.now() < grant.deadline else { throw DeletionActionFailure.denied }
      state.grant = nil // Linearization point: exact grant consumed once before the file actor erases.
    }
  }
}


enum BackupPresentationState: Sendable { case active, inactive, revoked }

/// Authentication success is not itself proof that UIKit has resumed active presentation.
enum BackupForegroundGate {
  @MainActor static func wait(canPresent: @escaping @Sendable () -> Bool,
    state: @escaping @MainActor () -> BackupPresentationState,
    lifetime: Duration = .seconds(5)) async throws {
    let clock = ContinuousClock(), deadline = ContinuousClock.now.advanced(by: lifetime)
    while true {
      guard canPresent(), !Task.isCancelled else { throw DeletionActionFailure.denied }
      guard clock.now < deadline else { throw DeletionActionFailure.unavailable }
      switch state() {
      case .active: return
      case .revoked: throw DeletionActionFailure.denied
      case .inactive: break
      }
      do { try await Task.sleep(for: .milliseconds(20)) }
      catch { throw DeletionActionFailure.denied }
    }
  }
}
