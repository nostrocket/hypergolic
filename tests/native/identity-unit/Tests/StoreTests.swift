import Foundation
import Testing
@testable import IdentitySecretStore

@Test func nativeFirstReceiptStageSecretAndRestartRoundTrip() async throws {
  let h = Harness(), store = h.owner()
  #expect(try await store.getItem("inventory") == nil)
  #expect(try await store.getItem("stage") == nil)
  try await store.setItem("inventory", value: initialReceipt())
  try await store.setItem("stage", value: stage())
  try await store.setItem("secret.\(key(1))", value: secret(1))
  try await store.setItem("inventory", value: readyReceipt())
  #expect(try await h.owner().getItem("stage") == stage())
  #expect(try await h.owner().getItem("secret.\(key(1))") == secret(1))
  #expect(h.entropy.state.withLock { $0.calls } == 1)
  let keychainStrings = h.keychain.state.withLock { $0.values.values.compactMap { String(data: $0, encoding: .utf8) } }
  #expect(keychainStrings.allSatisfy { !$0.contains("HGK1") && !$0.contains("HGS1") && !$0.contains(key(11)) })
  let ciphertexts = h.files.state.withLock { Array($0.values.values) }
  #expect(ciphertexts.allSatisfy { $0.starts(with: Data("HGIF1".utf8)) && $0.range(of: Data(key(11).utf8)) == nil })
}

@Test func realCryptoKitAuthenticationRejectsTamperTruncationSlotSwapAndWrongWrappingKey() async throws {
  let h = Harness(), store = h.owner()
  try await store.setItem("inventory", value: initialReceipt())
  try await store.setItem("secret.\(key(1))", value: secret(1))
  let original = h.files.state.withLock { $0.values["secret.\(key(1))"]! }
  for corrupt in [Data(original.dropLast()), Data("WRONG".utf8) + original.dropFirst(5)] {
    h.files.state.withLock { $0.values["secret.\(key(1))"] = corrupt }
    await #expect(throws: StoreFailure.corruptState) { try await store.getItem("secret.\(key(1))") }
  }
  var changed = original; changed[changed.count - 1] ^= 1
  h.files.state.withLock { $0.values["secret.\(key(1))"] = changed }
  await #expect(throws: StoreFailure.corruptState) { try await store.getItem("secret.\(key(1))") }
  h.files.state.withLock { $0.values["secret.\(key(2))"] = original }
  await #expect(throws: StoreFailure.corruptState) { try await store.getItem("secret.\(key(2))") }
  h.files.state.withLock { $0.values["secret.\(key(1))"] = original }
  h.keychain.state.withLock { $0.values["wrapping-key"] = try! JSONSerialization.data(withJSONObject: ["HGW1", vaultID, Data(repeating: 80, count: 32).base64EncodedString()]) }
  await #expect(throws: StoreFailure.corruptState) { try await store.getItem("secret.\(key(1))") }
}

@Test func existingKeyIsNeverOverwrittenEvenIfCiphertextIsUnreadable() async throws {
  let h = Harness(), store = h.owner(); try await store.setItem("inventory", value: initialReceipt())
  try await store.setItem("secret.\(key(1))", value: secret(1))
  let original = h.files.state.withLock { $0.values["secret.\(key(1))"]! }
  try await store.setItem("secret.\(key(1))", value: secret(1))
  #expect(h.files.state.withLock { $0.values["secret.\(key(1))"] } == original)
  let different = try json(["HGK1", key(1), key(15)])
  await #expect(throws: StoreFailure.itemConflict) { try await store.setItem("secret.\(key(1))", value: different) }
  h.files.state.withLock { $0.values["secret.\(key(1))"] = Data("broken".utf8) }
  await #expect(throws: StoreFailure.corruptState) { try await store.setItem("secret.\(key(1))", value: secret(1)) }
  #expect(h.files.state.withLock { $0.values["secret.\(key(1))"] } == Data("broken".utf8))
}

@Test func survivingKeychainWithMissingFilesExposesReceiptAndAbsenceWithoutRegeneration() async throws {
  let h = Harness(), store = h.owner(); try await store.setItem("inventory", value: initialReceipt())
  try await store.setItem("secret.\(key(1))", value: secret(1)); try await store.setItem("inventory", value: readyReceipt())
  h.files.state.withLock { $0.values = [:]; $0.prepared = false }
  #expect(try await h.owner().getItem("inventory") == readyReceipt())
  #expect(try await h.owner().getItem("secret.\(key(1))") == nil)
  await #expect(throws: StoreFailure.recoveryRequired) { try await h.owner().setItem("secret.\(key(1))", value: secret(1)) }
  await #expect(throws: StoreFailure.recoveryRequired) { try await h.owner().setItem("stage", value: stage()) }
  #expect(h.entropy.state.withLock { $0.calls } == 1)
  // The unchanged JS vault sees the initialized receipt + missing established key and enters recovery.
}

@Test func missingEitherKeychainItemNeverRegeneratesWrappingKey() async throws {
  for missing in ["wrapping-key", "inventory"] {
    let h = Harness(), store = h.owner(); try await store.setItem("inventory", value: initialReceipt())
    h.keychain.state.withLock { $0.values[missing] = nil }
    await #expect(throws: StoreFailure.recoveryRequired) { try await h.owner().getItem("inventory") }
    await #expect(throws: StoreFailure.recoveryRequired) { try await h.owner().setItem("inventory", value: initialReceipt()) }
    #expect(h.entropy.state.withLock { $0.calls } == 1)
  }
}

@Test func onlyAnExistingAuthenticatedStageCanRepairAMissingRecordedSecret() async throws {
  let h = Harness(), store = h.owner(); try await store.setItem("inventory", value: initialReceipt())
  try await store.setItem("stage", value: stage())
  try await store.setItem("secret.\(key(1))", value: secret(1))
  try await store.setItem("inventory", value: readyReceipt())
  h.files.state.withLock { $0.values["secret.\(key(1))"] = nil }
  let altered = try json(["HGK1", key(1), key(18)])
  await #expect(throws: StoreFailure.recoveryRequired) { try await store.setItem("secret.\(key(1))", value: altered) }
  try await store.setItem("secret.\(key(1))", value: secret(1))
  #expect(try await store.getItem("secret.\(key(1))") == secret(1))
  #expect(h.entropy.state.withLock { $0.calls } == 1)
}

@Test func fullInventoryFitsAndBooleanOrUnsafeReceiptNumbersAreRejected() async throws {
  let h = Harness(), store = h.owner(); try await store.setItem("inventory", value: initialReceipt())
  let identities: [[Any]] = (1...16).map { [key($0), 9_007_199_254_740_991 as UInt64, 1] }
  let full = try json(["HGI1", vaultID, 9_007_199_254_740_991 as UInt64, 1, key(1), identities])
  #expect(full.utf8.count <= 2048)
  try await store.setItem("inventory", value: full)
  #expect(try await store.getItem("inventory") == full)
  for number: Any in [true, -1, 1.5, 9_007_199_254_740_992 as UInt64] {
    let invalid = try json(["HGI1", vaultID, number, 1, key(1), identities])
    await #expect(throws: StoreFailure.invalidInput) { try await store.setItem("inventory", value: invalid) }
  }
}

@Test func orphanCiphertextOrTemporaryArtifactsWithoutKeychainBlockInitialization() async throws {
  let h = Harness(); h.files.state.withLock { $0.artifact = true }
  await #expect(throws: StoreFailure.recoveryRequired) { try await h.owner().getItem("inventory") }
  await #expect(throws: StoreFailure.recoveryRequired) { try await h.owner().setItem("inventory", value: initialReceipt()) }
  #expect(h.entropy.state.withLock { $0.calls } == 0)
}

@Test func legacySecureStoreReceiptOrStageCannotBeSilentlyIgnored() async throws {
  for item in ["inventory", "stage"] {
    let h = Harness()
    h.keychain.state.withLock { $0.values[item] = Data("legacy stored artifact".utf8) }
    await #expect(throws: StoreFailure.recoveryRequired) { try await h.owner().getItem("inventory") }
    await #expect(throws: StoreFailure.recoveryRequired) { try await h.owner().setItem("inventory", value: initialReceipt()) }
    #expect(h.entropy.state.withLock { $0.calls } == 0)
    #expect(h.keychain.state.withLock { $0.values[item] } == Data("legacy stored artifact".utf8))
  }
}

@Test func invalidPayloadSchemaAndUnboundSlotsAreRejectedBeforeFileMutation() async throws {
  let h = Harness(), store = h.owner(); try await store.setItem("inventory", value: initialReceipt())
  for value in ["null", "[]", "[\"HGK1\"]", String(repeating: "x", count: 2049), try json(["HGK1", key(2), key(11)])] {
    await #expect(throws: StoreFailure.invalidInput) { try await store.setItem("secret.\(key(1))", value: value) }
  }
  for slot in ["wrapping-key", "secret.../etc", "../stage", "secret.\(key(1).uppercased())x"] {
    await #expect(throws: StoreFailure.invalidInput) { try await store.getItem(slot) }
  }
  #expect(h.files.state.withLock { $0.values.isEmpty })
}

@Test(arguments: [FaultMode.before, .after, .omit]) func deletionAndReadbackPreserveUncertainOutcome(mode: FaultMode) async throws {
  let h = Harness(), store = h.owner(); try await store.setItem("inventory", value: initialReceipt())
  try await store.setItem("secret.\(key(1))", value: secret(1))
  h.authorization.state.withLock { $0.allowed = key(1) }
  h.files.state.withLock { $0.fault = Fault(operation: "remove:secret.\(key(1))", mode: mode) }
  if mode == .omit { try await store.deleteItem("secret.\(key(1))", deletionToken: testDeletionToken) }
  else { await #expect(throws: StoreFailure.unavailable) { try await store.deleteItem("secret.\(key(1))", deletionToken: testDeletionToken) } }
  #expect(try await store.getItem("secret.\(key(1))") == (mode == .after ? nil : secret(1)))
}

@Test func readErrorsRemainErrorsAndEntropyFailureWritesNoWrappingKey() async throws {
  let h = Harness()
  h.keychain.state.withLock { $0.fault = Fault(operation: "read:wrapping-key", mode: .before) }
  await #expect(throws: StoreFailure.unavailable) { try await h.owner().getItem("inventory") }
  h.entropy.state.withLock { $0.fail = true }
  await #expect(throws: StoreFailure.unavailable) { try await h.owner().setItem("inventory", value: initialReceipt()) }
  #expect(h.keychain.state.withLock { $0.values.isEmpty })
  h.entropy.state.withLock { $0.fail = false; $0.short = true }
  await #expect(throws: StoreFailure.unavailable) { try await h.owner().setItem("inventory", value: initialReceipt()) }
  #expect(h.keychain.state.withLock { $0.values.isEmpty })
}

@Test(arguments: [FaultMode.before, .after, .omit]) func wrappingKeyWriteFailureSeams(mode: FaultMode) async throws {
  let h = Harness(); h.keychain.state.withLock { $0.fault = Fault(operation: "add:wrapping-key", mode: mode) }
  await #expect(throws: StoreFailure.unavailable) { try await h.owner().setItem("inventory", value: initialReceipt()) }
  if mode == .after {
    await #expect(throws: StoreFailure.recoveryRequired) { try await h.owner().setItem("inventory", value: initialReceipt()) }
    #expect(h.entropy.state.withLock { $0.calls } == 1)
  } else {
    #expect(h.keychain.state.withLock { $0.values.isEmpty })
  }
}

@Test(arguments: [FaultMode.before, .after, .omit]) func receiptWriteFailureSeams(mode: FaultMode) async throws {
  let h = Harness(); h.keychain.state.withLock { $0.fault = Fault(operation: "add:inventory", mode: mode) }
  if mode == .omit { try await h.owner().setItem("inventory", value: initialReceipt()) }
  else { await #expect(throws: StoreFailure.unavailable) { try await h.owner().setItem("inventory", value: initialReceipt()) } }
  if mode == .after { #expect(try await h.owner().getItem("inventory") == initialReceipt()) }
  else {
    await #expect(throws: StoreFailure.recoveryRequired) { try await h.owner().getItem("inventory") }
    await #expect(throws: StoreFailure.recoveryRequired) { try await h.owner().setItem("inventory", value: initialReceipt()) }
  }
  #expect(h.entropy.state.withLock { $0.calls } == 1)
}

@Test(arguments: [FaultMode.before, .after, .omit]) func atomicCiphertextWriteFailureSeams(mode: FaultMode) async throws {
  let h = Harness(), store = h.owner(); try await store.setItem("inventory", value: initialReceipt())
  h.files.state.withLock { $0.fault = Fault(operation: "write:stage", mode: mode) }
  if mode == .omit { try await store.setItem("stage", value: stage()) }
  else { await #expect(throws: StoreFailure.unavailable) { try await store.setItem("stage", value: stage()) } }
  #expect(try await h.owner().getItem("stage") == (mode == .after ? stage() : nil))
  #expect(h.entropy.state.withLock { $0.calls } == 1)
}

@Test func exactNativeDeletionGrantCannotDeleteAnotherKeyOrSurviveRevocation() async throws {
  let h = Harness(), store = h.owner(); try await store.setItem("inventory", value: initialReceipt())
  try await store.setItem("secret.\(key(1))", value: secret(1)); try await store.setItem("secret.\(key(2))", value: secret(2))
  await #expect(throws: StoreFailure.unauthorized) { try await store.deleteItem("secret.\(key(1))", deletionToken: testDeletionToken) }
  h.authorization.state.withLock { $0.allowed = key(1) }
  await #expect(throws: StoreFailure.unauthorized) { try await store.deleteItem("secret.\(key(2))", deletionToken: testDeletionToken) }
  try await store.deleteItem("secret.\(key(1))", deletionToken: testDeletionToken)
  #expect(try await store.getItem("secret.\(key(1))") == nil)
  h.authorization.state.withLock { $0.allowed = nil }
  await #expect(throws: StoreFailure.unauthorized) { try await store.deleteItem("secret.\(key(2))", deletionToken: testDeletionToken) }
  await #expect(throws: StoreFailure.invalidInput) { try await store.deleteItem("inventory") }
  await #expect(throws: StoreFailure.invalidInput) { try await store.deleteItem("wrapping-key") }
}

@Test func sameRevisionRecoveryReceiptAllowedButForeignOrOlderReceiptRejected() async throws {
  let h = Harness(), store = h.owner(); try await store.setItem("inventory", value: initialReceipt())
  try await store.setItem("inventory", value: readyReceipt(revision: 3, selected: 1))
  try await store.setItem("inventory", value: readyReceipt(revision: 3, selected: 2))
  #expect(try await store.getItem("inventory") == readyReceipt(revision: 3, selected: 2))
  await #expect(throws: StoreFailure.itemConflict) { try await store.setItem("inventory", value: readyReceipt(revision: 2)) }
  await #expect(throws: StoreFailure.itemConflict) { try await store.setItem("inventory", value: initialReceipt("another_vault_000001")) }
  await #expect(throws: StoreFailure.invalidInput) { try await store.setItem("stage", value: stage(id: "another_vault_000001")) }
}
