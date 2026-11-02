import XCTest
import Foundation
import CryptoKit
import Synchronization
@testable import SignerProbe

private let assertionCount = Mutex(0)
private func check(_ value: Bool, file: StaticString = #filePath, line: UInt = #line) {
  assertionCount.withLock { $0 += 1 }; XCTAssertTrue(value, file: file, line: line)
}
private func denied(_ operation: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
  do { try await operation(); check(false, file: file, line: line) } catch { check(true, file: file, line: line) }
}
private final class Ports: KeychainBackend, EncryptedFiles, @unchecked Sendable {
  private struct State { var keys: [String: Data] = [:]; var record: Data?; var writes = 0; var adds = 0; var failWrite = false; var failAfterWrite = false; var gate: Gate? }
  final class Gate: @unchecked Sendable {
    let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
    func waitEntered() -> Bool { entered.wait(timeout: .now() + 3) == .success }
  }
  private let state = Mutex(State())
  var writes: Int { state.withLock { $0.writes } }
  var adds: Int { state.withLock { $0.adds } }
  var bytes: Data? { state.withLock { $0.record } }
  func failNextWrite() { state.withLock { $0.failWrite = true } }
  func failAfterNextWrite() { state.withLock { $0.failAfterWrite = true } }
  func corrupt() { state.withLock { if $0.record != nil { $0.record![8] ^= 1 } } }
  func removeRecord() { state.withLock { $0.record = nil } }
  func blockNextRead() -> Gate { let gate = Gate(); state.withLock { $0.gate = gate }; return gate }
  private func waitIfGated() {
    let gate = state.withLock { let gate = $0.gate; $0.gate = nil; return gate }
    if let gate { gate.entered.signal(); gate.release.wait() }
  }
  func hasLegacyStage() throws -> Bool { false }
  func read(_ item: KeychainItem) throws -> Data? { waitIfGated(); return state.withLock { $0.keys[item.rawValue] } }
  func add(_ item: KeychainItem, value: Data) throws {
    try state.withLock { guard $0.keys[item.rawValue] == nil else { throw StoreFailure.itemConflict }; $0.keys[item.rawValue] = value; $0.adds += 1 }
  }
  func updateReceipt(_ value: Data) throws { state.withLock { $0.keys[KeychainItem.receipt.rawValue] = value } }
  func hasArtifacts() throws -> Bool { state.withLock { $0.record != nil } }
  func prepare() throws { }
  func read(_ slot: SecretSlot) throws -> Data? { state.withLock { $0.record } }
  func writeAtomically(_ slot: SecretSlot, data: Data) throws {
    try state.withLock { $0.writes += 1; if $0.failWrite { $0.failWrite = false; throw StoreFailure.unavailable }; $0.record = data; if $0.failAfterWrite { $0.failAfterWrite = false; throw StoreFailure.unavailable } }
  }
  func remove(_ slot: SecretSlot) throws { removeRecord() }
}
/// Explicit native test authority models revocation/mutation serialization; production owner checks compile in the actual Pod.
private final class Permit: NativeSignerStorageAuthority, @unchecked Sendable {
  private let gate = NativeVaultMutationGate()
  private let capturedEpoch: UInt64
  init() { gate.update(foreground: true, protectedData: true); capturedEpoch = try! gate.epoch() }
  func close() { gate.close() }
  func invalidateActions() { gate.invalidateActions() }
  func current() -> Bool { gate.current(capturedEpoch) }
  func performMutation(_ operation: () throws -> Void) throws { try gate.mutate(capturedEpoch, operation: operation) }
}
private func snapshot(_ raw: String) throws -> (id: String, revision: UInt64, selected: String, count: Int) {
  let object = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as! [String: Any]
  check(Set(object.keys) == Set(["vaultId", "revision", "selectedPubkey", "identities", "pendingDeletion"]))
  let identities = object["identities"] as! [[String: Any]]
  check(identities.allSatisfy { Set($0.keys) == Set(["pubkey", "addedAt", "origin", "status"]) })
  return (object["vaultId"] as! String, (object["revision"] as! NSNumber).uint64Value, object["selectedPubkey"] as! String, identities.count)
}
private func storage(_ ports: Ports) -> NativeSignerVaultStorage { .init(keychain: ports, files: ports, entropy: SystemEntropy()) }
private func scalar(_ byte: UInt8) -> Data { var value = Data(count: 32); value[31] = byte; return value }

final class SignerCoreTests: XCTestCase, @unchecked Sendable {
  override func tearDown() { print("VAULT_PERSISTENCE_ASSERTIONS=\(assertionCount.withLock { let count = $0; $0 = 0; return count })"); super.tearDown() }
  func testGeneratedRecordColdOpenAndPublicInventory() async throws {
    let ports = Ports(), permit = Permit(), core = NativeVaultCore(testingStorage: storage(ports))
    let first = try await core.open(authority: permit, current: { permit.current() })
    let initial = try snapshot(first); check(initial.count == 1 && initial.revision == 1)
    check(ports.adds == 2 && ports.writes == 1)
    let reopened = try await NativeVaultCore(testingStorage: storage(ports)).open(authority: permit, current: { permit.current() })
    check(first == reopened); check(ports.writes == 1); check(ports.bytes?.starts(with: Data("HGSV1".utf8)) == true)
  }
  func testImportSelectAndDeletePersistAfterColdOpen() async throws {
    let ports = Ports(), permit = Permit(), core = NativeVaultCore(testingStorage: storage(ports))
    let first = try snapshot(await core.open(authority: permit, current: { permit.current() }))
    let key = try NativeVaultKey(secret: scalar(1)); defer { key.destroy() }
    let imported = try snapshot(await core.commitImport(key: key, vaultID: first.id, revision: first.revision, authority: permit, current: { permit.current() }))
    let importedPubkey = try key.publicKey(); check(imported.count == 2 && imported.revision == 2 && imported.selected == importedPubkey)
    let selected = try snapshot(await core.select(pubkey: first.selected, vaultID: first.id, revision: 2, authority: permit, current: { permit.current() }))
    check(selected.selected == first.selected && selected.revision == 3)
    let deleted = try snapshot(await core.delete(pubkey: imported.selected, vaultID: first.id, revision: 3, authority: permit, current: { permit.current() }))
    check(deleted.count == 1 && deleted.revision == 4)
    let cold = try snapshot(await NativeVaultCore(testingStorage: storage(ports)).open(authority: permit, current: { permit.current() }))
    check(cold.count == 1 && cold.revision == 4 && cold.selected == first.selected)
  }
  func testPersistedKeySignsExactEventAndNativeOnlyBackup() async throws {
    let ports = Ports(), permit = Permit(), core = NativeVaultCore(testingStorage: storage(ports))
    let first = try snapshot(await core.open(authority: permit, current: { permit.current() }))
    let key = try NativeVaultKey(secret: scalar(2)); defer { key.destroy() }
    let imported = try snapshot(await core.commitImport(key: key, vaultID: first.id, revision: 1, authority: permit, current: { permit.current() }))
    let json = "{\"pubkey\":\"\(imported.selected)\",\"created_at\":1791979200,\"kind\":1,\"tags\":[[\"r\",\"wss://example.com\"]],\"content\":\(ExactSignerEvent.quote("iOS native exact event 🛰️ /\u{2028}\u{2029}\n\t"))}"
    let event = try ExactSignerEvent(json: json, expectedPubkey: imported.selected)
    let signed = try await core.sign(event: event, vaultID: first.id, revision: 2, current: { permit.current() })
    let result = try JSONSerialization.jsonObject(with: Data(signed.utf8)) as! [String: Any]
    check(result["pubkey"] as? String == imported.selected); check(result["id"] as? String == event.digest.hex)
    let file = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("vault-signature.json")
    try Data(signed.utf8).write(to: file)
    var backup = try await core.backupSecret(pubkey: imported.selected, vaultID: first.id, revision: 2, current: { permit.current() })
    defer { backup.resetBytes(in: 0..<backup.count) }; check(backup == scalar(2))
  }
  func testPostWriteCancellationClosesCacheAndColdOpenShowsCommit() async throws {
    let ports = Ports(), permit = Permit(), core = NativeVaultCore(testingStorage: storage(ports))
    let first = try snapshot(await core.open(authority: permit, current: { permit.current() }))
    let key = try NativeVaultKey(secret: scalar(1)); defer { key.destroy() }; let importedPubkey = try key.publicKey()
    do {
      _ = try await core.commitImport(key: key, vaultID: first.id, revision: 1, authority: permit,
        current: { permit.current() && ports.writes < 2 })
      check(false)
    } catch let failure as NativeVaultFailure { check(failure.bridgeCode == "READBACK_FAILED") }
    check(ports.writes == 2)
    let cold = try snapshot(await NativeVaultCore(testingStorage: storage(ports)).open(authority: permit, current: { permit.current() }))
    check(cold.revision == 2 && cold.count == 2 && cold.selected == importedPubkey)
  }
  func testStaleRevisionWrongVaultAndSelectedDeletionDoNotWrite() async throws {
    let ports = Ports(), permit = Permit(), core = NativeVaultCore(testingStorage: storage(ports))
    let first = try snapshot(await core.open(authority: permit, current: { permit.current() })); let saved = ports.bytes
    await denied { _ = try await core.select(pubkey: first.selected, vaultID: first.id, revision: 2, authority: permit, current: { permit.current() }) }
    await denied { _ = try await core.select(pubkey: first.selected, vaultID: "wrong-vault-00000000", revision: 1, authority: permit, current: { permit.current() }) }
    await denied { _ = try await core.delete(pubkey: first.selected, vaultID: first.id, revision: 1, authority: permit, current: { permit.current() }) }
    check(ports.bytes == saved && ports.writes == 1)
  }
  func testBinaryCodecRejectsTruncationTrailingBytesAndWrongKey() throws {
    let key = try NativeVaultKey(secret: scalar(1)); defer { key.destroy() }
    var record = NativeVaultRecord(schema: 1, vaultId: "native-test-vault-0001", revision: 1, selectedPubkey: try key.publicKey(), identities: [.init(pubkey: try key.publicKey(), addedAt: 1, origin: .imported, secret: NativeVaultSecret(scalar(1)))])
    defer { record.clear() }; var encoded = try record.encoded(); defer { encoded.resetBytes(in: 0..<encoded.count) }
    check(encoded.starts(with: Data("HGVR2".utf8))); check(encoded.count < 256)
    var decoded = try NativeVaultRecord.decode(encoded); defer { decoded.clear() }; check(decoded.selectedPubkey == record.selectedPubkey)
    for invalid in [Data(encoded.dropLast()), encoded + Data([0]), Data(count: encoded.count)] {
      do { _ = try NativeVaultRecord.decode(invalid); check(false) } catch { check(true) }
    }
    var wrong = encoded; wrong[wrong.count - 2] = 2
    defer { wrong.resetBytes(in: 0..<wrong.count) }
    do { _ = try NativeVaultRecord.decode(wrong); check(false) } catch { check(true) }
  }
  func testCorruptionAndMissingRecordNeverRegenerate() async throws {
    let ports = Ports(), permit = Permit(), core = NativeVaultCore(testingStorage: storage(ports))
    _ = try await core.open(authority: permit, current: { permit.current() }); ports.corrupt()
    await denied { _ = try await core.open(authority: permit, current: { permit.current() }) }; check(ports.writes == 1 && ports.adds == 2)
    ports.removeRecord()
    await denied { _ = try await core.open(authority: permit, current: { permit.current() }) }; check(ports.writes == 1 && ports.adds == 2)
  }
  func testFailedInitialWriteLeavesRecoveryStateAndNoSuccess() async throws {
    let ports = Ports(), permit = Permit(), store = storage(ports); ports.failNextWrite()
    await denied { try await store.initialize(vaultID: "native-test-vault-0001", plaintext: Data([1]), authority: permit) }
    check(ports.adds == 2 && ports.writes == 1)
    await denied { _ = try await store.read() }
    await denied { try await store.initialize(vaultID: "native-test-vault-0001", plaintext: Data([2]), authority: permit) }; check(ports.adds == 2)
  }
  func testFailedReplacementCannotReportCommitOrChangeBytes() async throws {
    let ports = Ports(), permit = Permit(), store = storage(ports), old = Data([1, 2, 3])
    try await store.initialize(vaultID: "native-test-vault-0001", plaintext: old, authority: permit)
    let saved = ports.bytes; ports.failNextWrite()
    await denied { try await store.replace(vaultID: "native-test-vault-0001", expectedPlaintextDigest: Data(SHA256.hash(data: old)), plaintext: Data([4]), authority: permit) }
    check(ports.bytes == saved); check(try await store.read()?.plaintext == old)
  }
  func testFailureAfterDurableReplaceIsNeverPromotedToSuccess() async throws {
    let ports = Ports(), permit = Permit(), store = storage(ports), old = Data([1]), proposed = Data([2])
    try await store.initialize(vaultID: "native-test-vault-0001", plaintext: old, authority: permit)
    let saved = ports.bytes; ports.failAfterNextWrite()
    await denied { try await store.replace(vaultID: "native-test-vault-0001", expectedPlaintextDigest: Data(SHA256.hash(data: old)), plaintext: proposed, authority: permit) }
    check(ports.bytes != saved); check(try await store.read()?.plaintext == proposed)
    // A later matching read cannot turn the failed fsync/rename operation into a reported commit.
    check(ports.writes == 2)
  }
  func testQueuedInitializeRevokedBeforeMutationDoesNotCreateAnything() async throws {
    let ports = Ports(), permit = Permit(), store = storage(ports), gate = ports.blockNextRead()
    let blocking = Task { try await store.read() }; check(await Task.detached { gate.waitEntered() }.value)
    let queued = Task { try await store.initialize(vaultID: "native-test-vault-0001", plaintext: Data([1]), authority: permit) }
    permit.invalidateActions(); gate.release.signal(); _ = try await blocking.value
    await denied { try await queued.value }; check(ports.adds == 0 && ports.writes == 0 && ports.bytes == nil)
  }
  func testQueuedReplaceRevokedBeforeMutationPreservesDurableRecord() async throws {
    let ports = Ports(), permit = Permit(), store = storage(ports), old = Data([1])
    try await store.initialize(vaultID: "native-test-vault-0001", plaintext: old, authority: permit)
    let saved = ports.bytes, gate = ports.blockNextRead()
    let blocking = Task { try await store.read() }; check(await Task.detached { gate.waitEntered() }.value)
    let queued = Task { try await store.replace(vaultID: "native-test-vault-0001", expectedPlaintextDigest: Data(SHA256.hash(data: old)), plaintext: Data([2]), authority: permit) }
    permit.close(); gate.release.signal(); _ = try await blocking.value
    await denied { try await queued.value }; check(ports.bytes == saved && ports.writes == 1)
  }
  func testChangedDigestDeniesReplacement() async throws {
    let ports = Ports(), permit = Permit(), store = storage(ports)
    try await store.initialize(vaultID: "native-test-vault-0001", plaintext: Data([1]), authority: permit); let saved = ports.bytes
    await denied { try await store.replace(vaultID: "native-test-vault-0001", expectedPlaintextDigest: Data(count: 32), plaintext: Data([2]), authority: permit) }
    check(ports.bytes == saved && ports.writes == 1)
  }
  func testNativeMutationGateRejectsCancellationBetweenGestureAndPermit() throws {
    let gate = NativeVaultMutationGate(); gate.update(foreground: true, protectedData: true)
    let approvedEpoch = try gate.epoch(); gate.invalidateActions()
    var writes = 0
    do { try gate.mutate(approvedEpoch) { writes += 1 }; check(false) } catch { check(true) }
    check(writes == 0); check(!gate.current(approvedEpoch)); check(try gate.epoch() != approvedEpoch)
  }
  func testNativeMutationGateChecksConsumedCandidateDeadlineAtWrite() throws {
    let gate = NativeVaultMutationGate(); gate.update(foreground: true, protectedData: true)
    let epoch = try gate.epoch(), expired = ContinuousClock.now.advanced(by: .seconds(-1))
    var writes = 0
    do { try gate.mutate(epoch, deadline: expired) { writes += 1 }; check(false) } catch { check(true) }
    check(writes == 0)
    try gate.mutate(epoch, deadline: .now.advanced(by: .seconds(1))) { writes += 1 }; check(writes == 1)
    gate.close()
    do { try gate.mutate(epoch) { writes += 1 }; check(false) } catch { check(true) }; check(writes == 1)
  }
  func testOpaqueImportCandidateWrongRevisionConsumesAndWipes() throws {
    let pool = NativeVaultCandidatePool(), key = try NativeVaultKey(secret: scalar(1))
    let prepared = try JSONSerialization.jsonObject(with: Data(pool.prepare(key: key, vaultID: "native-test-vault-0001", revision: 1, epoch: 1).utf8)) as! [String: String]
    let handle = prepared["handle"]!
    do { _ = try NativeVaultCandidatePool().take(handle: handle, vaultID: "native-test-vault-0001", revision: 1, epoch: 1); check(false) } catch { check(true) }
    check(try key.publicKey() == prepared["pubkey"])
    do { _ = try pool.take(handle: handle, vaultID: "native-test-vault-0001", revision: 2, epoch: 1); check(false) } catch { check(true) }
    do { _ = try key.publicKey(); check(false) } catch { check(true) }
    do { _ = try pool.take(handle: handle, vaultID: "native-test-vault-0001", revision: 1, epoch: 1); check(false) } catch { check(true) }
  }
  func testConsumedImportKeyStillExpiresWhileConfirmationWaits() async throws {
    let pool = NativeVaultCandidatePool(testingLifetime: .milliseconds(30)), key = try NativeVaultKey(secret: scalar(1))
    let prepared = try JSONSerialization.jsonObject(with: Data(pool.prepare(key: key, vaultID: "native-test-vault-0001", revision: 1, epoch: 1).utf8)) as! [String: String]
    let candidate = try pool.take(handle: prepared["handle"]!, vaultID: "native-test-vault-0001", revision: 1, epoch: 1)
    check(try candidate.key.publicKey() == prepared["pubkey"])
    try await Task.sleep(for: .milliseconds(100))
    check(ContinuousClock.now >= candidate.expires)
    do { _ = try candidate.key.publicKey(); check(false) } catch { check(true) }
    let gate = NativeVaultMutationGate(); gate.update(foreground: true, protectedData: true); let epoch = try gate.epoch()
    var writes = 0
    do { try gate.mutate(epoch, deadline: candidate.expires) { writes += 1 }; check(false) } catch { check(true) }; check(writes == 0)
  }
  private func capturedApproval(approved: Bool = true) throws -> (ApprovalTransportRegistry, String, String) {
    let leases = CapabilityLeaseRegistry(), registry = ApprovalTransportRegistry(leases: leases, schedule: { _, _ in })
    check(leases.register("signer-native-test")); check(registry.register("signer-native-test"))
    registry.setForeground(true); registry.setFocused("signer-native-test", active: true)
    let key = try NativeVaultKey(secret: scalar(1)); defer { key.destroy() }; let pubkey = try key.publicKey()
    let event = try ExactSignerEvent(json: "{\"pubkey\":\"\(pubkey)\",\"created_at\":1,\"kind\":1,\"tags\":[[\"r\",\"wss://example.com\"]],\"content\":\"Exact native source\"}", expectedPubkey: pubkey)
    let template: [String: Any] = ["created_at": 1, "kind": 1, "tags": event.tags, "content": event.content]
    let request = String(decoding: try JSONSerialization.data(withJSONObject: ["type": "relay.publish", "id": "signer-test", "event": template]), as: UTF8.self)
    let original = String(decoding: try JSONSerialization.data(withJSONObject: ["registration": ["user": pubkey], "request": request]), as: UTF8.self)
    let review = String(decoding: try JSONSerialization.data(withJSONObject: ["event": template, "selectedPubkey": pubkey, "destinations": ["wss://example.com"], "hash": event.digest.hex]), as: UTF8.self)
    check(leases.consumeSequence("signer-native-test", sequence: 1))
    let token = registry.admit("signer-native-test", snapshot: original, wireId: "signer-test", reply: { _ in })!
    check(registry.take(token) == original); check(registry.prepareSigning(token, raw: review)); if approved { check(registry.approve(token)) }
    let captured = registry.signingSnapshot(token)!; return (registry, token, captured)
  }
  func testNativeSourceCancellationBeforeGestureCannotClaimSignature() throws {
    let (registry, token, captured) = try capturedApproval(); check(registry.isSigningLive(token))
    registry.cancel(token) // Same synchronous owning-registry operation invoked by the signer facade.
    var signatures = 0
    if registry.claimNativeSigning(token, expected: captured) { signatures += 1 }
    check(signatures == 0); check(!registry.isSigningLive(token)); check(registry.signingSnapshot(token) == nil)
  }
  func testNativeFocusedSourceAndExactCaptureCannotBeSubstituted() throws {
    let (registry, token, captured) = try capturedApproval()
    check(!registry.claimNativeSigning(token, expected: captured + " "))
    registry.setFocused("signer-native-test", active: false)
    check(!registry.isSigningLive(token)); check(!registry.claimNativeSigning(token, expected: captured))
  }
  func testV1LocalRecordReadsWithoutMutationAndUpgradesOnFirstWrite() async throws {
    let ports = Ports(), permit = Permit(), store = storage(ports), key = try NativeVaultKey(secret: scalar(1))
    defer { key.destroy() }; let pubkey = try key.publicKey(), id = "native-test-vault-0001"
    var legacy = Data("HGVR1".utf8); legacy.append(UInt8(id.utf8.count)); legacy.append(contentsOf: id.utf8)
    legacy.append(contentsOf: [0, 0, 0, 0, 0, 0, 0, 1]); legacy.append(contentsOf: pubkey.utf8); legacy.append(1)
    legacy.append(contentsOf: pubkey.utf8); legacy.append(contentsOf: [0, 0, 0, 0, 0, 0, 0, 1]); legacy.append(1); legacy.append(scalar(1))
    defer { legacy.resetBytes(in: 0..<legacy.count) }
    try await store.initialize(vaultID: id, plaintext: legacy, authority: permit)
    let core = NativeVaultCore(testingStorage: store), first = try snapshot(await core.open(authority: permit, current: { permit.current() }))
    check(first.selected == pubkey && ports.writes == 1)
    let methods = try JSONSerialization.jsonObject(with: Data(await core.methods(pubkey: pubkey, vaultID: id, revision: 1, current: { permit.current() }).utf8)) as! [String: Any]
    check(methods["selectedMethod"] as? String == "local"); check((methods["methods"] as? [[String: String]]) == [["kind": "local"]])
    let other = try NativeVaultKey(secret: scalar(2)); defer { other.destroy() }
    _ = try await core.commitImport(key: other, vaultID: id, revision: 1, authority: permit, current: { permit.current() })
    var upgraded = try await store.read()!.plaintext; defer { upgraded.resetBytes(in: 0..<upgraded.count) }
    check(upgraded.starts(with: Data("HGVR2".utf8))); check(ports.writes == 2)
  }
  func testMethodMetadataKeepsLocalAndRemoteDistinctAndNoImplicitFallback() throws {
    let user = try NativeVaultKey(secret: scalar(1)), peer = try NativeVaultKey(secret: scalar(3))
    defer { user.destroy(); peer.destroy() }
    let pubkey = try user.publicKey(), remote = NativeVaultRemoteMethod(peerPubkey: try peer.publicKey(), relays: ["wss://example.com"], transportSecret: NativeVaultSecret(scalar(2)))
    var record = NativeVaultRecord(schema: 2, vaultId: "native-test-vault-0001", revision: 1, selectedPubkey: pubkey,
      identities: [.init(pubkey: pubkey, addedAt: 1, origin: .imported, secret: NativeVaultSecret(scalar(1)), remote: remote, selectedMethod: .nip46)])
    defer { record.clear() }
    var encoded = try record.encoded(); defer { encoded.resetBytes(in: 0..<encoded.count) }
    var decoded = try NativeVaultRecord.decode(encoded); defer { decoded.clear() }
    let object = try JSONSerialization.jsonObject(with: Data(decoded.methodSnapshot(pubkey: pubkey).utf8)) as! [String: Any]
    check(Set(object.keys) == Set(["vaultId", "revision", "pubkey", "selectedMethod", "methods"]))
    check(object["selectedMethod"] as? String == "nip46")
    let methods = object["methods"] as! [[String: Any]]
    check(methods.count == 2 && methods[0]["kind"] as? String == "local")
    check(Set(methods[1].keys) == Set(["kind", "peerPubkey", "relays"]))
    record.identities[0].selectedMethod = nil
    let disconnected = try JSONSerialization.jsonObject(with: Data(record.methodSnapshot(pubkey: pubkey).utf8)) as! [String: Any]
    check(disconnected["selectedMethod"] is NSNull)
    check(!NativeVaultRecord.isPoint(String(repeating: "0", count: 64))); check(!NativeVaultRecord.isPoint(String(repeating: "f", count: 64)))
  }
  func testReadOnlyMethodQueryPreservesPreparedImportHandle() async throws {
    let ports = Ports(), permit = Permit(), core = NativeVaultCore(testingStorage: storage(ports)), pool = NativeVaultCandidatePool()
    let first = try snapshot(await core.open(authority: permit, current: { permit.current() }))
    let key = try NativeVaultKey(secret: scalar(1))
    let prepared = try JSONSerialization.jsonObject(with: Data(pool.prepare(key: key, vaultID: first.id, revision: 1, epoch: 1).utf8)) as! [String: String]
    _ = try await core.methods(pubkey: first.selected, vaultID: first.id, revision: 1, current: { permit.current() })
    let candidate = try pool.take(handle: prepared["handle"]!, vaultID: first.id, revision: 1, epoch: 1); defer { candidate.key.destroy() }
    check(try candidate.key.publicKey() == prepared["pubkey"]); check(ports.writes == 1)
  }
  func testRemoteMethodsMutateOneRevisionAndNeverFallback() async throws {
    let ports = Ports(), permit = Permit(), core = NativeVaultCore(testingStorage: storage(ports))
    let first = try snapshot(await core.open(authority: permit, current: { permit.current() }))
    let peer = try NativeVaultKey(secret: scalar(3)), client = try NativeVaultKey(secret: scalar(2))
    defer { peer.destroy(); client.destroy() }; let revocations = Mutex(0)
    let revoke: @Sendable () -> Void = { revocations.withLock { $0 += 1 } }
    let connected = try snapshot(await core.commitRemote(pubkey: first.selected, peerPubkey: peer.publicKey(), relays: ["wss://example.com"], clientKey: client,
      vaultID: first.id, revision: 1, authority: permit, current: { permit.current() }, revokePending: revoke))
    check(connected.count == 1 && connected.revision == 2 && revocations.withLock { $0 == 1 })
    await denied { _ = try await core.commitRemote(pubkey: first.selected, peerPubkey: peer.publicKey(), relays: ["wss://example.com"], clientKey: client,
      vaultID: first.id, revision: 2, authority: permit, current: { permit.current() }, revokePending: revoke) }
    check(ports.writes == 2)
    _ = try await core.selectMethod(pubkey: first.selected, method: .local, vaultID: first.id, revision: 2, authority: permit, current: { permit.current() }, revokePending: revoke)
    _ = try await core.selectMethod(pubkey: first.selected, method: .local, vaultID: first.id, revision: 3, authority: permit, current: { permit.current() }, revokePending: revoke)
    check(ports.writes == 3 && revocations.withLock { $0 == 2 })
    _ = try await core.selectMethod(pubkey: first.selected, method: .nip46, vaultID: first.id, revision: 3, authority: permit, current: { permit.current() }, revokePending: revoke)
    _ = try await core.disconnectRemote(pubkey: first.selected, vaultID: first.id, revision: 4, authority: permit, current: { permit.current() }, revokePending: revoke)
    let methods = try JSONSerialization.jsonObject(with: Data(await core.methods(pubkey: first.selected, vaultID: first.id, revision: 5, current: { permit.current() }).utf8)) as! [String: Any]
    check(methods["selectedMethod"] is NSNull); check((methods["methods"] as! [[String: String]]) == [["kind": "local"]])
    let event = try ExactSignerEvent(json: "{\"pubkey\":\"\(first.selected)\",\"created_at\":1,\"kind\":1,\"tags\":[],\"content\":\"No fallback\"}", expectedPubkey: first.selected)
    await denied { _ = try await core.sign(event: event, vaultID: first.id, revision: 5, current: { permit.current() }) }
    check(ports.writes == 5 && revocations.withLock { $0 == 4 })
  }
  private enum RemoteFailurePoint: Sendable, Equatable { case firstPreflight, signingRequest, possibleSigningDispatch }
  func testSelectedOfflineRemoteNeverUsesAttachedLocalKey() async throws {
    try await verifyRemoteFailureDoesNotUseLocalKey(at: .firstPreflight)
  }
  func testSelectedRemoteSigningFailureNeverUsesAttachedLocalKey() async throws {
    try await verifyRemoteFailureDoesNotUseLocalKey(at: .signingRequest)
  }
  func testPossiblyDispatchedRemoteFailureNeverUsesAttachedLocalKey() async throws {
    try await verifyRemoteFailureDoesNotUseLocalKey(at: .possibleSigningDispatch)
  }
  private func verifyRemoteFailureDoesNotUseLocalKey(at failurePoint: RemoteFailurePoint) async throws {
    let ports = Ports(), permit = Permit()
    let setup = NativeVaultCore(testingStorage: storage(ports))
    let first = try snapshot(await setup.open(authority: permit, current: { permit.current() }))
    let peer = try NativeVaultKey(secret: scalar(3))
    let client = try NativeVaultKey(secret: scalar(2))
    defer { peer.destroy(); client.destroy() }
    let peerPubkey = try peer.publicKey(), clientPubkey = try client.publicKey()
    let relay = "wss://offline.example.org"
    let connected = try snapshot(await setup.commitRemote(pubkey: first.selected, peerPubkey: peerPubkey,
      relays: [relay], clientKey: client, vaultID: first.id, revision: first.revision,
      authority: permit, current: { permit.current() }, revokePending: {}))
    check(connected.count == 1 && connected.selected == first.selected)
    let event = try ExactSignerEvent(json: "{\"pubkey\":\"\(first.selected)\",\"created_at\":1,\"kind\":1,\"tags\":[],\"content\":\"Remote failure must not use attached local key\"}", expectedPubkey: first.selected)
    let exchanges = Mutex([String]())
    let signingDispatches = Mutex(0), dispatchState = NativeNip46DispatchState()
    let offline = NativeVaultCore(testingStorage: storage(ports), testingExchange: { address, subscription, wire, _, control, validate in
      check(address == relay)
      // Only the exchange is controlled. Core, encrypted vault read, restored key,
      // signed outer event and authenticated NIP-44 requests/replies are real.
      let envelope = try JSONSerialization.jsonObject(with: Data(wire.utf8)) as! [Any]
      check(envelope.count == 2 && envelope[0] as? String == "EVENT")
      let outer = envelope[1] as! [String: Any]
      let outerJSON = String(decoding: try JSONSerialization.data(withJSONObject: outer), as: UTF8.self)
      let verified = try NativeNostrSignedEvent(json: outerJSON, peer: clientPubkey,
        maximumBytes: NativeNip46Protocol.maximumEnvelope)
      check(verified.event.kind == 24133)
      check(outer["tags"] as? [[String]] == [["p", peerPubkey]])
      var plaintext = try peer.decryptAuthenticated(peer: clientPubkey,
        payload: Data((outer["content"] as! String).utf8))
      defer { plaintext.resetBytes(in: 0..<plaintext.count) }
      let request = try JSONSerialization.jsonObject(with: plaintext) as! [String: Any]
      let method = request["method"] as! String, parameters = request["params"] as! [String]
      exchanges.withLock { $0.append(method) }
      let result: Any
      switch method {
      case "get_public_key":
        check(parameters.isEmpty)
        if failurePoint == .firstPreflight { throw NativeSignerRelayTransport.Failure.unavailable }
        result = first.selected
      case "switch_relays":
        check(failurePoint != .firstPreflight && parameters.isEmpty)
        result = [relay]
      case "sign_event":
        check(failurePoint != .firstPreflight && parameters.count == 1)
        let requested = try ExactSignerEvent(json: parameters[0], expectedPubkey: first.selected)
        check(requested == event)
        if failurePoint == .possibleSigningDispatch {
          check(!dispatchState.possible)
          // Model one possible wire send through the production dispatch boundary,
          // then a lost response. The exchange performs no actual network I/O.
          try control.dispatch { signingDispatches.withLock { $0 += 1 } }
          check(dispatchState.possible)
          throw NativeSignerRelayTransport.Failure.uncertain
        }
        throw NativeSignerRelayTransport.Failure.unavailable
      default:
        throw NativeVaultFailure.signerResponseInvalid
      }
      // Use the existing native reply crypto and actual client validator for both preflights.
      var response = try JSONSerialization.data(withJSONObject: ["id": request["id"] as! String, "result": result])
      defer { response.resetBytes(in: 0..<response.count) }
      let reply = try NativeNip46Protocol.outer(plaintext: response, peer: clientPubkey,
        key: peer, now: UInt64(Date().timeIntervalSince1970))
      let subscriptionFrame = try JSONSerialization.jsonObject(with: Data(subscription.utf8)) as! [Any]
      let subscriptionID = subscriptionFrame[1] as! String
      let returned = "[\"EVENT\"," + ExactSignerEvent.quote(subscriptionID) + "," + reply + "]"
      check(try validate(returned))
      return returned
    })
    let beforeMethods = try await offline.methods(pubkey: first.selected, vaultID: first.id,
      revision: connected.revision, current: { permit.current() })
    let methods = try JSONSerialization.jsonObject(with: Data(beforeMethods.utf8)) as! [String: Any]
    let attached = methods["methods"] as! [[String: Any]]
    check(methods["selectedMethod"] as? String == "nip46")
    check(attached.count == 2 && attached[0]["kind"] as? String == "local"
      && attached[1]["kind"] as? String == "nip46")
    let beforeBytes = ports.bytes, beforeWrites = ports.writes
    var signedResult: String?
    do {
      signedResult = try await offline.sign(event: event, vaultID: first.id,
        revision: connected.revision, current: { permit.current() }, state: dispatchState)
      check(false)
    } catch let failure as NativeVaultFailure {
      check(failure == (failurePoint == .possibleSigningDispatch ? .signerUncertain : .signerUnavailable))
    }
    let expectedRequests = failurePoint == .firstPreflight ? ["get_public_key"]
      : ["get_public_key", "switch_relays", "sign_event"]
    check(signedResult == nil && exchanges.withLock { $0 == expectedRequests })
    if failurePoint == .possibleSigningDispatch {
      check(dispatchState.possible && signingDispatches.withLock { $0 == 1 })
    }
    check(ports.bytes == beforeBytes && ports.writes == beforeWrites)
    check(try await offline.methods(pubkey: first.selected, vaultID: first.id,
      revision: connected.revision, current: { permit.current() }) == beforeMethods)
    let unchanged = try snapshot(await offline.snapshot(vaultID: first.id,
      revision: connected.revision, current: { permit.current() }))
    check(unchanged.count == 1 && unchanged.selected == first.selected
      && unchanged.revision == connected.revision)
    // The key remains usable, but native local signing occurs only after explicit selection.
    let local = try snapshot(await offline.selectMethod(pubkey: first.selected, method: .local,
      vaultID: first.id, revision: connected.revision, authority: permit,
      current: { permit.current() }, revokePending: {}))
    let signed = try await offline.sign(event: event, vaultID: first.id,
      revision: local.revision, current: { permit.current() })
    check(try NativeNostrSignedEvent(json: signed, peer: first.selected).event == event)
    check(exchanges.withLock { $0 == expectedRequests })
    if failurePoint == .possibleSigningDispatch {
      check(signingDispatches.withLock { $0 == 1 })
    }
  }
  func testRemoteOnlyAccountLinksLocalWithoutDuplicateAndDeletionRetainsAccount() async throws {
    let ports = Ports(), permit = Permit(), core = NativeVaultCore(testingStorage: storage(ports))
    let first = try snapshot(await core.open(authority: permit, current: { permit.current() }))
    let user = try NativeVaultKey(secret: scalar(1)), peer = try NativeVaultKey(secret: scalar(3)), client = try NativeVaultKey(secret: scalar(2))
    defer { user.destroy(); peer.destroy(); client.destroy() }; let pubkey = try user.publicKey()
    let remote = try snapshot(await core.commitRemote(pubkey: pubkey, peerPubkey: peer.publicKey(), relays: ["wss://example.com"], clientKey: client,
      vaultID: first.id, revision: 1, authority: permit, current: { permit.current() }, revokePending: {}))
    check(remote.count == 2 && remote.selected == pubkey)
    let imported = try snapshot(await core.commitImport(key: user, vaultID: first.id, revision: 2, authority: permit, current: { permit.current() }))
    check(imported.count == 2 && imported.revision == 3)
    _ = try await core.deleteLocalKey(pubkey: pubkey, vaultID: first.id, revision: 3, authority: permit, current: { permit.current() }, revokePending: {})
    let methods = try JSONSerialization.jsonObject(with: Data(await core.methods(pubkey: pubkey, vaultID: first.id, revision: 4, current: { permit.current() }).utf8)) as! [String: Any]
    check(methods["selectedMethod"] is NSNull); check((methods["methods"] as! [[String: Any]]).count == 1)
    await denied { _ = try await core.backupSecret(pubkey: pubkey, vaultID: first.id, revision: 4, current: { permit.current() }) }
    let restored = try snapshot(await core.commitImport(key: user, vaultID: first.id, revision: 4, authority: permit, current: { permit.current() }))
    check(restored.count == 2 && restored.revision == 5)
    let cold = try snapshot(await NativeVaultCore(testingStorage: storage(ports)).open(authority: permit, current: { permit.current() }))
    check(cold.count == 2 && cold.revision == 5 && cold.selected == pubkey)
  }
  func testMethodMutationPostWriteCancellationRequiresReadbackRecovery() async throws {
    let ports = Ports(), permit = Permit(), core = NativeVaultCore(testingStorage: storage(ports))
    let first = try snapshot(await core.open(authority: permit, current: { permit.current() }))
    do {
      _ = try await core.deleteLocalKey(pubkey: first.selected, vaultID: first.id, revision: 1, authority: permit,
        current: { permit.current() && ports.writes < 2 }, revokePending: {})
      check(false)
    } catch let failure as NativeVaultFailure { check(failure.bridgeCode == "READBACK_FAILED") }
    let cold = try snapshot(await NativeVaultCore(testingStorage: storage(ports)).open(authority: permit, current: { permit.current() }))
    check(cold.revision == 2 && cold.count == 1)
    let methods = try JSONSerialization.jsonObject(with: Data(await core.methods(pubkey: first.selected, vaultID: first.id, revision: 2, current: { permit.current() }).utf8)) as! [String: Any]
    check(methods["selectedMethod"] is NSNull); check((methods["methods"] as! [Any]).isEmpty)
  }
  func testRefreshPersistsOnlyRelaysAndPreservesClientMethodAccountAfterColdOpen() async throws {
    let ports = Ports(), permit = Permit(), core = NativeVaultCore(testingStorage: storage(ports))
    let first = try snapshot(await core.open(authority: permit, current: { permit.current() }))
    let peer = try NativeVaultKey(secret: scalar(3)), client = try NativeVaultKey(secret: scalar(2)); defer { peer.destroy(); client.destroy() }
    _ = try await core.commitRemote(pubkey: first.selected, peerPubkey: peer.publicKey(), relays: ["wss://old.example.org"], clientKey: client,
      vaultID: first.id, revision: 1, authority: permit, current: { permit.current() }, revokePending: {})
    _ = try await core.selectMethod(pubkey: first.selected, method: .local, vaultID: first.id, revision: 2, authority: permit, current: { permit.current() }, revokePending: {})
    let restored = try await core.remoteCapability(pubkey: first.selected, vaultID: first.id, revision: 3, current: { permit.current() }); defer { restored.key.destroy() }
    check(try restored.key.publicKey() == client.publicKey()); check(restored.relays == ["wss://old.example.org"])
    let revocations = Mutex(0)
    let changed = try snapshot(await core.commitRemoteRefresh(pubkey: first.selected, peerPubkey: peer.publicKey(), relays: ["wss://new.example.org"], clientKey: restored.key,
      vaultID: first.id, revision: 3, authority: permit, current: { permit.current() }, revokePending: { revocations.withLock { $0 += 1 } }))
    check(changed.id == first.id && changed.revision == 4 && changed.selected == first.selected && changed.count == 1)
    check(revocations.withLock { $0 == 1 }); check(ports.writes == 4)
    let cold = NativeVaultCore(testingStorage: storage(ports)), reopened = try snapshot(await cold.open(authority: permit, current: { permit.current() }))
    check(reopened.revision == 4)
    let methods = try JSONSerialization.jsonObject(with: Data(await cold.methods(pubkey: first.selected, vaultID: first.id, revision: 4, current: { permit.current() }).utf8)) as! [String: Any]
    check(methods["selectedMethod"] as? String == "local")
    let rows = methods["methods"] as! [[String: Any]]; check(rows.count == 2 && rows[1]["relays"] as? [String] == ["wss://new.example.org"])
    let after = try await cold.remoteCapability(pubkey: first.selected, vaultID: first.id, revision: 4, current: { permit.current() }); defer { after.key.destroy() }
    check(try after.key.publicKey() == client.publicKey()); check(after.peer == restored.peer)
    _ = try await cold.commitRemoteRefresh(pubkey: first.selected, peerPubkey: peer.publicKey(), relays: ["wss://new.example.org"], clientKey: client,
      vaultID: first.id, revision: 4, authority: permit, current: { permit.current() }, revokePending: {})
    check(ports.writes == 4)
  }
  func testRefreshWrongCapabilityAndPreWriteCancelKeepStorageButLateCancelClosesCache() async throws {
    let ports = Ports(), permit = Permit(), core = NativeVaultCore(testingStorage: storage(ports))
    let first = try snapshot(await core.open(authority: permit, current: { permit.current() }))
    let peer = try NativeVaultKey(secret: scalar(3)), client = try NativeVaultKey(secret: scalar(2)), wrong = try NativeVaultKey(secret: scalar(4)); defer { peer.destroy(); client.destroy(); wrong.destroy() }
    _ = try await core.commitRemote(pubkey: first.selected, peerPubkey: peer.publicKey(), relays: ["wss://old.example.org"], clientKey: client,
      vaultID: first.id, revision: 1, authority: permit, current: { permit.current() }, revokePending: {})
    let before = ports.bytes
    await denied { _ = try await core.commitRemoteRefresh(pubkey: first.selected, peerPubkey: peer.publicKey(), relays: ["wss://new.example.org"], clientKey: wrong,
      vaultID: first.id, revision: 2, authority: permit, current: { permit.current() }, revokePending: {}) }
    await denied { _ = try await core.commitRemoteRefresh(pubkey: first.selected, peerPubkey: peer.publicKey(), relays: ["wss://new.example.org"], clientKey: client,
      vaultID: first.id, revision: 2, authority: permit, current: { false }, revokePending: {}) }
    check(ports.bytes == before && ports.writes == 2)
    do { _ = try await core.commitRemoteRefresh(pubkey: first.selected, peerPubkey: peer.publicKey(), relays: ["wss://new.example.org"], clientKey: client,
      vaultID: first.id, revision: 2, authority: permit, current: { permit.current() && ports.writes < 3 }, revokePending: {}); check(false) }
    catch let failure as NativeVaultFailure { check(failure.bridgeCode == "READBACK_FAILED") }
    let cold = try snapshot(await NativeVaultCore(testingStorage: storage(ports)).open(authority: permit, current: { permit.current() }))
    check(cold.revision == 3)
  }
  func testRefreshCandidatePurposeConfusionCancelAndConsumedExpiryDestroyKey() async throws {
    let pool = NativeVaultRemoteCandidates(), peer = try NativeVaultKey(secret: scalar(3)); defer { peer.destroy() }
    func prepare(_ key: NativeVaultKey, purpose: NativeVaultRemoteCandidates.Purpose, expires: ContinuousClock.Instant) throws -> String {
      let raw = try pool.prepare(pubkey: key.publicKey(), peer: peer.publicKey(), relays: ["wss://example.org"], key: key,
        vaultID: "native-test-vault-01", revision: 1, epoch: 1, expires: expires, purpose: purpose)
      return (try JSONSerialization.jsonObject(with: Data(raw.utf8)) as! [String: String])["handle"]!
    }
    let confused = try NativeVaultKey(secret: scalar(1)), wrongHandle = try prepare(confused, purpose: .refresh, expires: .now.advanced(by: .seconds(5)))
    do { _ = try pool.take(handle: wrongHandle, vaultID: "native-test-vault-01", revision: 1, epoch: 1); check(false) } catch { check(true) }
    do { _ = try confused.publicKey(); check(false) } catch { check(true) }
    let cancelled = try NativeVaultKey(secret: scalar(1)), cancelHandle = try prepare(cancelled, purpose: .refresh, expires: .now.advanced(by: .seconds(5)))
    let revocations = Mutex(0); pool.cancel(cancelHandle, beforeDestroy: { revocations.withLock { $0 += 1 } })
    check(revocations.withLock { $0 == 1 }); do { _ = try cancelled.publicKey(); check(false) } catch { check(true) }
    let expiring = try NativeVaultKey(secret: scalar(1)), expiryHandle = try prepare(expiring, purpose: .refresh, expires: .now.advanced(by: .milliseconds(20)))
    _ = try pool.take(handle: expiryHandle, vaultID: "native-test-vault-01", revision: 1, epoch: 1, purpose: .refresh)
    try await Task.sleep(for: .milliseconds(60))
    do { _ = try expiring.publicKey(); check(false) } catch { check(true) }; pool.release(expiryHandle)
  }
  func testPendingNativeHandoffBlocksPendingAndApprovedSourcesUntilBothNativeResumeAndReply() throws {
    for approved in [false, true] {
      let (registry, token, captured) = try capturedApproval(approved: approved), handoffs = NativeNip46HandoffRegistry()
      check(registry.claimNativeSigning(token, expected: captured))
      let ticket = NativeNip46Handoff(binding: .signing(kind: "approval", token: token, vaultID: "native-test-vault-01", revision: 1, eventID: "exact"), deadline: .now.advanced(by: .seconds(5)),
        current: { registry.isSigningLive(token) }, pause: { registry.pauseNativeSigning(token, paused: $0) }, cancel: { registry.cancel(token) }, show: { _, _ in })
      handoffs.install(ticket); try ticket.challenge(requestID: "native-original-id", url: "https://auth.example.org/fixture")
      check(!ticket.permitsExecution); check(!registry.isLive(token)); check(!registry.isApproved(token)); check(!registry.mayReview(token)); check(!registry.approve(token))
      check(ticket.arm()); check(handoffs.signingState(kind: "approval", token: token) == "pending")
      check(handoffs.signingState(kind: "upload", token: token) == nil); check(handoffs.signingState(kind: "approval", token: "wrong") == nil)
      check(ticket.requestResume()); check(!ticket.permitsExecution); check(!registry.isLive(token))
      try ticket.authenticated(requestID: "native-original-id")
      check(ticket.permitsExecution); check(registry.isLive(token)); check(handoffs.signingState(kind: "approval", token: token) == "resumed")
      if !approved { check(registry.approve(token)) }
      registry.setForeground(false)
      check(!ticket.permitsExecution); check(handoffs.signingState(kind: "approval", token: token) == nil)
      registry.setForeground(true); registry.resume(); check(!registry.isSigningLive(token)); check(!ticket.requestResume())
    }
  }
  func testForegroundRefreshPreservesOnlyPausedSourceWhileOriginConsentIsPending() throws {
    let (source, token, snapshot) = try capturedApproval(), registry = NativeNip46HandoffRegistry()
    check(source.claimNativeSigning(token, expected: snapshot))
    let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0), finished = DispatchSemaphore(value: 0), restored = Mutex(0)
    let ticket = NativeNip46Handoff(binding: .signing(kind: "approval", token: token, vaultID: "native-test-vault-01", revision: 1, eventID: "exact"), deadline: .now.advanced(by: .seconds(5)), current: { source.isSigningLive(token) },
      pause: { paused in
        guard source.pauseNativeSigning(token, paused: paused) else { return false }
        if paused { entered.signal(); _ = release.wait(timeout: .now() + 3) } else { restored.withLock { $0 += 1 } }; return true
      }, cancel: { source.cancel(token) }, show: { _, _ in })
    registry.install(ticket)
    DispatchQueue.global().async { do { try ticket.challenge(requestID: "original", url: "https://auth.example.org/fixture") } catch { check(false) }; finished.signal() }
    check(entered.wait(timeout: .now() + 2) == .success)
    // Exact production query occurs while pause callback is between effect denial and challenged phase.
    check(registry.signingState(kind: "approval", token: token) == "pending")
    check(registry.signingState(kind: "approval", token: "other") == nil)
    check(!source.isLive(token)); check(!source.isApproved(token)); check(!source.approve(token)); check(!ticket.permitsExecution)
    let foregroundRefreshRetainsSource = registry.signingState(kind: "approval", token: token) == "pending"
    check(foregroundRefreshRetainsSource); check(source.isSigningLive(token)); release.signal()
    check(finished.wait(timeout: .now() + 2) == .success)
    check(ticket.canPresentAuthentication); check(ticket.publicState == "pending"); check(!ticket.permitsExecution)
    ticket.cancel() // Rejected origin consent, before any browser opens or native Resume.
    check(ticket.publicState == nil); check(!source.isSigningLive(token)); check(restored.withLock { $0 == 0 })
  }
  func testNativeUploadAndFixtureStagePauseDenyDispatchUnderTheirEffectAuthority() throws {
    let bytes = Data("<html><body>Disposable native proof</body></html>".utf8), identity = String(repeating: "a", count: 64)
    let uploads = NativeUploadAuthority(clock: { 1_000 }); uploads.setForeground(true)
    let session = uploads.register("handoff-upload", identity: identity)!; uploads.focus(session)
    let request = uploads.admit(session, length: bytes.count, destination: "https://blossom.example.org", mimeType: "text/html")!
    check(uploads.append(request, offset: 0, chunk: bytes)); let review = uploads.seal(request)!, grant = uploads.approve(request, expected: review)!
    check(uploads.claimSigning(grant) === review); check(uploads.claimTransfer(grant)); check(uploads.pauseExecution(request, paused: true))
    check(!uploads.isApproved(grant)); check(uploads.dispatch(grant) == nil); check(!uploads.wasDispatched(grant)); check(uploads.contains(request))
    check(uploads.pauseExecution(request, paused: false)); check(uploads.dispatch(grant) == bytes); check(!uploads.pauseExecution(request, paused: true))
    let owner = FixtureReleaseAuthority(clock: { 1_000 }); owner.foreground(true); check(owner.synchronize(identity, epoch: 1, available: true))
    let row = owner.prepare("fixture", bytes: bytes, expectedHash: FixtureReleaseAuthority.hash(bytes), server: "https://blossom.example.org", tags: "[[\"d\",\"fixture\"]]")!
    check(owner.approveUpload(row.token)); check(owner.claimNativeSigning(row.token, manifest: false)); check(owner.pauseNativeSigning(row.token, manifest: false, paused: true))
    check(owner.current(row.token) == nil); check(!owner.uploadApproved(row.token)); check(owner.nativeSigningLifetime(row.token, manifest: false)); check(!owner.nativeSigningLifetime(row.token, manifest: true))
    check(!owner.uploads.claimTransfer(row.grant!)); check(owner.pauseNativeSigning(row.token, manifest: false, paused: false))
    check(owner.uploads.claimTransfer(row.grant!)); check(owner.uploads.dispatch(row.grant!) == bytes); check(owner.verifyRetrieved(row.token, bytes: bytes))
    check(owner.prepareManifest(row.token, snapshot: "{\"identity\":\"" + identity + "\"}")); check(owner.approveManifest(row.token) != nil)
    check(owner.claimNativeSigning(row.token, manifest: true)); check(owner.pauseNativeSigning(row.token, manifest: true, paused: true))
    check(owner.nativeSigningLifetime(row.token, manifest: true)); check(!owner.nativeSigningLifetime(row.token, manifest: false)); check(!owner.manifestApproved(row.token))
    check(owner.pauseNativeSigning(row.token, manifest: true, paused: false)); check(owner.manifestApproved(row.token))
    owner.foreground(false); check(!owner.nativeSigningLifetime(row.token, manifest: true)); check(!owner.pauseNativeSigning(row.token, manifest: true, paused: false))
  }
  func testCanceledOldDNSAndSafariCallbacksCannotTouchNewTicketPresentation() async throws {
    let registry = NativeNip46HandoffRegistry(), gate = Mutex(true), uiMutations = Mutex(0)
    func make(_ attempt: String) -> NativeNip46Handoff {
      NativeNip46Handoff(binding: .preparation(vaultID: "native-test-vault-01", revision: 1, attemptID: attempt, refresh: false), deadline: .now.advanced(by: .seconds(5)), current: { gate.withLock { $0 } }, show: { _, _ in })
    }
    for resuming in [false, true] {
      let old = make("old"); registry.install(old); try old.challenge(requestID: "old-id", url: "https://auth.example.org/fixture"); if resuming { check(old.arm()) }
      check(registry.permitsPresentation(old, resuming: resuming))
      let callback = Task { try await Task.sleep(for: .milliseconds(30)); if registry.permitsPresentation(old, resuming: resuming) { uiMutations.withLock { $0 += 1 } } }
      registry.cancelAll(); let next = make("new"); registry.install(next); try next.challenge(requestID: "new-id", url: "https://auth.example.org/fixture")
      try await callback.value
      check(uiMutations.withLock { $0 == 0 }); check(registry.permitsPresentation(next)); check(!registry.permitsPresentation(old, resuming: resuming))
      check(registry.preparationState(vaultID: "native-test-vault-01", revision: 1, attemptID: "old") == nil)
    }
    gate.withLock { $0 = false }; registry.cancelAll()
  }
  func testSynchronousOwnerRetirementCannotDeadlockHandoffQueriesOrArm() throws {
    final class Context: Sendable {}
    for operation in ["query", "arm"] {
      let owner = IdentityOwnerContextRegistry<Context>(), context = Context(), registry = NativeNip46HandoffRegistry()
      check(owner.admit(context)); let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0), retired = DispatchSemaphore(value: 0), completed = DispatchSemaphore(value: 0)
      let intercept = Mutex(false)
      let ticket = NativeNip46Handoff(binding: .preparation(vaultID: "native-test-vault-01", revision: 1, attemptID: "attempt", refresh: false), deadline: .now.advanced(by: .seconds(5)), current: {
        let block = intercept.withLock { value in let block = value; value = false; return block }
        if block { entered.signal(); _ = release.wait(timeout: .now() + 3) }; return owner.owns(context)
      }, show: { _, _ in })
      registry.install(ticket); check(owner.registerRevocation(context, revoke: { registry.cancelAll() }))
      try ticket.challenge(requestID: "native-id", url: "https://auth.example.org/fixture")
      intercept.withLock { $0 = true }
      DispatchQueue.global().async { if operation == "query" { _ = registry.preparationState(vaultID: "native-test-vault-01", revision: 1, attemptID: "attempt") } else { _ = ticket.arm() }; completed.signal() }
      check(entered.wait(timeout: .now() + 2) == .success)
      DispatchQueue.global().async { owner.retire(); retired.signal() }
      let retirementFinished = retired.wait(timeout: .now() + 1) == .success
      release.signal(); check(retirementFinished); check(completed.wait(timeout: .now() + 2) == .success)
      if !retirementFinished { _ = retired.wait(timeout: .now() + 2) }
      check(!owner.owns(context)); check(ticket.publicState == nil); check(!ticket.permitsExecution)
    }
  }
  func testContinuationExpiryWrongIdAndCancellationNeverRestoreEffect() async throws {
    let effects = Mutex(0), current = Mutex(true)
    let ticket = NativeNip46Handoff(binding: .preparation(vaultID: "native-test-vault-01", revision: 1, attemptID: "attempt", refresh: true), deadline: .now.advanced(by: .milliseconds(30)), current: { current.withLock { $0 } },
      pause: { paused in if !paused { effects.withLock { $0 += 1 } }; return true }, show: { _, _ in })
    try ticket.challenge(requestID: "original-id", url: "https://auth.example.org/fixture"); check(ticket.arm())
    do { try ticket.authenticated(requestID: "wrong-id"); check(false) } catch { check(true) }
    check(ticket.publicState == nil); check(effects.withLock { $0 == 0 })
    let expired = NativeNip46Handoff(binding: ticket.binding, deadline: .now.advanced(by: .milliseconds(20)), current: { current.withLock { $0 } },
      pause: { paused in if !paused { effects.withLock { $0 += 1 } }; return true }, show: { _, _ in })
    check(expired.publicState == nil)
    try expired.challenge(requestID: "original-id", url: "https://auth.example.org/fixture")
    check(expired.publicState == "pending"); check(!expired.permitsExecution) // Origin consent has not been accepted.
    try await Task.sleep(for: .milliseconds(50)); check(!expired.requestResume()); check(!expired.arm()); check(expired.publicState == nil)
    check(effects.withLock { $0 == 0 })
    for url in ["http://auth.example.org", "https://localhost", "https://127.0.0.1", "https://user@auth.example.org", "https://auth.example.org/#fragment", "https://auth.example.org/%0a"] {
      do { _ = try NativeSignerRelayPolicy.authenticationDestination(url); check(false) } catch { check(true) }
    }
  }
  func testNativeNip44PlatformHMACRoundtripAndMACDenial() throws {
    let client = try NativeVaultKey(secret: scalar(1)), peer = try NativeVaultKey(secret: scalar(2))
    defer { client.destroy(); peer.destroy() }
    var plain = Data("Native RPC 🛰️ with exact Unicode\n".utf8); defer { plain.resetBytes(in: 0..<plain.count) }
    var cipher = try client.encrypt(peer: peer.publicKey(), plaintext: plain); defer { cipher.resetBytes(in: 0..<cipher.count) }
    var decoded = try peer.decryptAuthenticated(peer: client.publicKey(), payload: cipher); defer { decoded.resetBytes(in: 0..<decoded.count) }
    check(decoded == plain)
    var damaged = Data(base64Encoded: cipher)!; damaged[damaged.count - 1] ^= 1
    let payload = damaged.base64EncodedData(); damaged.resetBytes(in: 0..<damaged.count)
    do { _ = try peer.decryptAuthenticated(peer: client.publicKey(), payload: payload); check(false) } catch { check(true) }
    do { _ = try client.encrypt(peer: String(repeating: "0", count: 64), plaintext: plain); check(false) } catch { check(true) }
  }
  func testNip46AuthenticatesOuterPeerBeforeDecryptionAndCorrelatesResponse() throws {
    let client = try NativeVaultKey(secret: scalar(1)), peer = try NativeVaultKey(secret: scalar(2)), wrong = try NativeVaultKey(secret: scalar(3))
    defer { client.destroy(); peer.destroy(); wrong.destroy() }; let id = UUID().uuidString.lowercased()
    var raw = Data(("{\"id\":\"" + id + "\",\"result\":\"" + (try wrong.publicKey()) + "\",\"error\":null}").utf8); defer { raw.resetBytes(in: 0..<raw.count) }
    let outer = try NativeNip46Protocol.outer(plaintext: raw, peer: client.publicKey(), key: peer, now: 1000)
    let result = try NativeNip46Protocol.response(outer: outer, peer: peer.publicKey(), key: client, id: id, now: 1000)!
    check(try NativeNip46Protocol.publicKey(result) == wrong.publicKey())
    check(try NativeNip46Protocol.response(outer: outer, peer: peer.publicKey(), key: client, id: UUID().uuidString.lowercased(), now: 1000) == nil)
    do { _ = try NativeNip46Protocol.response(outer: outer, peer: wrong.publicKey(), key: client, id: id, now: 1000); check(false) } catch { check(true) }
    do { _ = try NativeNip46Protocol.response(outer: outer, peer: peer.publicKey(), key: wrong, id: id, now: 1000); check(false) } catch { check(true) }
    do { _ = try NativeNip46Protocol.response(outer: outer, peer: peer.publicKey(), key: client, id: id, now: 1121); check(false) } catch { check(true) }
  }
  func testRemoteSignedEventMustMatchEveryReviewedField() throws {
    let user = try NativeVaultKey(secret: scalar(1)); defer { user.destroy() }; let pubkey = try user.publicKey()
    let event = try ExactSignerEvent(json: "{\"pubkey\":\"\(pubkey)\",\"created_at\":1,\"kind\":1,\"tags\":[],\"content\":\"Original 🛰️\"}", expectedPubkey: pubkey)
    let signed = try user.sign(event), verified = try NativeNostrSignedEvent(json: signed, peer: pubkey)
    check(try verified.matches(event) == signed)
    let altered = try ExactSignerEvent(json: event.unsignedJSON.replacingOccurrences(of: "Original", with: "Altered"), expectedPubkey: pubkey)
    do { _ = try verified.matches(altered); check(false) } catch { check(true) }
    do { _ = try NativeNostrSignedEvent(json: signed.replacingOccurrences(of: "Original", with: "Altered"), peer: pubkey); check(false) } catch { check(true) }
    do { _ = try NativeNostrSignedEvent(json: signed.dropLast() + ",\"kind\":1}", peer: pubkey); check(false) } catch { check(true) }
  }
  func testBunkerAndSwitchedRelaysUsePublicPolicyAndBoundedUniqueSet() throws {
    let peer = try NativeVaultKey(secret: scalar(2)); defer { peer.destroy() }; let pubkey = try peer.publicKey()
    var bunker = try NativeBunkerConnection("bunker://" + pubkey + "?relay=wss%3A%2F%2FEXAMPLE.com%3A443%2F&secret=test-native-token")
    defer { bunker.clear() }; check(bunker.relays == ["wss://example.com"]); check(bunker.token == Data("test-native-token".utf8))
    for raw in ["bunker://" + pubkey + "?relay=wss%3A%2F%2Flocalhost", "bunker://" + pubkey + "?relay=wss%3A%2F%2Fexample.com&relay=wss%3A%2F%2Fexample.com", "bunker://" + pubkey + "?relay=wss%3A%2F%2Fexample.com&unsupported=x"] {
      do { _ = try NativeBunkerConnection(raw); check(false) } catch { check(true) }
    }
    check(try NativeNip46Protocol.switchedRelays(.null, saved: bunker.relays) == bunker.relays)
    check(try NativeNip46Protocol.switchedRelays(.string("[\"wss://example.org\"]"), saved: bunker.relays) == ["wss://example.org"])
    check(try NativeNip46Protocol.switchedRelays(.array([.string("wss://example.org")]), saved: bunker.relays) == ["wss://example.org"])
    do { _ = try NativeNip46Protocol.switchedRelays(.array([.string("wss://example.org"), .string("wss://example.org")]), saved: bunker.relays); check(false) } catch { check(true) }
  }
  func testSimulatorAvailabilityHasNoStorageAccessAndNativeNsecRoundtrip() throws {
    check(!NativeSignerVaultStorage.isSupportedEnvironment)
    do { _ = try NativeSignerVaultStorage.applicationStore(); check(false) } catch { check(true) }
    var secret = scalar(1); defer { secret.resetBytes(in: 0..<secret.count) }
    let text = try NostrSecretBech32.encode(secret)
    var decoded = try NativeSignerSecretCodec.decodeNsec(text); defer { decoded.resetBytes(in: 0..<decoded.count) }; check(decoded == secret)
    do { _ = try NativeSignerSecretCodec.decodeNsec(text.uppercased()); check(false) } catch { check(true) }
  }
}
