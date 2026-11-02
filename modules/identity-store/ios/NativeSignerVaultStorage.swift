import Foundation
import CryptoKit

/// Revocation and protected mutation share this native-only synchronous critical section.
public protocol NativeSignerStorageAuthority: Sendable {
  func performMutation(_ operation: () throws -> Void) throws
}

/// Native-only fresh namespace. One authenticated record is the sole account commit boundary.
/// No Expo method returns its plaintext or selects its Keychain service, path, nonce or wrapping key.
public actor NativeSignerVaultStorage {
  public static let maximumBytes = 16_384
  private let keychain: any KeychainBackend
  private let files: any EncryptedFiles
  private let entropy: any EntropySource
  private let magic = Data("HGSV1".utf8)
  private struct Context {
    let vaultID: String
    let key: SymmetricKey
    var aad: Data { Data("[\"HGSV1\",\"native-signer-v1\",\"\(vaultID)\",\"record\"]".utf8) }
  }
  public init(keychain: any KeychainBackend, files: any EncryptedFiles, entropy: any EntropySource) {
    self.keychain = keychain; self.files = files; self.entropy = entropy
  }
  public static func applicationStore() throws -> NativeSignerVaultStorage {
    guard IdentityStoreAvailability.isSupportedEnvironment else { throw StoreFailure.unavailable }
    return NativeSignerVaultStorage(keychain: SystemKeychain.nativeSignerStore(),
      files: try ExcludedAtomicFiles.applicationSignerStore(), entropy: SystemEntropy())
  }
  public static var isSupportedEnvironment: Bool { IdentityStoreAvailability.isSupportedEnvironment }
  private func context() throws -> Context? {
    guard try !keychain.hasLegacyStage() else { throw StoreFailure.recoveryRequired }
    var bytes = try keychain.read(.wrappingKey)
    defer { if bytes != nil { bytes!.resetBytes(in: 0..<bytes!.count) } }
    let guardRecord = try keychain.read(.receipt)
    if bytes == nil && guardRecord == nil {
      guard try !files.hasArtifacts() else { throw StoreFailure.recoveryRequired }
      return nil
    }
    guard let key = bytes, key.count == 32, let guardRecord, guardRecord.count <= 128,
      let fields = try? JSONSerialization.jsonObject(with: guardRecord) as? [String], fields.count == 2,
      fields[0] == "HGSV1", Receipt.isID(fields[1]) else { throw StoreFailure.recoveryRequired }
    return Context(vaultID: fields[1], key: SymmetricKey(data: key))
  }
  private func decrypt(_ encrypted: Data, context: Context) throws -> Data {
    guard encrypted.starts(with: magic), encrypted.count >= magic.count + 28,
      encrypted.count <= Self.maximumBytes else { throw StoreFailure.corruptState }
    do {
      let sealed = try AES.GCM.SealedBox(combined: encrypted.dropFirst(magic.count))
      let plaintext = try AES.GCM.open(sealed, using: context.key, authenticating: context.aad)
      guard plaintext.count <= Self.maximumBytes - magic.count - 28 else { throw StoreFailure.corruptState }
      return plaintext
    } catch { throw StoreFailure.corruptState }
  }
  public func read() throws -> (vaultID: String, plaintext: Data)? {
    guard let context = try context() else { return nil }
    guard let encrypted = try files.read(.stage) else { throw StoreFailure.recoveryRequired }
    return (context.vaultID, try decrypt(encrypted, context: context))
  }
  /// Initialization is permitted only after a successful complete absent read.
  public func initialize(vaultID: String, plaintext: Data, authority: any NativeSignerStorageAuthority) throws {
    try authority.performMutation { try initializeCurrent(vaultID: vaultID, plaintext: plaintext) }
  }
  private func initializeCurrent(vaultID: String, plaintext: Data) throws {
    guard Receipt.isID(vaultID), try context() == nil,
      !plaintext.isEmpty, plaintext.count <= Self.maximumBytes - magic.count - 28 else { throw StoreFailure.itemConflict }
    try files.prepare()
    var wrapping = try entropy.bytes(count: 32)
    defer { wrapping.resetBytes(in: 0..<wrapping.count) }
    guard wrapping.count == 32 else { throw StoreFailure.unavailable }
    try keychain.add(.wrappingKey, value: wrapping)
    guard try keychain.read(.wrappingKey) == wrapping else { throw StoreFailure.unavailable }
    let receipt = try JSONSerialization.data(withJSONObject: ["HGSV1", vaultID])
    try keychain.add(.receipt, value: receipt)
    guard try keychain.read(.receipt) == receipt else { throw StoreFailure.unavailable }
    try write(plaintext, context: Context(vaultID: vaultID, key: SymmetricKey(data: wrapping)))
  }
  public func replace(vaultID: String, expectedPlaintextDigest: Data, plaintext: Data, authority: any NativeSignerStorageAuthority) throws {
    try authority.performMutation {
      try replaceCurrent(vaultID: vaultID, expectedPlaintextDigest: expectedPlaintextDigest, plaintext: plaintext)
    }
  }
  private func replaceCurrent(vaultID: String, expectedPlaintextDigest: Data, plaintext: Data) throws {
    guard let context = try context(), context.vaultID == vaultID,
      let encrypted = try files.read(.stage) else { throw StoreFailure.recoveryRequired }
    var current = try decrypt(encrypted, context: context)
    defer { current.resetBytes(in: 0..<current.count) }
    guard Data(SHA256.hash(data: current)) == expectedPlaintextDigest else { throw StoreFailure.itemConflict }
    try write(plaintext, context: context)
  }
  private func write(_ plaintext: Data, context: Context) throws {
    guard !plaintext.isEmpty, plaintext.count <= Self.maximumBytes - magic.count - 28 else { throw StoreFailure.invalidInput }
    let box = try AES.GCM.seal(plaintext, using: context.key, authenticating: context.aad)
    guard let combined = box.combined else { throw StoreFailure.unavailable }
    let encrypted = magic + combined
    // Flush/rename failures stay failures, even if a later read observes the proposed bytes.
    try files.writeAtomically(.stage, data: encrypted)
    guard let stored = try files.read(.stage), stored == encrypted else { throw StoreFailure.unavailable }
    var restored = try decrypt(stored, context: context)
    defer { restored.resetBytes(in: 0..<restored.count) }
    guard restored == plaintext else { throw StoreFailure.corruptState }
  }
}
