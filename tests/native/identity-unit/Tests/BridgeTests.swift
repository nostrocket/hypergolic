import Foundation
import Synchronization
import Testing
@testable import IdentitySecretStore

/// Deterministic test-only authentication authority. Never calls LAContext or production Keychain.
final class FixtureGrantOwner: NativeIdentityGrantOwner, Sendable {
  struct State: Sendable {
    var token = testDeletionToken
    var pubkey = key(1)
    var action = "delete"
    var epoch = 7
    var currentEpoch = 7
    var settings = "settings-a"
    var currentSettings = "settings-a"
    var expiry = 101
    var now = 100
    var foreground = true
    var selectedReplacement = key(2)
    var usableReplacement = true
    var consumed = false
    var attempts: [String] = []
  }
  let state = Mutex(State())
  func consumeDeletionGrant(token: String, targetPubkey: String) throws {
    try state.withLock { state in
      state.attempts.append(token)
      guard token == state.token, targetPubkey == state.pubkey, state.action == "delete",
        state.epoch == state.currentEpoch, state.settings == state.currentSettings,
        state.now < state.expiry, state.foreground, state.usableReplacement,
        state.selectedReplacement != targetPubkey, !state.consumed else { throw StoreFailure.unauthorized }
      state.consumed = true
    }
  }
}

@Test func absentGrantProviderDeniesAndInstallationCannotBeReplaced() throws {
  let authority = NativeIdentityDeletionAuthority()
  #expect(throws: StoreFailure.unauthorized) { try authority.consumeDeletion(pubkey: key(1), token: testDeletionToken) }
  let owner = FixtureGrantOwner(); try authority.install(owner)
  #expect(throws: StoreFailure.itemConflict) { try authority.install(FixtureGrantOwner()) }
  try authority.consumeDeletion(pubkey: key(1), token: testDeletionToken)
  #expect(throws: StoreFailure.unauthorized) { try authority.consumeDeletion(pubkey: key(1), token: testDeletionToken) }
  #expect(owner.state.withLock { $0.consumed })
}

@Test func olderQueuedTokenCannotConsumeNewApprovalForSamePubkey() async throws {
  let h = Harness(), authority = NativeIdentityDeletionAuthority(), provider = FixtureGrantOwner()
  try authority.install(provider)
  let store = IdentityFileStore(keychain: h.keychain, files: h.files, entropy: h.entropy, authorization: authority)
  let bridge = IdentityBridgeOwner { store }
  try await bridge.writeInventory(initialReceipt())
  try await bridge.writeSecret(key(1), value: secret(1))
  let replacement = "fixture_new_deletion_token_000002"
  provider.state.withLock { $0.token = replacement }
  await #expect(throws: StoreFailure.unauthorized) { try await bridge.deleteSecret(key(1), token: testDeletionToken) }
  #expect(try await bridge.readSecret(key(1)) == secret(1))
  #expect(!provider.state.withLock { $0.consumed })
  try await bridge.deleteSecret(key(1), token: replacement)
  #expect(try await bridge.readSecret(key(1)) == nil)
  await #expect(throws: StoreFailure.unauthorized) { try await bridge.deleteSecret(key(1), token: replacement) }
  #expect(h.files.state.withLock { $0.calls.filter { $0 == "remove:secret.\(key(1))" }.count } == 1)
}

@Test(arguments: ["action", "pubkey", "epoch", "settings", "expiry", "background", "selected", "unusable", "consumed"])
func nativeOwnerRevalidatesAtErase(_ invalidation: String) async throws {
  let h = Harness(), authority = NativeIdentityDeletionAuthority(), provider = FixtureGrantOwner()
  try authority.install(provider)
  let store = IdentityFileStore(keychain: h.keychain, files: h.files, entropy: h.entropy, authorization: authority)
  let bridge = IdentityBridgeOwner { store }
  try await bridge.writeInventory(initialReceipt())
  try await bridge.writeSecret(key(1), value: secret(1))
  provider.state.withLock { state in
    switch invalidation {
    case "action": state.action = "export"
    case "pubkey": state.pubkey = key(2)
    case "epoch": state.currentEpoch += 1
    case "settings": state.currentSettings = "settings-b"
    case "expiry": state.now = state.expiry
    case "background": state.foreground = false
    case "selected": state.selectedReplacement = key(1)
    case "unusable": state.usableReplacement = false
    default: state.consumed = true
    }
  }
  await #expect(throws: StoreFailure.unauthorized) { try await bridge.deleteSecret(key(1), token: testDeletionToken) }
  #expect(try await bridge.readSecret(key(1)) == secret(1))
  #expect(h.files.state.withLock { !$0.calls.contains("remove:secret.\(key(1))") })
}

@Test func stageCleanupNeverConsumesDeletionGrantOrDeletesReceipt() async throws {
  let h = Harness(), authority = NativeIdentityDeletionAuthority(), provider = FixtureGrantOwner()
  try authority.install(provider)
  let store = IdentityFileStore(keychain: h.keychain, files: h.files, entropy: h.entropy, authorization: authority)
  let bridge = IdentityBridgeOwner { store }
  try await bridge.writeInventory(initialReceipt())
  try await bridge.writeStage(stage())
  await #expect(throws: StoreFailure.invalidInput) { try await store.deleteItem("stage", deletionToken: testDeletionToken) }
  try await bridge.deleteStage()
  #expect(try await bridge.readStage() == nil)
  #expect(try await bridge.readInventory() == initialReceipt())
  #expect(provider.state.withLock { $0.attempts.isEmpty })
}

@Test func malformedRequestsAreRejectedBeforeCreatingNativeStore() async throws {
  let calls = Mutex(0), h = Harness()
  let bridge = IdentityBridgeOwner { calls.withLock { $0 += 1 }; return h.owner() }
  for pubkey in ["../inventory", "inventory", "wrapping-key", String(repeating: "a", count: 63), String(repeating: "A", count: 64)] {
    await #expect(throws: StoreFailure.invalidInput) { try await bridge.readSecret(pubkey) }
    await #expect(throws: StoreFailure.invalidInput) { try await bridge.deleteSecret(pubkey, token: testDeletionToken) }
  }
  for payload in ["", "\n", "é", String(repeating: "a", count: 2049)] {
    await #expect(throws: StoreFailure.invalidInput) { try await bridge.writeStage(payload) }
    await #expect(throws: StoreFailure.invalidInput) { try await bridge.writeSecret(key(1), value: payload) }
  }
  for token in ["", "short", "../unsafe_grant_0001", String(repeating: "a", count: 129)] {
    await #expect(throws: StoreFailure.unauthorized) { try await bridge.deleteSecret(key(1), token: token) }
  }
  #expect(calls.withLock { $0 } == 0)
}

@Test func bridgePreservesAbsenceAndRetainsOneStoreAcrossCalls() async throws {
  let calls = Mutex(0), h = Harness()
  let bridge = IdentityBridgeOwner { calls.withLock { $0 += 1 }; return h.owner() }
  #expect(try await bridge.readInventory() == nil)
  try await bridge.writeInventory(initialReceipt())
  try await bridge.writeStage(stage())
  try await bridge.writeSecret(key(1), value: secret(1))
  #expect(try await bridge.readSecret(key(1)) == secret(1))
  #expect(try await bridge.readStage() == stage())
  #expect(calls.withLock { $0 } == 1)
  #expect(IdentityStoreProcess.owner === IdentityStoreProcess.owner)
}

@Test func unknownNativeErrorsBecomeUnavailableWithoutUnderlyingDescription() async throws {
  struct RawFailure: Error { let secretDescription = "sensitive-example-native-path-token" }
  let bridge = IdentityBridgeOwner { throw RawFailure() }
  await #expect(throws: StoreFailure.unavailable) { try await bridge.readInventory() }
  let codes = [StoreFailure.unavailable, .corruptState, .recoveryRequired, .invalidInput, .itemConflict, .unauthorized]
  #expect(Set(codes.map(\.bridgeCode)).count == codes.count)
  #expect(codes.allSatisfy { !$0.safeDescription.contains("sensitive-example") })
}

/// Inject an epoch transition after bridge admission, during the backing actor's receipt read.
private final class TransitionKeychain: KeychainBackend, Sendable {
  let base: FakeKeychain
  let provider: FixtureGrantOwner
  let armed = Mutex(false)
  init(base: FakeKeychain, provider: FixtureGrantOwner) { self.base = base; self.provider = provider }
  func hasLegacyStage() throws -> Bool { try base.hasLegacyStage() }
  func read(_ item: KeychainItem) throws -> Data? {
    let value = try base.read(item)
    if item == .receipt, armed.withLock({ if $0 { $0 = false; return true }; return false }) {
      provider.state.withLock { $0.currentEpoch += 1 }
    }
    return value
  }
  func add(_ item: KeychainItem, value: Data) throws { try base.add(item, value: value) }
  func updateReceipt(_ value: Data) throws { try base.updateReceipt(value) }
}
@Test func revocationAfterBridgeAdmissionBeforeErasePreservesSecret() async throws {
  let h = Harness(), provider = FixtureGrantOwner(), authority = NativeIdentityDeletionAuthority()
  try authority.install(provider)
  let keychain = TransitionKeychain(base: h.keychain, provider: provider)
  let store = IdentityFileStore(keychain: keychain, files: h.files, entropy: h.entropy, authorization: authority)
  let bridge = IdentityBridgeOwner { store }
  try await bridge.writeInventory(initialReceipt()); try await bridge.writeSecret(key(1), value: secret(1))
  keychain.armed.withLock { $0 = true }
  await #expect(throws: StoreFailure.unauthorized) { try await bridge.deleteSecret(key(1), token: testDeletionToken) }
  #expect(provider.state.withLock { $0.attempts == [testDeletionToken] && !$0.consumed })
  #expect(try await bridge.readSecret(key(1)) == secret(1))
  #expect(h.files.state.withLock { !$0.calls.contains("remove:secret.\(key(1))") })
}

/// Delays read replies deterministically to exercise admitted pending work, not thread sleeps.
private actor SuspendedInventoryStore: IdentityStoreBackend {
  var reads: [CheckedContinuation<String?, Never>] = []
  var full: CheckedContinuation<Void, Never>?
  var released = false
  func getItem(_ key: String) async throws -> String? {
    guard key == "inventory" else { throw StoreFailure.invalidInput }
    if released { return nil }
    return await withCheckedContinuation { continuation in
      reads.append(continuation)
      if reads.count == 32 { full?.resume(); full = nil }
    }
  }
  func waitUntilFull() async {
    if reads.count == 32 { return }
    await withCheckedContinuation { full = $0 }
  }
  func release() {
    released = true
    let pending = reads; reads = []
    for continuation in pending { continuation.resume(returning: nil) }
  }
  func setItem(_ key: String, value: String) throws { throw StoreFailure.invalidInput }
  func deleteItem(_ key: String, deletionToken: String?) throws { throw StoreFailure.invalidInput }
}
@Test func pendingCapRejectsOverflowAndCapacityReturnsAfterReplies() async throws {
  let store = SuspendedInventoryStore(), bridge = IdentityBridgeOwner { store }
  let requests = (0..<32).map { _ in Task { try await bridge.readInventory() } }
  await store.waitUntilFull()
  await #expect(throws: StoreFailure.unavailable) { try await bridge.readInventory() }
  await store.release()
  for request in requests { #expect(try await request.value == nil) }
  #expect(try await bridge.readInventory() == nil)
}
