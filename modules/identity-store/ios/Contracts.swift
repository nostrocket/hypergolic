import Foundation
import Security

public enum StoreFailure: String, Error, Sendable {
  case unavailable, corruptState, recoveryRequired, invalidInput, itemConflict, unauthorized
}

public protocol KeychainBackend: Sendable {
  func hasLegacyStage() throws -> Bool
  func read(_ item: KeychainItem) throws -> Data?
  func add(_ item: KeychainItem, value: Data) throws
  func updateReceipt(_ value: Data) throws
}
public enum KeychainItem: String, Sendable { case wrappingKey = "wrapping-key", receipt = "inventory" }

public protocol EntropySource: Sendable { func bytes(count: Int) throws -> Data }
public struct SystemEntropy: EntropySource {
  public init() {}
  public func bytes(count: Int) throws -> Data {
    guard count > 0, count <= 64 else { throw StoreFailure.invalidInput }
    var data = Data(count: count)
    let status = data.withUnsafeMutableBytes { buffer in
      SecRandomCopyBytes(kSecRandomDefault, count, buffer.baseAddress!)
    }
    guard status == errSecSuccess else { data.resetBytes(in: 0..<data.count); throw StoreFailure.unavailable }
    return data
  }
}

/// The trusted native action owner checks exact pubkey/identity epoch/settings session/grant lifetime here.
public protocol DeletionAuthorization: Sendable { func consumeDeletion(pubkey: String, token: String) throws }

public protocol EncryptedFiles: Sendable {
  func hasArtifacts() throws -> Bool
  func prepare() throws
  func read(_ slot: SecretSlot) throws -> Data?
  func writeAtomically(_ slot: SecretSlot, data: Data) throws
  func remove(_ slot: SecretSlot) throws
}

public enum SecretSlot: Equatable, Sendable {
  case stage
  case secret(String)
  public init(key: String) throws {
    if key == "stage" { self = .stage; return }
    guard key.hasPrefix("secret."), Receipt.isPubkey(String(key.dropFirst(7))) else { throw StoreFailure.invalidInput }
    self = .secret(String(key.dropFirst(7)))
  }
  public var name: String {
    switch self { case .stage: return "stage"; case .secret(let key): return "secret.\(key)" }
  }
}

struct Receipt: Sendable {
  let vaultID: String
  let revision: UInt64
  let initialized: Bool
  let selectedPubkey: String?
  let pubkeys: Set<String>
  let text: String

  static func isID(_ value: String) -> Bool {
    value.utf8.count >= 16 && value.utf8.count <= 80 && value.utf8.allSatisfy { (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95 }
  }
  static func isPubkey(_ value: String) -> Bool {
    value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
  }
  static func integer(_ raw: Any) throws -> UInt64 {
    guard let n = raw as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite,
      n.doubleValue >= 0, n.doubleValue <= 9_007_199_254_740_991, n.doubleValue.rounded(.towardZero) == n.doubleValue else { throw StoreFailure.invalidInput }
    return n.uint64Value
  }
  static func array(_ text: String) throws -> [Any] {
    guard text.utf8.count <= 2048, text.utf8.allSatisfy({ (32...126).contains($0) }), let data = text.data(using: .utf8),
      let array = try? JSONSerialization.jsonObject(with: data) as? [Any] else { throw StoreFailure.invalidInput }
    return array
  }
  init(_ text: String) throws {
    let a = try Self.array(text)
    guard a.count == 6, a[0] as? String == "HGI1", let id = a[1] as? String, Self.isID(id),
      let identities = a[5] as? [[Any]], identities.count <= 16 else { throw StoreFailure.invalidInput }
    let revision = try Self.integer(a[2]), status = try Self.integer(a[3])
    guard status <= 1 else { throw StoreFailure.invalidInput }
    var keys = Set<String>()
    for identity in identities {
      guard identity.count == 3, let key = identity[0] as? String, Self.isPubkey(key), keys.insert(key).inserted,
        try Self.integer(identity[2]) <= 1 else { throw StoreFailure.invalidInput }
      _ = try Self.integer(identity[1])
    }
    if status == 1 {
      guard revision > 0, let selected = a[4] as? String, keys.contains(selected) else { throw StoreFailure.invalidInput }
    } else {
      guard revision == 0, keys.isEmpty, a[4] is NSNull else { throw StoreFailure.invalidInput }
    }
    self.vaultID = id; self.revision = revision; self.initialized = status == 1; self.selectedPubkey = a[4] as? String; self.pubkeys = keys; self.text = text
  }

  func payload(_ text: String, slot: SecretSlot) throws -> (pubkey: String, scalar: String) {
    let a = try Self.array(text)
    switch slot {
    case .secret(let key):
      guard a.count == 3, a[0] as? String == "HGK1", a[1] as? String == key,
        let scalar = a[2] as? String, Self.isPubkey(scalar) else { throw StoreFailure.invalidInput }
      return (key, scalar)
    case .stage:
      guard a.count == 6, a[0] as? String == "HGS1", let key = a[1] as? String, Self.isPubkey(key),
        let scalar = a[2] as? String, Self.isPubkey(scalar), a[3] as? String == vaultID,
        try Self.integer(a[4]) <= 1 else { throw StoreFailure.invalidInput }
      _ = try Self.integer(a[5])
      return (key, scalar)
    }
  }
}
