import Foundation
import Security
#if canImport(CHypergolicSigner)
import CHypergolicSigner
#endif

enum SignerFailure: String, Error, Sendable {
  case unavailable, invalidInput, busy, denied, expired, staleOwner, cryptoFailure
}

/// Object identity comes from the native runtime binding, never a bridge string.
final class SignerOwner: @unchecked Sendable {}
final class SignerReviewHandle: @unchecked Sendable {
  fileprivate let owner: SignerOwner
  fileprivate init(owner: SignerOwner) { self.owner = owner }
}
struct SignerReview: Sendable {
  let handle: SignerReviewHandle
  let event: ExactSignerEvent
  let requester = "Trusted shell / Disposable signing trace"
}

private let signerEntropy: @convention(c) (UnsafeMutableRawPointer?, UnsafeMutablePointer<UInt8>?, Int) -> Int32 = { _, output, count in
  guard let output, count > 0 else { return 0 }
  return SecRandomCopyBytes(kSecRandomDefault, count, output) == errSecSuccess ? 1 : 0
}

/// Plan 01 ephemeral authority. C owns the secret; Swift and Expo receive public bytes only.
final class NativeSignerCore: @unchecked Sendable {
  static let lifetime: Duration = .seconds(600)
  private let lock = NSLock()
  private let owner: SignerOwner
  private let now: @Sendable () -> Duration
  private var lastNow: Duration?
  private var key: OpaquePointer?
  private var pubkey: String?
  private var deadline: Duration?
  private var review: SignerReview?
  private var closed = false

  init(owner: SignerOwner) {
    self.owner = owner
    let origin = ContinuousClock.now
    now = { origin.duration(to: .now) }
  }
  /// Native owning tests can advance time; no bridge may select a clock or entropy source.
  init(owner: SignerOwner, testingClock: @escaping @Sendable () -> Duration) {
    self.owner = owner; now = testingClock
  }
  deinit { if let key { hypergolic_signer_destroy(key) } }

  func generate(owner candidate: SignerOwner) throws -> String {
    try lock.withLock {
      try check(candidate)
      guard review == nil else { throw SignerFailure.busy }
      if let pubkey { return pubkey }
      var created: OpaquePointer?
      guard hypergolic_signer_generate(signerEntropy, nil, &created) == 1, let created else { throw SignerFailure.cryptoFailure }
      var publicBytes = [UInt8](repeating: 0, count: 32)
      guard hypergolic_signer_public_key(created, &publicBytes) == 1 else {
        hypergolic_signer_destroy(created); throw SignerFailure.cryptoFailure
      }
      key = created; pubkey = publicBytes.hex; deadline = lastNow! + Self.lifetime
      return publicBytes.hex
    }
  }
  func beginReview(owner candidate: SignerOwner, unsignedJSON: String) throws -> SignerReview {
    try lock.withLock {
      try check(candidate)
      guard review == nil else { throw SignerFailure.busy }
      guard let pubkey, key != nil else { throw SignerFailure.unavailable }
      let event = try ExactSignerEvent(json: unsignedJSON, expectedPubkey: pubkey)
      let captured = SignerReview(handle: SignerReviewHandle(owner: owner), event: event)
      review = captured; return captured
    }
  }
  /// Called only by a native visible review button. The event cannot be supplied again here.
  func approveAndSign(owner candidate: SignerOwner, handle: SignerReviewHandle) throws -> String {
    try lock.withLock {
      try check(candidate)
      guard handle.owner === owner, let captured = review, captured.handle === handle, let key else { throw SignerFailure.denied }
      review = nil // Consume before any crypto failure. Replays never retry a sign.
      var signature = [UInt8](repeating: 0, count: 64)
      let digest = captured.event.digest
      guard hypergolic_signer_sign_digest(key, digest, signerEntropy, nil, &signature) == 1 else { throw SignerFailure.cryptoFailure }
      var publicBytes = [UInt8](repeating: 0, count: 32)
      guard hypergolic_signer_public_key(key, &publicBytes) == 1,
        hypergolic_signer_verify_digest(publicBytes, digest, signature) == 1 else { throw SignerFailure.cryptoFailure }
      try check(candidate) // Deadline remains valid after signing.
      return captured.event.signedJSON(signature: signature)
    }
  }
  func reject(owner candidate: SignerOwner, handle: SignerReviewHandle) throws {
    try lock.withLock {
      try check(candidate)
      guard handle.owner === owner, review?.handle === handle else { throw SignerFailure.denied }
      review = nil
    }
  }
  var isRevoked: Bool {
    lock.withLock {
      if let deadline, now() >= deadline { close() }
      return closed
    }
  }
  func cancelReview() { lock.withLock { review = nil } }
  func revoke() { lock.withLock { close() } }
  private func check(_ candidate: SignerOwner) throws {
    guard candidate === owner else { throw SignerFailure.staleOwner }
    guard !closed else { throw SignerFailure.staleOwner }
    let time = now()
    if let lastNow, time < lastNow { close(); throw SignerFailure.expired }
    lastNow = time
    if let deadline, time >= deadline { close(); throw SignerFailure.expired }
  }
  private func close() {
    if let key { hypergolic_signer_destroy(key) }
    key = nil; pubkey = nil; review = nil; deadline = nil; closed = true
  }
}
