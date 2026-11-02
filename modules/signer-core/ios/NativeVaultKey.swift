import Foundation
import Security
import CryptoKit
#if canImport(CHypergolicSigner)
import CHypergolicSigner
#endif

private let nativeVaultEntropy: @convention(c) (UnsafeMutableRawPointer?, UnsafeMutablePointer<UInt8>?, Int) -> Int32 = { _, output, count in
  guard let output, count > 0 else { return 0 }
  return SecRandomCopyBytes(kSecRandomDefault, count, output) == errSecSuccess ? 1 : 0
}

/// Native-only key owner. Neither imported bytes nor persistence bytes are Expo arguments/results.
final class NativeVaultKey: @unchecked Sendable {
  private let lock = NSLock()
  private var pointer: OpaquePointer?
  init() throws {
    var created: OpaquePointer?
    guard hypergolic_signer_generate(nativeVaultEntropy, nil, &created) == 1, let created else { throw NativeVaultFailure.storage }
    pointer = created
  }
  init(secret: Data) throws {
    var created: OpaquePointer?
    let accepted = secret.withUnsafeBytes { buffer in
      hypergolic_signer_import(buffer.bindMemory(to: UInt8.self).baseAddress, secret.count, nativeVaultEntropy, nil, &created)
    }
    guard accepted == 1, let created else { throw NativeVaultFailure.corrupt }
    pointer = created
  }
  deinit { if let pointer { hypergolic_signer_destroy(pointer) } }
  func destroy() { lock.withLock { if let pointer { hypergolic_signer_destroy(pointer) }; pointer = nil } }
  func publicKey() throws -> String {
    try lock.withLock {
      guard let pointer else { throw NativeVaultFailure.denied }
      var bytes = [UInt8](repeating: 0, count: 32)
      guard hypergolic_signer_public_key(pointer, &bytes) == 1 else { throw NativeVaultFailure.corrupt }
      return bytes.hex
    }
  }
  func withPersistenceSecret<T>(_ operation: (Data) throws -> T) throws -> T {
    try lock.withLock {
      guard let pointer else { throw NativeVaultFailure.denied }
      let buffer = NativeSecretBuffer()
      let opaque = Unmanaged.passUnretained(buffer).toOpaque()
      guard hypergolic_signer_serialize(pointer, nativeSecretSink, opaque) == 1, buffer.bytes.count == 32 else { throw NativeVaultFailure.storage }
      defer { buffer.clear() }
      return try operation(buffer.bytes)
    }
  }
  /// Native transport-only encryption. No Expo surface accepts or returns these keys or plaintext.
  func encrypt(peer: String, plaintext: Data) throws -> Data { try nip44(peer: peer, input: plaintext, encrypting: true) }
  /// The caller must authenticate the outer NIP-01 event and exact peer before calling.
  func decryptAuthenticated(peer: String, payload: Data) throws -> Data { try nip44(peer: peer, input: payload, encrypting: false) }
  private func nip44(peer: String, input: Data, encrypting: Bool) throws -> Data {
    try lock.withLock {
      guard let pointer else { throw NativeVaultFailure.denied }
      guard NativeVaultRecord.isPoint(peer), let publicBytes = Self.hexBytes(peer),
        !input.isEmpty, input.count <= (encrypting ? NativeNip46Protocol.maximumPlaintext : 6_990_604) else { throw NativeVaultFailure.signerUnsupported }
      let output = NativeNip44Output(maximum: encrypting ? 6_990_604 : NativeNip46Protocol.maximumPlaintext)
      defer { output.clear() }
      var crypto = hypergolic_nip44_crypto(hmac: nativeNip44HMAC, hmac_context: nil, entropy: nativeVaultEntropy, entropy_context: nil)
      let status = publicBytes.withUnsafeBytes { peerBuffer in
        input.withUnsafeBytes { inputBuffer in
          let peerSpan = hypergolic_nip44_bytes(data: peerBuffer.bindMemory(to: UInt8.self).baseAddress, length: publicBytes.count)
          let inputSpan = hypergolic_nip44_bytes(data: inputBuffer.bindMemory(to: UInt8.self).baseAddress, length: input.count)
          let context = Unmanaged.passUnretained(output).toOpaque()
          return encrypting ? hypergolic_nip44_encrypt(pointer, peerSpan, inputSpan, &crypto, nativeNip44Sink, context)
            : hypergolic_nip44_decrypt(pointer, peerSpan, inputSpan, &crypto, nativeNip44Sink, context)
        }
      }
      guard status == HYPERGOLIC_NIP44_OK else {
        throw status == HYPERGOLIC_NIP44_UNSUPPORTED_VERSION ? NativeVaultFailure.signerUnsupported : .signerResponseInvalid
      }
      return output.bytes.withUnsafeBytes { Data($0) }
    }
  }
  static func hexBytes(_ text: String) -> Data? {
    guard text.utf8.count % 2 == 0, text.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { return nil }
    var bytes = Data(); bytes.reserveCapacity(text.utf8.count / 2)
    var index = text.startIndex
    while index < text.endIndex { let end = text.index(index, offsetBy: 2); guard let byte = UInt8(text[index..<end], radix: 16) else { return nil }; bytes.append(byte); index = end }
    return bytes
  }
  func sign(_ event: ExactSignerEvent) throws -> String {
    try lock.withLock {
      guard let pointer else { throw NativeVaultFailure.denied }
      var signature = [UInt8](repeating: 0, count: 64), publicKey = [UInt8](repeating: 0, count: 32)
      let digest = event.digest
      guard hypergolic_signer_sign_digest(pointer, digest, nativeVaultEntropy, nil, &signature) == 1,
        hypergolic_signer_public_key(pointer, &publicKey) == 1,
        hypergolic_signer_verify_digest(publicKey, digest, signature) == 1 else { throw NativeVaultFailure.corrupt }
      return event.signedJSON(signature: signature)
    }
  }
}
private final class NativeSecretBuffer {
  var bytes = Data()
  func clear() { bytes.resetBytes(in: 0..<bytes.count); bytes.removeAll() }
  deinit { clear() }
}
private let nativeSecretSink: @convention(c) (UnsafeMutableRawPointer?, UnsafePointer<UInt8>?, Int) -> Int32 = { context, input, count in
  guard let context, let input, count == 32 else { return 0 }
  Unmanaged<NativeSecretBuffer>.fromOpaque(context).takeUnretainedValue().bytes = Data(bytes: input, count: count)
  return 1
}

enum NativeVaultFailure: String, Error, Sendable {
  case unavailable, storage, readback, corrupt, recovery, denied, stale, busy, invalidInput, notFound, limitReached, deleteSelected
  case invalidSignerConnection, signerAlreadyConnected, signerUnavailable, signerRejected, signerExpired, signerResponseInvalid, signerUncertain, signerUnsupported, signerRelaysChanged, localKeyUnavailable
  var bridgeCode: String {
    switch self {
    case .unavailable: "STORAGE_FAILURE"
    case .storage: "STORAGE_FAILURE"
    case .readback: "READBACK_FAILED"
    case .corrupt: "CORRUPT_METADATA"
    case .recovery: "RECOVERY_REQUIRED"
    case .denied: "AUTHORIZATION_DENIED"
    case .stale: "AUTHORIZATION_DENIED"
    case .busy: "AUTHORIZATION_DENIED"
    case .invalidInput: "INVALID_SECRET"
    case .notFound: "NOT_FOUND"
    case .limitReached: "LIMIT_REACHED"
    case .deleteSelected: "DELETE_SELECTED"
    case .invalidSignerConnection: "INVALID_SIGNER_CONNECTION"
    case .signerAlreadyConnected: "SIGNER_ALREADY_CONNECTED"
    case .signerUnavailable: "SIGNER_UNAVAILABLE"
    case .signerRejected: "SIGNER_REJECTED"
    case .signerExpired: "SIGNER_EXPIRED"
    case .signerResponseInvalid: "SIGNER_RESPONSE_INVALID"
    case .signerUncertain: "SIGNER_UNCERTAIN"
    case .signerUnsupported: "SIGNER_UNSUPPORTED"
    case .signerRelaysChanged: "SIGNER_RELAYS_CHANGED"
    case .localKeyUnavailable: "LOCAL_KEY_UNAVAILABLE"
    }
  }
}

// These callbacks remain inside synchronous C calls. CryptoKit owns its internal
// SymmetricKey storage; mutable caller copies and C temporaries are explicitly cleared.
private let nativeNip44HMAC: @convention(c) (UnsafeMutableRawPointer?, UnsafePointer<UInt8>?, Int, UnsafePointer<UInt8>?, Int, UnsafeMutablePointer<UInt8>?) -> Int32 = { _, key, keyCount, message, messageCount, output in
  guard let key, [8, 32].contains(keyCount), messageCount >= 0, let output,
    messageCount == 0 || message != nil else { return 0 }
  var keyBytes = Data(bytes: key, count: keyCount)
  defer { keyBytes.resetBytes(in: 0..<keyBytes.count) }
  let messageBytes = messageCount == 0 ? Data() : Data(bytesNoCopy: UnsafeMutableRawPointer(mutating: message!), count: messageCount, deallocator: .none)
  let authentication = HMAC<SHA256>.authenticationCode(for: messageBytes, using: SymmetricKey(data: keyBytes))
  authentication.withUnsafeBytes { output.update(from: $0.bindMemory(to: UInt8.self).baseAddress!, count: 32) }
  return 1
}
private final class NativeNip44Output {
  var bytes = Data()
  let maximum: Int
  init(maximum: Int) { self.maximum = maximum }
  func clear() { bytes.resetBytes(in: 0..<bytes.count); bytes.removeAll() }
  deinit { clear() }
}
private let nativeNip44Sink: @convention(c) (UnsafeMutableRawPointer?, UnsafePointer<UInt8>?, Int) -> Int32 = { context, input, count in
  guard let context, let input, count > 0 else { return 0 }
  let output = Unmanaged<NativeNip44Output>.fromOpaque(context).takeUnretainedValue()
  guard output.bytes.isEmpty, count <= output.maximum else { return 0 }
  output.bytes = Data(bytes: input, count: count); return 1
}
