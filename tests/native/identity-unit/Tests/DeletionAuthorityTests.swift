import Foundation
import Synchronization
import HypergolicIdentityOwner
import Testing
@testable import IdentitySecretStore

private final class ManualClock: DeletionClock, Sendable {
  let time = Mutex(Duration.zero)
  func now() -> Duration { time.withLock { $0 } }
  func advance(_ duration: Duration) { time.withLock { $0 += duration } }
}
private final class InventorySource: Sendable {
  struct State: Sendable {
    var inventory: NativeVaultInventory
    var observer: (@Sendable (NativeVaultInventory) -> Void)?
    var fail = false
    var reads = 0
  }
  let state: Mutex<State>
  init(_ inventory: NativeVaultInventory) { state = Mutex(State(inventory: inventory)) }
  func read() throws -> NativeVaultInventory {
    let (inventory, observer) = try state.withLock { state in
      state.reads += 1
      if state.fail { throw StoreFailure.unavailable }
      return (state.inventory, state.observer)
    }
    observer?(inventory)
    return inventory
  }
}
@MainActor private final class ManualAuthentication: DeviceDeletionAuthentication {
  var pending: (UInt64, CheckedContinuation<Void, any Error>)?
  var waiter: CheckedContinuation<UInt64, Never>?
  var calls: [UInt64] = []
  var cancellations: [UInt64] = []
  var unavailable = false
  func authenticate(attemptID: UInt64, canPresent: @escaping @Sendable () -> Bool) async throws {
    guard !unavailable else { throw DeletionActionFailure.unavailable }
    guard pending == nil, canPresent() else { throw DeletionActionFailure.denied }
    calls.append(attemptID)
    try await withCheckedThrowingContinuation { continuation in
      pending = (attemptID, continuation)
      waiter?.resume(returning: attemptID); waiter = nil
    }
  }
  func started() async -> UInt64 {
    if let pending { return pending.0 }
    return await withCheckedContinuation { waiter = $0 }
  }
  func cancel(attemptID: UInt64) {
    cancellations.append(attemptID)
    guard let pending, pending.0 == attemptID else { return }
    self.pending = nil; pending.1.resume(throwing: DeletionActionFailure.denied)
  }
  func finish(success: Bool) {
    guard let pending else { Issue.record("No authentication attempt to complete"); return }
    self.pending = nil
    if success { pending.1.resume() } else { pending.1.resume(throwing: DeletionActionFailure.denied) }
  }
}
private func nativeInventory(selected: Int = 2, revision: UInt64 = 1) -> NativeVaultInventory {
  NativeVaultInventory(vaultID: vaultID, revision: revision, selectedPubkey: key(selected),
    receiptDigest: Data([UInt8(revision)]), identityDigests: [key(1): Data([1]), key(2): Data([2])])
}
private let runtimeA = "native_runtime_fixture_000001"
private let runtimeB = "native_runtime_fixture_000002"
@MainActor private struct AuthHarness {
  let source: InventorySource
  let clock = ManualClock()
  let auth = ManualAuthentication()
  let entropy = TestEntropy()
  let owner: DeletionGrantAuthority
  init() {
    let source = InventorySource(nativeInventory()); self.source = source
    owner = DeletionGrantAuthority(readInventory: { try source.read() }, authentication: auth, clock: clock, entropy: entropy)
    source.state.withLock { [weak owner] in $0.observer = { [weak owner] value in owner?.validatedInventory(value) } }
  }
  func ready() async throws -> String {
    try owner.replaceRuntime(runtimeA)
    owner.updateApplication(foreground: true, protectedData: true)
    try await owner.setContext(runtime: runtimeA, expectedSelected: key(2), expectedRevision: 1)
    return try owner.beginSettings(runtime: runtimeA)
  }
  func grant(_ settings: String, target: String = key(1)) async throws -> String {
    let task = Task { try await owner.authorizeDeletion(runtime: runtimeA, settings: settings, target: target) }
    _ = await auth.started(); auth.finish(success: true)
    return try await task.value
  }
}

@Test @MainActor func nativeGrantNeedsOwnedContextAndOneUseExactTargetToken() async throws {
  let h = AuthHarness()
  #expect(throws: DeletionActionFailure.staleContext) { try h.owner.beginSettings(runtime: runtimeA) }
  let settings = try await h.ready(), token = try await h.grant(settings)
  #expect(token.count == 64)
  #expect(throws: DeletionActionFailure.denied) { try h.owner.consumeDeletionGrant(token: token, targetPubkey: key(2)) }
  #expect(throws: DeletionActionFailure.denied) { try h.owner.consumeDeletionGrant(token: String(repeating: "a", count: 64), targetPubkey: key(1)) }
  try h.owner.consumeDeletionGrant(token: token, targetPubkey: key(1))
  #expect(throws: DeletionActionFailure.denied) { try h.owner.consumeDeletionGrant(token: token, targetPubkey: key(1)) }
  #expect(h.source.state.withLock { $0.reads } == 3)
}

@Test @MainActor func selectedMissingOrForgedCallerContextCannotReachAuthentication() async throws {
  let h = AuthHarness(), settings = try await h.ready()
  for target in [key(2), key(3)] {
    await #expect(throws: DeletionActionFailure.denied) { try await h.owner.authorizeDeletion(runtime: runtimeA, settings: settings, target: target) }
  }
  await #expect(throws: DeletionActionFailure.staleContext) { try await h.owner.setContext(runtime: runtimeA, expectedSelected: key(1), expectedRevision: 1) }
  await #expect(throws: DeletionActionFailure.staleContext) { try await h.owner.setContext(runtime: runtimeA, expectedSelected: key(2), expectedRevision: 2) }
  #expect(h.auth.calls.isEmpty)
}

@Test @MainActor func onlyOneAuthenticationOrUnconsumedGrantIsAllowed() async throws {
  let h = AuthHarness(), settings = try await h.ready()
  let task = Task { try await h.owner.authorizeDeletion(runtime: runtimeA, settings: settings, target: key(1)) }
  _ = await h.auth.started()
  await #expect(throws: DeletionActionFailure.busy) { try await h.owner.authorizeDeletion(runtime: runtimeA, settings: settings, target: key(1)) }
  h.auth.finish(success: true); let token = try await task.value
  await #expect(throws: DeletionActionFailure.busy) { try await h.owner.authorizeDeletion(runtime: runtimeA, settings: settings, target: key(1)) }
  try h.owner.consumeDeletionGrant(token: token, targetPubkey: key(1))
  #expect(h.auth.calls.count == 1)
}

@Test(arguments: ["background", "protected-data", "settings", "mutation", "replacement", "disposal"])
@MainActor func lateAuthenticationSuccessCannotSurviveRevocation(_ reason: String) async throws {
  let h = AuthHarness(), settings = try await h.ready()
  let task = Task { try await h.owner.authorizeDeletion(runtime: runtimeA, settings: settings, target: key(1)) }
  _ = await h.auth.started()
  switch reason {
  case "background": h.owner.updateApplication(foreground: false, protectedData: true)
  case "protected-data": h.owner.updateApplication(foreground: true, protectedData: false)
  case "settings": h.owner.dismissSettings(runtime: runtimeA, settings: settings)
  case "mutation": h.owner.willMutateVault()
  case "replacement": try h.owner.replaceRuntime(runtimeB)
  default: h.owner.disposeRuntime(runtimeA)
  }
  // Deliver success before the scheduled UI cancellation executes: logical revocation must already hold.
  h.auth.finish(success: true)
  await #expect(throws: DeletionActionFailure.denied) { try await task.value }
}

@Test(arguments: ["background", "protected-data", "settings", "mutation", "replacement", "disposal", "expiry"])
@MainActor func issuedGrantIsRevokedBeforeErase(_ reason: String) async throws {
  let h = AuthHarness(), settings = try await h.ready(), token = try await h.grant(settings)
  switch reason {
  case "background": h.owner.updateApplication(foreground: false, protectedData: true)
  case "protected-data": h.owner.updateApplication(foreground: true, protectedData: false)
  case "settings": h.owner.dismissSettings(runtime: runtimeA, settings: settings)
  case "mutation": h.owner.willMutateVault()
  case "replacement": try h.owner.replaceRuntime(runtimeB)
  case "disposal": h.owner.disposeRuntime(runtimeA)
  default: h.clock.advance(.seconds(15))
  }
  #expect(throws: DeletionActionFailure.denied) { try h.owner.consumeDeletionGrant(token: token, targetPubkey: key(1)) }
}

@Test @MainActor func inactiveDoesNotCancelButOldOwnerAndSettingsCleanupCannotRevokeNewOwner() async throws {
  let h = AuthHarness(), settings = try await h.ready()
  // Native lifecycle adapter maps foreground inactive to foreground=true; no resign-active event revokes.
  h.owner.updateApplication(foreground: true, protectedData: true)
  let token = try await h.grant(settings)
  h.owner.disposeRuntime(runtimeB)
  h.owner.dismissSettings(runtime: runtimeA, settings: "other_settings_fixture_0001")
  try h.owner.consumeDeletionGrant(token: token, targetPubkey: key(1))
  try h.owner.replaceRuntime(runtimeB)
  try await h.owner.setContext(runtime: runtimeB, expectedSelected: key(2), expectedRevision: 1)
  let current = try h.owner.beginSettings(runtime: runtimeB)
  h.owner.disposeRuntime(runtimeA)
  let task = Task { try await h.owner.authorizeDeletion(runtime: runtimeB, settings: current, target: key(1)) }
  _ = await h.auth.started(); h.auth.finish(success: true)
  let newToken = try await task.value
  try h.owner.consumeDeletionGrant(token: newToken, targetPubkey: key(1))
}

@Test @MainActor func expiredAuthenticationAndChangedNativeInventoryCannotMintToken() async throws {
  for change in ["expiry", "inventory"] {
    let h = AuthHarness(), settings = try await h.ready()
    let task = Task { try await h.owner.authorizeDeletion(runtime: runtimeA, settings: settings, target: key(1)) }
    _ = await h.auth.started()
    if change == "expiry" { h.clock.advance(.seconds(60)) }
    else { h.source.state.withLock { $0.inventory = nativeInventory(selected: 1, revision: 2) } }
    h.auth.finish(success: true)
    await #expect(throws: DeletionActionFailure.denied) { try await task.value }
  }
}

@Test @MainActor func unavailableCancelledOrFailedEntropyNeverProducesGrant() async throws {
  let unavailable = AuthHarness(), settings = try await unavailable.ready()
  unavailable.auth.unavailable = true
  await #expect(throws: DeletionActionFailure.unavailable) {
    try await unavailable.owner.authorizeDeletion(runtime: runtimeA, settings: settings, target: key(1))
  }
  let cancelled = AuthHarness(), next = try await cancelled.ready()
  let task = Task { try await cancelled.owner.authorizeDeletion(runtime: runtimeA, settings: next, target: key(1)) }
  _ = await cancelled.auth.started(); task.cancel(); cancelled.auth.finish(success: true)
  await #expect(throws: DeletionActionFailure.denied) { try await task.value }
  let entropyFailure = AuthHarness(), active = try await entropyFailure.ready()
  entropyFailure.entropy.state.withLock { $0.fail = true }
  let failing = Task { try await entropyFailure.owner.authorizeDeletion(runtime: runtimeA, settings: active, target: key(1)) }
  _ = await entropyFailure.auth.started(); entropyFailure.auth.finish(success: true)
  await #expect(throws: DeletionActionFailure.unavailable) { try await failing.value }
}

private struct DirectGrantPort: DeletionAuthorization {
  let owner: DeletionGrantAuthority
  func consumeDeletion(pubkey: String, token: String) throws { try owner.consumeDeletionGrant(token: token, targetPubkey: pubkey) }
}
@Test @MainActor func realBackingActorRefreshesProofConsumesThenInvalidatesItsOwnErase() async throws {
  let h = Harness(), auth = ManualAuthentication(), clock = ManualClock()
  let storeHandle = Mutex<IdentityFileStore?>(nil)
  let owner = DeletionGrantAuthority(readInventory: {
    guard let store = storeHandle.withLock({ $0 }) else { throw StoreFailure.unavailable }
    return try await store.validatedInventory()
  }, authentication: auth, clock: clock, entropy: TestEntropy())
  let store = IdentityFileStore(keychain: h.keychain, files: h.files, entropy: h.entropy,
    authorization: DirectGrantPort(owner: owner), stateObserver: owner)
  storeHandle.withLock { $0 = store }
  defer { storeHandle.withLock { $0 = nil } }
  try await store.setItem("inventory", value: initialReceipt())
  try await store.setItem("secret.\(key(1))", value: secret(1))
  try await store.setItem("secret.\(key(2))", value: secret(2))
  try await store.setItem("inventory", value: readyReceipt(selected: 2))
  try owner.replaceRuntime(runtimeA); owner.updateApplication(foreground: true, protectedData: true)
  try await owner.setContext(runtime: runtimeA, expectedSelected: key(2), expectedRevision: 1)
  let settings = try owner.beginSettings(runtime: runtimeA)
  let task = Task { try await owner.authorizeDeletion(runtime: runtimeA, settings: settings, target: key(1)) }
  _ = await auth.started(); auth.finish(success: true); let token = try await task.value
  // SQL's deletion tombstone is outside the protected store and does not invoke willMutateVault.
  try await store.deleteItem("secret.\(key(1))", deletionToken: token)
  #expect(try await store.getItem("secret.\(key(1))") == nil)
  #expect(try await store.getItem("secret.\(key(2))") == secret(2))
  #expect(throws: DeletionActionFailure.denied) { try owner.consumeDeletionGrant(token: token, targetPubkey: key(1)) }
  let finalReceipt = try json(["HGI1", vaultID, 2, 1, key(2), [[key(2), 43, 1]]])
  try await store.setItem("inventory", value: finalReceipt)
  #expect(try await store.validatedInventory().identityDigests.count == 1)
}

@Test @MainActor func nativeStoreMutationAndMissingSelectedFileDenyAnIssuedGrant() async throws {
  for change in ["mutation", "selected-file-loss"] {
    let h = Harness(), auth = ManualAuthentication(), storeHandle = Mutex<IdentityFileStore?>(nil)
    let owner = DeletionGrantAuthority(readInventory: {
      guard let store = storeHandle.withLock({ $0 }) else { throw StoreFailure.unavailable }
      return try await store.validatedInventory()
    }, authentication: auth, entropy: TestEntropy())
    let store = IdentityFileStore(keychain: h.keychain, files: h.files, entropy: h.entropy,
      authorization: DirectGrantPort(owner: owner), stateObserver: owner)
    storeHandle.withLock { $0 = store }
    defer { storeHandle.withLock { $0 = nil } }
    try await store.setItem("inventory", value: initialReceipt())
    try await store.setItem("secret.\(key(1))", value: secret(1))
    try await store.setItem("secret.\(key(2))", value: secret(2))
    try await store.setItem("inventory", value: readyReceipt(selected: 2))
    try owner.replaceRuntime(runtimeA); owner.updateApplication(foreground: true, protectedData: true)
    try await owner.setContext(runtime: runtimeA, expectedSelected: key(2), expectedRevision: 1)
    let settings = try owner.beginSettings(runtime: runtimeA)
    let task = Task { try await owner.authorizeDeletion(runtime: runtimeA, settings: settings, target: key(1)) }
    _ = await auth.started(); auth.finish(success: true); let token = try await task.value
    if change == "mutation" { try await store.setItem("stage", value: stage(3)) }
    else { h.files.state.withLock { $0.values["secret.\(key(2))"] = nil } }
    if change == "mutation" {
      await #expect(throws: DeletionActionFailure.denied) { try await store.deleteItem("secret.\(key(1))", deletionToken: token) }
    } else {
      await #expect(throws: StoreFailure.recoveryRequired) { try await store.deleteItem("secret.\(key(1))", deletionToken: token) }
    }
    #expect(try await store.getItem("secret.\(key(1))") == secret(1))
    #expect(h.files.state.withLock { !$0.calls.contains("remove:secret.\(key(1))") })
  }
}

@Test @MainActor func runtimeLeaseCannotActUntilBoundAndLateDisposalCannotRevokeReplacement() async throws {
  let h = AuthHarness()
  h.owner.updateApplication(foreground: true, protectedData: true)
  let firstEntropy = TestEntropy()
  let old = try NativeIdentityRuntimeLease(authority: h.owner, entropy: firstEntropy)
  #expect(throws: DeletionActionFailure.staleContext) { try old.beginSettings() }
  try old.didBindMainRuntime(); try await old.setContext(expectedSelected: key(2), expectedRevision: 1)
  let previousSettings = try old.beginSettings()
  let pending = Task { try await old.authorizeDeletion(settings: previousSettings, target: key(1)) }
  _ = await h.auth.started(); h.auth.finish(success: true); let oldToken = try await pending.value
  let newEntropy = TestEntropy(); newEntropy.state.withLock { $0.calls = 7 }
  let current = try NativeIdentityRuntimeLease(authority: h.owner, entropy: newEntropy)
  #expect(throws: DeletionActionFailure.denied) { try h.owner.consumeDeletionGrant(token: oldToken, targetPubkey: key(1)) }
  try current.didBindMainRuntime(); try await current.setContext(expectedSelected: key(2), expectedRevision: 1)
  let settings = try current.beginSettings(); old.dispose()
  let task = Task { try await current.authorizeDeletion(settings: settings, target: key(1)) }
  _ = await h.auth.started(); h.auth.finish(success: true)
  let token = try await task.value
  try h.owner.consumeDeletionGrant(token: token, targetPubkey: key(1))
}

@Test @MainActor func entropyFailureDuringReplacementLeavesPriorAuthorityRevoked() async throws {
  let h = AuthHarness(), settings = try await h.ready(), token = try await h.grant(settings)
  let failed = TestEntropy(); failed.state.withLock { $0.fail = true }
  #expect(throws: DeletionActionFailure.unavailable) { try NativeIdentityRuntimeLease(authority: h.owner, entropy: failed) }
  #expect(throws: DeletionActionFailure.denied) { try h.owner.consumeDeletionGrant(token: token, targetPubkey: key(1)) }
}

/// Models a later replacement starting while the older native entropy call has not returned.
private struct InterleavedReplacementEntropy: EntropySource {
  let onFill: @Sendable () throws -> Void
  func bytes(count: Int) throws -> Data {
    try onFill()
    return Data(repeating: 19, count: count)
  }
}

@Test @MainActor func lateOlderReplacementCannotOverwriteAnAlreadyStartedNewerOwner() async throws {
  let h = AuthHarness(), owner = h.owner
  owner.updateApplication(foreground: true, protectedData: true)
  let newer = Mutex<NativeIdentityRuntimeLease?>(nil)
  let entropy = InterleavedReplacementEntropy {
    let lease = try NativeIdentityRuntimeLease(authority: owner, entropy: TestEntropy())
    newer.withLock { $0 = lease }
  }
  #expect(throws: DeletionActionFailure.staleContext) { try NativeIdentityRuntimeLease(authority: owner, entropy: entropy) }
  let current = try #require(newer.withLock { $0 })
  try current.didBindMainRuntime()
  try await current.setContext(expectedSelected: key(2), expectedRevision: 1)
  let settings = try current.beginSettings()
  let pending = Task { try await current.authorizeDeletion(settings: settings, target: key(1)) }
  _ = await h.auth.started(); h.auth.finish(success: true)
  let token = try await pending.value
  try owner.consumeDeletionGrant(token: token, targetPubkey: key(1))
}

@MainActor private func actionBinding(_ h: AuthHarness) throws -> (IdentityActionsBinding, NativeIdentityRuntimeLease) {
  h.owner.updateApplication(foreground: true, protectedData: true)
  let lease = try NativeIdentityRuntimeLease(authority: h.owner, entropy: TestEntropy())
  try lease.didBindMainRuntime()
  let binding = IdentityActionsBinding(); try binding.install(lease)
  return (binding, lease)
}

@Test @MainActor func actionBindingChecksExactCommittedSelectionRevisionAndGrantWithoutConsuming() async throws {
  let h = AuthHarness(), (binding, _) = try actionBinding(h)
  let session = try await binding.beginSettings(selected: key(2), revision: 1)
  await #expect(throws: DeletionActionFailure.staleContext) { try await binding.authorizeDeletion(session: session, target: key(1), selected: key(1), revision: 1) }
  await #expect(throws: DeletionActionFailure.staleContext) { try await binding.authorizeDeletion(session: session, target: key(1), selected: key(2), revision: 2) }
  let task = Task { try await binding.authorizeDeletion(session: session, target: key(1), selected: key(2), revision: 1) }
  _ = await h.auth.started(); h.auth.finish(success: true); let token = try await task.value
  try binding.assertDeletionGrant(session: session, token: token, target: key(1))
  try binding.assertDeletionGrant(session: session, token: token, target: key(1))
  #expect(throws: DeletionActionFailure.denied) { try binding.assertDeletionGrant(session: session, token: token, target: key(2)) }
  try h.owner.consumeDeletionGrant(token: token, targetPubkey: key(1))
  #expect(throws: DeletionActionFailure.denied) { try binding.assertDeletionGrant(session: session, token: token, target: key(1)) }
}

@Test(arguments: ["cancel", "dismiss", "background", "runtime"])
@MainActor func actionBridgeLateAuthenticationCannotSurviveCancellation(_ reason: String) async throws {
  let h = AuthHarness(), (binding, lease) = try actionBinding(h)
  let session = try await binding.beginSettings(selected: key(2), revision: 1)
  let task = Task { try await binding.authorizeDeletion(session: session, target: key(1), selected: key(2), revision: 1) }
  _ = await h.auth.started()
  switch reason {
  case "cancel": try binding.cancelDeletion(session)
  case "dismiss": try binding.endSettings(session)
  case "background": h.owner.updateApplication(foreground: false, protectedData: true)
  default: lease.dispose()
  }
  h.auth.finish(success: true)
  await #expect(throws: DeletionActionFailure.denied) { try await task.value }
}

@Test @MainActor func cancelPreservesSessionButRevokesIssuedGrantAndDismissalDoesNotAffectNewSession() async throws {
  let h = AuthHarness(), (binding, _) = try actionBinding(h)
  let session = try await binding.beginSettings(selected: key(2), revision: 1)
  let task = Task { try await binding.authorizeDeletion(session: session, target: key(1), selected: key(2), revision: 1) }
  _ = await h.auth.started(); h.auth.finish(success: true); let token = try await task.value
  try binding.cancelDeletion(session)
  #expect(throws: DeletionActionFailure.denied) { try binding.assertDeletionGrant(session: session, token: token, target: key(1)) }
  let current = try await binding.beginSettings(selected: key(2), revision: 1)
  try binding.endSettings(session)
  let next = Task { try await binding.authorizeDeletion(session: current, target: key(1), selected: key(2), revision: 1) }
  _ = await h.auth.started(); h.auth.finish(success: true)
  try binding.assertDeletionGrant(session: current, token: try await next.value, target: key(1))
}

private final class NativeContextFixture: Sendable {}

@Test func exactNativeContextRegistryCannotReclaimRetiredAdmissionOrReplaceItsObserver() throws {
  let registry = IdentityOwnerContextRegistry<NativeContextFixture>()
  let context = NativeContextFixture(), other = NativeContextFixture()
  let calls = Mutex(0)
  #expect(registry.admit(context)); #expect(!registry.admit(other))
  #expect(registry.owns(context)); #expect(!registry.owns(other))
  let wrongContext = registry.registerRevocation(other, revoke: { calls.withLock { $0 += 100 } }); #expect(!wrongContext)
  let installed = registry.registerRevocation(context, revoke: { calls.withLock { $0 += 1 } }); #expect(installed)
  let rejected = registry.registerRevocation(context, revoke: { calls.withLock { $0 += 100 } }); #expect(!rejected)
  registry.retire(); registry.retire()
  #expect(calls.withLock { $0 } == 1)
  #expect(!registry.owns(context)); #expect(!registry.admit(other))
  let retired = registry.registerRevocation(context, revoke: { calls.withLock { $0 += 100 } }); #expect(!retired)
  let failed = IdentityOwnerContextRegistry<NativeContextFixture>()
  failed.retire(); #expect(!failed.admit(context))
}

@Test @MainActor func secondProcessClaimRetirementSynchronouslyRevokesBoundAuthority() async throws {
  let h = AuthHarness(), (binding, lease) = try actionBinding(h)
  let registry = IdentityOwnerContextRegistry<NativeContextFixture>(), context = NativeContextFixture()
  #expect(registry.admit(context)); let registered = registry.registerRevocation(context, revoke: { lease.dispose() }); #expect(registered)
  let session = try await binding.beginSettings(selected: key(2), revision: 1)
  let task = Task { try await binding.authorizeDeletion(session: session, target: key(1), selected: key(2), revision: 1) }
  _ = await h.auth.started(); h.auth.finish(success: true); let token = try await task.value
  registry.retire()
  #expect(throws: DeletionActionFailure.staleContext) { try binding.assertDeletionGrant(session: session, token: token, target: key(1)) }
  #expect(throws: DeletionActionFailure.denied) { try h.owner.consumeDeletionGrant(token: token, targetPubkey: key(1)) }
}

@Test func nativeContextAssociationDoesNotRetainADeadAppContextOrAdmitAReplacement() {
  let registry = IdentityOwnerContextRegistry<NativeContextFixture>()
  var context: NativeContextFixture? = NativeContextFixture()
  weak let observed = context
  #expect(registry.admit(context!))
  context = nil
  #expect(observed == nil)
  #expect(!registry.admit(NativeContextFixture()))
}

private final class NativeCallbackCounter: Sendable {
  private let value = Mutex(0)
  func increment() { value.withLock { $0 += 1 } }
  func read() -> Int { value.withLock { $0 } }
}

@Test func registeringAndRetiringConcurrentlyNeverLosesAnInstalledRevocation() async {
  for _ in 0..<64 {
    let registry = IdentityOwnerContextRegistry<NativeContextFixture>(), context = NativeContextFixture()
    let calls = NativeCallbackCounter()
    #expect(registry.admit(context))
    let installed = await withTaskGroup(of: Bool.self, returning: Bool.self) { group in
      group.addTask { registry.registerRevocation(context, revoke: { calls.increment() }) }
      group.addTask { registry.retire(); return false }
      var accepted = false
      for await result in group { accepted = accepted || result }
      return accepted
    }
    #expect(!registry.owns(context))
    #expect(calls.read() == (installed ? 1 : 0))
    #expect(!registry.admit(NativeContextFixture()))
  }
}
