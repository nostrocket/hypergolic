import Foundation
import Synchronization
@testable import IdentitySecretStore

enum FaultMode: Sendable { case before, after, omit }
struct Fault: Sendable { let operation: String; let mode: FaultMode }

final class FakeKeychain: KeychainBackend, Sendable {
  struct State: Sendable { var values: [String: Data] = [:]; var fault: Fault?; var calls: [String] = [] }
  let state = Mutex(State())
  func hasLegacyStage() throws -> Bool { try step("legacy-stage", empty: false) { $0.values["stage"] != nil } }
  func step<T: Sendable>(_ operation: String, empty: T, action: (inout State) -> T) throws -> T {
    try state.withLock { state in
      state.calls.append(operation)
      let fault = state.fault?.operation == operation ? state.fault : nil
      if fault != nil { state.fault = nil }
      if fault?.mode == .before { throw StoreFailure.unavailable }
      let result = fault?.mode == .omit ? empty : action(&state)
      if fault?.mode == .after { throw StoreFailure.unavailable }
      return result
    }
  }
  func read(_ item: KeychainItem) throws -> Data? { try step("read:\(item.rawValue)", empty: nil) { $0.values[item.rawValue] } }
  func add(_ item: KeychainItem, value: Data) throws {
    if state.withLock({ $0.values[item.rawValue] != nil }) { throw StoreFailure.itemConflict }
    try step("add:\(item.rawValue)", empty: ()) { $0.values[item.rawValue] = value }
  }
  func updateReceipt(_ value: Data) throws {
    if state.withLock({ $0.values[KeychainItem.receipt.rawValue] == nil }) { throw StoreFailure.unavailable }
    try step("update:inventory", empty: ()) { $0.values[KeychainItem.receipt.rawValue] = value }
  }
}

final class FakeFiles: EncryptedFiles, Sendable {
  struct State: Sendable { var values: [String: Data] = [:]; var fault: Fault?; var calls: [String] = []; var prepared = false; var artifact = false }
  let state = Mutex(State())
  func step<T: Sendable>(_ operation: String, empty: T, action: (inout State) -> T) throws -> T {
    try state.withLock { state in
      state.calls.append(operation)
      let fault = state.fault?.operation == operation ? state.fault : nil
      if fault != nil { state.fault = nil }
      if fault?.mode == .before { throw StoreFailure.unavailable }
      let result = fault?.mode == .omit ? empty : action(&state)
      if fault?.mode == .after { throw StoreFailure.unavailable }
      return result
    }
  }
  func hasArtifacts() throws -> Bool { try step("artifacts", empty: false) { !$0.values.isEmpty || $0.artifact } }
  func prepare() throws { try step("prepare", empty: ()) { $0.prepared = true } }
  func read(_ slot: SecretSlot) throws -> Data? { try step("read:\(slot.name)", empty: nil) { $0.values[slot.name] } }
  func writeAtomically(_ slot: SecretSlot, data: Data) throws { try step("write:\(slot.name)", empty: ()) { $0.values[slot.name] = data } }
  func remove(_ slot: SecretSlot) throws { try step("remove:\(slot.name)", empty: ()) { $0.values[slot.name] = nil } }
}

final class TestEntropy: EntropySource, Sendable {
  struct State: Sendable { var calls = 0; var fail = false; var short = false }
  let state = Mutex(State())
  func bytes(count: Int) throws -> Data {
    try state.withLock { state in
      state.calls += 1
      if state.fail { throw StoreFailure.unavailable }
      return Data(repeating: UInt8(state.calls % 255), count: state.short ? count - 1 : count)
    }
  }
}
final class TestAuthorization: DeletionAuthorization, Sendable {
  struct State: Sendable { var calls: [String] = []; var allowed: String? }
  let state = Mutex(State())
  func consumeDeletion(pubkey: String, token: String) throws {
    try state.withLock { state in
      state.calls.append(pubkey)
      guard token == testDeletionToken, state.allowed == pubkey else { throw StoreFailure.unauthorized }
    }
  }
}

struct Harness {
  let keychain = FakeKeychain(), files = FakeFiles(), entropy = TestEntropy(), authorization = TestAuthorization()
  func owner() -> IdentityFileStore { IdentityFileStore(keychain: keychain, files: files, entropy: entropy, authorization: authorization) }
}
let vaultID = "fixture_vault_000001"
func key(_ n: Int) -> String { String(repeating: String(format: "%02x", n), count: 32) }
func json(_ value: [Any]) throws -> String { String(data: try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]), encoding: .utf8)! }
func initialReceipt(_ id: String = vaultID) throws -> String { try json(["HGI1", id, 0, 0, NSNull(), []]) }
func readyReceipt(revision: Int = 1, selected: Int = 1) throws -> String { try json(["HGI1", vaultID, revision, 1, key(selected), [[key(1), 42, 0], [key(2), 43, 1]]]) }
func secret(_ n: Int) throws -> String { try json(["HGK1", key(n), key(n + 10)]) }
func stage(_ n: Int = 1, id: String = vaultID) throws -> String { try json(["HGS1", key(n), key(n + 10), id, 0, 42]) }

let testDeletionToken = "fixture_deletion_token_000001"
