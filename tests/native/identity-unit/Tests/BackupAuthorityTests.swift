import Foundation
import Synchronization
import Testing
@testable import IdentitySecretStore

private final class BackupClock: DeletionClock, Sendable {
  let value = Mutex(Duration.zero)
  func now() -> Duration { value.withLock { $0 } }
  func advance(_ amount: Duration) { value.withLock { $0 += amount } }
}
private final class BackupInventorySource: Sendable {
  struct State: Sendable { var inventory: NativeVaultInventory; var observer: (@Sendable (NativeVaultInventory) -> Void)?; var reads = 0 }
  let state: Mutex<State>
  init(_ inventory: NativeVaultInventory) { state = Mutex(State(inventory: inventory)) }
  func read() -> NativeVaultInventory {
    let (value, observer) = state.withLock { state in state.reads += 1; return (state.inventory, state.observer) }
    observer?(value)
    return value
  }
}
@MainActor private final class BackupDeletionAuthentication: DeviceDeletionAuthentication {
  var calls = 0
  func authenticate(attemptID: UInt64, canPresent: @escaping @Sendable () -> Bool) async throws {
    calls += 1
    throw DeletionActionFailure.denied
  }
  func cancel(attemptID: UInt64) {}
}
@MainActor private final class ManualBackupAuthentication: DeviceBackupAuthentication {
  var pending: (UInt64, CheckedContinuation<Void, any Error>)?
  var waiter: CheckedContinuation<UInt64, Never>?
  var calls: [UInt64] = [], cancellations: [UInt64] = []
  func authenticateBackup(attemptID: UInt64, canPresent: @escaping @Sendable () -> Bool) async throws {
    guard pending == nil, canPresent() else { throw DeletionActionFailure.denied }
    calls.append(attemptID)
    try await withCheckedThrowingContinuation { continuation in
      pending = (attemptID, continuation); waiter?.resume(returning: attemptID); waiter = nil
    }
  }
  func started() async -> UInt64 {
    if let pending { return pending.0 }
    return await withCheckedContinuation { waiter = $0 }
  }
  func finish(success: Bool) {
    guard let pending else { Issue.record("No backup authentication attempt"); return }
    self.pending = nil
    if success { pending.1.resume() } else { pending.1.resume(throwing: DeletionActionFailure.denied) }
  }
  func cancelBackupAuthentication(attemptID: UInt64) {
    cancellations.append(attemptID)
    guard let pending, pending.0 == attemptID else { return }
    self.pending = nil; pending.1.resume(throwing: DeletionActionFailure.denied)
  }
}
private final class BackupSecretFixture: NativeBackupSecretReader, Sendable {
  struct State: Sendable {
    var calls: [(String, NativeVaultInventory)] = []
    var bytes = Data((1...32).map(UInt8.init))
    var fail = false
  }
  let state = Mutex(State())
  func readBackupSecret(pubkey: String, inventory: NativeVaultInventory) async throws -> Data {
    try state.withLock { state in
      state.calls.append((pubkey, inventory))
      if state.fail { throw StoreFailure.unavailable }
      return state.bytes
    }
  }
}
@MainActor private final class BackupPresenterFixture: NativeBackupPresenter {
  var pending: (UInt64, CheckedContinuation<Void, any Error>)?
  var waiter: CheckedContinuation<UInt64, Never>?
  var revealed: [UInt8] = [], cancellations: [UInt64] = [], resigns = 0
  func presentBackup(attemptID: UInt64, secret: Data,
    canPresent: @escaping @Sendable () -> Bool) async throws {
    guard pending == nil, canPresent() else { throw DeletionActionFailure.denied }
    revealed = Array(secret)
    try await withCheckedThrowingContinuation { continuation in
      pending = (attemptID, continuation); waiter?.resume(returning: attemptID); waiter = nil
    }
  }
  func started() async -> UInt64 {
    if let pending { return pending.0 }
    return await withCheckedContinuation { waiter = $0 }
  }
  func dismiss(success: Bool) {
    guard let pending else { Issue.record("No backup panel"); return }
    self.pending = nil; revealed = []
    if success { pending.1.resume() } else { pending.1.resume(throwing: DeletionActionFailure.denied) }
  }
  func cancelBackupPresentation(attemptID: UInt64) {
    cancellations.append(attemptID)
    guard pending?.0 == attemptID else { return }
    dismiss(success: false)
  }
  func applicationWillResignActive() { resigns += 1; if pending != nil { dismiss(success: false) } }
}
private func backupInventory(selected: Int = 2, revision: UInt64 = 1) -> NativeVaultInventory {
  NativeVaultInventory(vaultID: vaultID, revision: revision, selectedPubkey: key(selected),
    receiptDigest: Data([UInt8(revision)]), identityDigests: [key(1): Data([1]), key(2): Data([2])])
}
@MainActor private struct BackupHarness {
  let source: BackupInventorySource, deletion: BackupDeletionAuthentication
  let authentication: ManualBackupAuthentication, reader: BackupSecretFixture, presenter: BackupPresenterFixture
  let clock: BackupClock, owner: DeletionGrantAuthority
  init() {
    let source = BackupInventorySource(backupInventory()), deletion = BackupDeletionAuthentication()
    let authentication = ManualBackupAuthentication(), reader = BackupSecretFixture(), presenter = BackupPresenterFixture()
    let clock = BackupClock()
    self.source = source; self.deletion = deletion; self.authentication = authentication
    self.reader = reader; self.presenter = presenter; self.clock = clock
    owner = DeletionGrantAuthority(readInventory: { source.read() }, authentication: deletion,
      backupAuthentication: authentication, backupSecretReader: reader, backupPresenter: presenter,
      clock: clock, entropy: TestEntropy())
    source.state.withLock { [weak owner] in $0.observer = { [weak owner] value in owner?.validatedInventory(value) } }
  }
  func ready() async throws -> String {
    try owner.replaceRuntime("backup_runtime_fixture_0001")
    owner.updateApplication(foreground: true, protectedData: true)
    try await owner.setContext(runtime: "backup_runtime_fixture_0001", expectedSelected: key(2), expectedRevision: 1)
    return try owner.beginSettings(runtime: "backup_runtime_fixture_0001")
  }
  func start(_ settings: String) -> Task<Void, any Error> {
    Task { try await owner.showBackup(runtime: "backup_runtime_fixture_0001", settings: settings, target: key(2)) }
  }
}

@Test @MainActor func backupRequiresExactSelectedNativeContextAndReturnsOnlyAfterPanelDismissal() async throws {
  let h = BackupHarness(), settings = try await h.ready()
  await #expect(throws: DeletionActionFailure.denied) {
    try await h.owner.showBackup(runtime: "backup_runtime_fixture_0001", settings: settings, target: key(1))
  }
  let task = h.start(settings)
  _ = await h.authentication.started(); h.authentication.finish(success: true)
  _ = await h.presenter.started()
  #expect(h.presenter.revealed == (1...32).map(UInt8.init))
  #expect(h.reader.state.withLock { $0.calls.count } == 1)
  h.presenter.dismiss(success: true)
  try await task.value
  #expect(h.presenter.revealed.isEmpty)
  #expect(h.source.state.withLock { $0.reads } == 4)
}

@Test(arguments: ["cancel", "settings", "background", "runtime", "mutation", "expiry"])
@MainActor func backupLateAuthenticationCannotSurviveRevocation(_ reason: String) async throws {
  let h = BackupHarness(), settings = try await h.ready(), task = h.start(settings)
  _ = await h.authentication.started()
  switch reason {
  case "cancel": h.owner.cancelBackup(runtime: "backup_runtime_fixture_0001", settings: settings)
  case "settings": h.owner.dismissSettings(runtime: "backup_runtime_fixture_0001", settings: settings)
  case "background": h.owner.updateApplication(foreground: false, protectedData: true)
  case "runtime": h.owner.disposeRuntime("backup_runtime_fixture_0001")
  case "mutation": h.owner.willMutateVault()
  default: h.clock.advance(.seconds(60))
  }
  h.authentication.finish(success: true)
  await #expect(throws: DeletionActionFailure.denied) { try await task.value }
  #expect(h.reader.state.withLock { $0.calls.isEmpty })
}

@Test @MainActor func nativeBackupAndDeletionCannotOverlapOrExchangeAuthority() async throws {
  let h = BackupHarness(), settings = try await h.ready(), backup = h.start(settings)
  _ = await h.authentication.started()
  await #expect(throws: DeletionActionFailure.busy) {
    try await h.owner.authorizeDeletion(runtime: "backup_runtime_fixture_0001", settings: settings, target: key(1))
  }
  #expect(h.deletion.calls == 0)
  h.owner.cancelBackup(runtime: "backup_runtime_fixture_0001", settings: settings)
  h.authentication.finish(success: true)
  await #expect(throws: DeletionActionFailure.denied) { try await backup.value }
  #expect(throws: DeletionActionFailure.denied) {
    try h.owner.consumeDeletionGrant(token: "backup_attempt_cannot_be_deletion_token", targetPubkey: key(1))
  }
}

@Test @MainActor func actionBindingValidatesBackupArgumentsAndNeverReturnsSecretMaterial() async throws {
  let h = BackupHarness()
  h.owner.updateApplication(foreground: true, protectedData: true)
  let lease = try NativeIdentityRuntimeLease(authority: h.owner, entropy: TestEntropy())
  try lease.didBindMainRuntime()
  let binding = IdentityActionsBinding(); try binding.install(lease)
  let settings = try await binding.beginSettings(selected: key(2), revision: 1)
  await #expect(throws: DeletionActionFailure.denied) {
    try await binding.showBackup(session: settings, target: key(1), selected: key(2), revision: 1)
  }
  await #expect(throws: DeletionActionFailure.staleContext) {
    try await binding.showBackup(session: settings, target: key(2), selected: key(1), revision: 1)
  }
  let showing = Task { try await binding.showBackup(session: settings, target: key(2), selected: key(2), revision: 1) }
  _ = await h.authentication.started(); h.authentication.finish(success: true)
  _ = await h.presenter.started(); h.presenter.dismiss(success: true)
  let result: Void = try await showing.value
  _ = result
}

@Test @MainActor func malformedOrUnconfiguredBackupCannotReachAuthenticationOrSecretRead() async throws {
  let h = BackupHarness(), settings = try await h.ready()
  await #expect(throws: DeletionActionFailure.invalidInput) {
    try await h.owner.showBackup(runtime: "backup_runtime_fixture_0001", settings: settings, target: "bad")
  }
  let unavailable = DeletionGrantAuthority(readInventory: { backupInventory() }, authentication: h.deletion,
    clock: h.clock, entropy: TestEntropy())
  try unavailable.replaceRuntime("backup_runtime_fixture_0002")
  unavailable.updateApplication(foreground: true, protectedData: true)
  unavailable.validatedInventory(backupInventory())
  try await unavailable.setContext(runtime: "backup_runtime_fixture_0002", expectedSelected: key(2), expectedRevision: 1)
  let unavailableSettings = try unavailable.beginSettings(runtime: "backup_runtime_fixture_0002")
  await #expect(throws: DeletionActionFailure.unavailable) {
    try await unavailable.showBackup(runtime: "backup_runtime_fixture_0002", settings: unavailableSettings, target: key(2))
  }
  #expect(h.authentication.calls.isEmpty)
  #expect(h.reader.state.withLock { $0.calls.isEmpty })
}

@Test @MainActor func visibleBackupIsClearedOnResignWithoutCancellingPrecedingAuthentication() async throws {
  let h = BackupHarness(), settings = try await h.ready(), task = h.start(settings)
  _ = await h.authentication.started()
  h.owner.applicationWillResignActive()
  #expect(h.presenter.resigns == 1)
  #expect(h.authentication.pending != nil)
  h.authentication.finish(success: true)
  _ = await h.presenter.started()
  h.owner.applicationWillResignActive()
  await #expect(throws: DeletionActionFailure.denied) { try await task.value }
  #expect(h.presenter.revealed.isEmpty)
}

@Test func nsecEncodingMatchesKnownNIP19VectorAndRejectsMalformedSecret() throws {
  #expect(try NostrSecretBech32.encode(Data((1...32).map(UInt8.init))) ==
    "nsec1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5z5tpwxqergd3c8g7rusqpqcc2y")
  #expect(throws: DeletionActionFailure.denied) { try NostrSecretBech32.encode(Data(repeating: 1, count: 31)) }
}

@Test func nativeStoreBackupReadRequiresExactSelectedInventory() async throws {
  let h = Harness(), store = h.owner()
  try await store.setItem("inventory", value: initialReceipt())
  try await store.setItem("secret.\(key(1))", value: secret(1))
  try await store.setItem("secret.\(key(2))", value: secret(2))
  try await store.setItem("inventory", value: readyReceipt(selected: 2))
  let inventory = try await store.validatedInventory()
  var bytes = try await store.readBackupSecret(pubkey: key(2), inventory: inventory)
  defer { bytes.resetBytes(in: 0..<bytes.count) }
  #expect(bytes == Data(repeating: 12, count: 32))
  await #expect(throws: StoreFailure.unauthorized) {
    try await store.readBackupSecret(pubkey: key(1), inventory: inventory)
  }
  var stale = inventory
  stale = NativeVaultInventory(vaultID: stale.vaultID, revision: 2, selectedPubkey: stale.selectedPubkey,
    receiptDigest: stale.receiptDigest, identityDigests: stale.identityDigests)
  await #expect(throws: StoreFailure.unauthorized) {
    try await store.readBackupSecret(pubkey: key(2), inventory: stale)
  }
}
