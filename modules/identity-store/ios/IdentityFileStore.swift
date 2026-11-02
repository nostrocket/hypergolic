import CryptoKit
import Foundation

/// A single actor serializes all Keychain/file operations. Share exactly one instance with the JS vault owner.
public actor IdentityFileStore: IdentityStoreBackend, NativeBackupSecretReader {
  private let keychain: any KeychainBackend
  private let files: any EncryptedFiles
  private let entropy: any EntropySource
  private let authorization: any DeletionAuthorization
  private let stateObserver: (any NativeVaultStateObserver)?
  private let magic = Data("HGIF1".utf8)

  public init(keychain: any KeychainBackend, files: any EncryptedFiles, entropy: any EntropySource, authorization: any DeletionAuthorization, stateObserver: (any NativeVaultStateObserver)? = nil) {
    self.keychain = keychain; self.files = files; self.entropy = entropy; self.authorization = authorization; self.stateObserver = stateObserver
  }
  private struct Context {
    let receipt: Receipt
    let key: SymmetricKey
  }
  private func keyRecord(vaultID: String, key: Data) throws -> Data {
    guard key.count == 32 else { throw StoreFailure.unavailable }
    return try JSONSerialization.data(withJSONObject: ["HGW1", vaultID, key.base64EncodedString()])
  }
  private func context() throws -> Context? {
    // Any native error remains a failure; absence is only errSecItemNotFound / ENOENT.
    guard try !keychain.hasLegacyStage() else { throw StoreFailure.recoveryRequired }
    let rawKey = try keychain.read(.wrappingKey), rawReceipt = try keychain.read(.receipt)
    if rawKey == nil && rawReceipt == nil {
      guard try !files.hasArtifacts() else { throw StoreFailure.recoveryRequired }
      return nil
    }
    guard let rawKey, let rawReceipt, let receiptText = String(data: rawReceipt, encoding: .utf8) else { throw StoreFailure.recoveryRequired }
    do {
      let receipt = try Receipt(receiptText)
      guard rawKey.count <= 512, let a = try JSONSerialization.jsonObject(with: rawKey) as? [String], a.count == 3,
        a[0] == "HGW1", a[1] == receipt.vaultID, let keyBytes = Data(base64Encoded: a[2]), keyBytes.count == 32 else { throw StoreFailure.corruptState }
      return Context(receipt: receipt, key: SymmetricKey(data: keyBytes))
    } catch { throw StoreFailure.corruptState }
  }
  private func aad(_ slot: SecretSlot, context: Context) -> Data {
    // JSON array is unambiguous; authenticated binding includes format, service, vault and exact slot.
    Data("[\"HGIF1\",\"\(SystemKeychain.service)\",\"\(context.receipt.vaultID)\",\"\(slot.name)\"]".utf8)
  }
  private func decrypt(_ bytes: Data, slot: SecretSlot, context: Context) throws -> String {
    guard bytes.count >= magic.count + 28, bytes.count <= 2081, bytes.starts(with: magic) else { throw StoreFailure.corruptState }
    do {
      let box = try AES.GCM.SealedBox(combined: bytes.dropFirst(magic.count))
      var plaintext = try AES.GCM.open(box, using: context.key, authenticating: aad(slot, context: context))
      defer { plaintext.resetBytes(in: 0..<plaintext.count) }
      guard let text = String(data: plaintext, encoding: .utf8) else { throw StoreFailure.corruptState }
      _ = try context.receipt.payload(text, slot: slot)
      return text
    } catch { throw StoreFailure.corruptState }
  }

  public func getItem(_ key: String) throws -> String? {
    if key == "inventory" { return try context()?.receipt.text }
    let slot = try SecretSlot(key: key), context = try context()
    guard let context else { return nil }
    guard let bytes = try files.read(slot) else { return nil }
    return try decrypt(bytes, slot: slot, context: context)
  }
  public func setItem(_ key: String, value: String) throws {
    stateObserver?.willMutateVault()
    if key == "inventory" { try writeReceipt(value); return }
    let slot = try SecretSlot(key: key)
    guard let context = try context() else { throw StoreFailure.recoveryRequired }
    let payload = try context.receipt.payload(value, slot: slot)
    if let bytes = try files.read(slot) {
      guard try decrypt(bytes, slot: slot, context: context) == value else { throw StoreFailure.itemConflict }
      return
    }
    if context.receipt.pubkeys.contains(payload.pubkey) {
      // An established missing key is never silently replaced. Only its existing authenticated stage
      // can repair an interrupted add; a new stage cannot be invented for a recorded identity.
      guard case .secret = slot, let stagedBytes = try files.read(.stage) else { throw StoreFailure.recoveryRequired }
      let stagedText = try decrypt(stagedBytes, slot: .stage, context: context)
      let staged = try context.receipt.payload(stagedText, slot: .stage)
      guard staged.pubkey == payload.pubkey, staged.scalar == payload.scalar else { throw StoreFailure.recoveryRequired }
    }
    try files.prepare()
    var plaintext = Data(value.utf8)
    defer { plaintext.resetBytes(in: 0..<plaintext.count) }
    let sealed: Data
    do {
      // CryptoKit chooses a fresh secure nonce; there is no caller-supplied or deterministic production nonce.
      guard let combined = try AES.GCM.seal(plaintext, using: context.key, authenticating: aad(slot, context: context)).combined else { throw StoreFailure.unavailable }
      sealed = magic + combined
    } catch { throw StoreFailure.unavailable }
    // The JS vault performs authoritative readback even when a native write throws after rename.
    try files.writeAtomically(slot, data: sealed)
  }
  private func writeReceipt(_ value: String) throws {
    let next = try Receipt(value)
    if let current = try context() {
      guard current.receipt.vaultID == next.vaultID, current.receipt.revision <= next.revision else { throw StoreFailure.itemConflict }
      if current.receipt.text == value { return }
      try keychain.updateReceipt(Data(value.utf8))
      return
    }
    guard !next.initialized else { throw StoreFailure.recoveryRequired }
    // Exclusion/protection succeeds before allocating a wrapping key or writing any secret-bearing file.
    try files.prepare()
    var bytes = try entropy.bytes(count: 32)
    defer { bytes.resetBytes(in: 0..<bytes.count) }
    let key = try keyRecord(vaultID: next.vaultID, key: bytes)
    try keychain.add(.wrappingKey, value: key)
    guard try keychain.read(.wrappingKey) == key else { throw StoreFailure.unavailable }
    // Crash/failure between these two items leaves an orphan guard, never permission to regenerate a KEK.
    try keychain.add(.receipt, value: Data(value.utf8))
  }
  /// Native-only inventory proof. No plaintext key or caller-supplied inventory leaves this actor.
  public func validatedInventory() throws -> NativeVaultInventory {
    guard let current = try context(), current.receipt.initialized,
      let selected = current.receipt.selectedPubkey else { throw StoreFailure.recoveryRequired }
    var digests: [String: Data] = [:]
    for pubkey in current.receipt.pubkeys {
      let slot = SecretSlot.secret(pubkey)
      guard let ciphertext = try files.read(slot) else { throw StoreFailure.recoveryRequired }
      let plaintext = try decrypt(ciphertext, slot: slot, context: current)
      let payload = try current.receipt.payload(plaintext, slot: slot)
      guard payload.scalar != String(repeating: "0", count: 64),
        payload.scalar < "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141" else { throw StoreFailure.corruptState }
      digests[pubkey] = Data(SHA256.hash(data: ciphertext))
    }
    let inventory = NativeVaultInventory(vaultID: current.receipt.vaultID, revision: current.receipt.revision,
      selectedPubkey: selected, receiptDigest: Data(SHA256.hash(data: Data(current.receipt.text.utf8))), identityDigests: digests)
    stateObserver?.validatedInventory(inventory)
    return inventory
  }
  /// Native backup-only read. The exact selected/inventory proof stays native and the bridge has no caller for this port.
  func readBackupSecret(pubkey: String, inventory expected: NativeVaultInventory) throws -> Data {
    guard Receipt.isPubkey(pubkey), expected.selectedPubkey == pubkey,
      try validatedInventory() == expected, let current = try context(),
      current.receipt.selectedPubkey == pubkey else { throw StoreFailure.unauthorized }
    let slot = SecretSlot.secret(pubkey)
    guard let ciphertext = try files.read(slot) else { throw StoreFailure.recoveryRequired }
    // decrypt scrubs its mutable plaintext Data. Swift String storage is immutable and is not claimed to be zeroized.
    let plaintext = try decrypt(ciphertext, slot: slot, context: current)
    let payload = try current.receipt.payload(plaintext, slot: slot)
    guard payload.pubkey == pubkey, payload.scalar != String(repeating: "0", count: 64),
      payload.scalar < "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141" else {
      throw StoreFailure.corruptState
    }
    var bytes = Array(payload.scalar.utf8)
    defer { bytes.withUnsafeMutableBufferPointer { $0.initialize(repeating: 0) } }
    guard bytes.count == 64 else { throw StoreFailure.corruptState }
    var secret = Data(capacity: 32)
    for index in stride(from: 0, to: bytes.count, by: 2) {
      guard let high = Self.hexNibble(bytes[index]), let low = Self.hexNibble(bytes[index + 1]) else {
        secret.resetBytes(in: 0..<secret.count)
        throw StoreFailure.corruptState
      }
      secret.append((high << 4) | low)
    }
    guard secret.count == 32 else {
      secret.resetBytes(in: 0..<secret.count)
      throw StoreFailure.corruptState
    }
    return secret
  }
  private static func hexNibble(_ value: UInt8) -> UInt8? {
    switch value {
    case 48...57: value - 48
    case 97...102: value - 87
    default: nil
    }
  }
  public func deleteItem(_ key: String, deletionToken: String? = nil) throws {
    let slot = try SecretSlot(key: key) // Receipt and wrapping key deletion are never generic bridge operations.
    guard try context() != nil else { throw StoreFailure.recoveryRequired }
    switch slot {
    case .secret(let pubkey):
      guard let deletionToken, BridgeBounds.isToken(deletionToken) else { throw StoreFailure.unauthorized }
      if stateObserver != nil { _ = try validatedInventory() }
      try authorization.consumeDeletion(pubkey: pubkey, token: deletionToken)
    case .stage:
      guard deletionToken == nil else { throw StoreFailure.invalidInput }
    }
    stateObserver?.willMutateVault() // Consume the erase grant before invalidating its own mutation.
    // No await between the native owner's grant check and actual unlink.
    try files.remove(slot)
  }
}
