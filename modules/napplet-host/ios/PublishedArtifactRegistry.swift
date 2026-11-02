import CryptoKit
import Foundation

/// Private, one-use transfer of already verified HTML into a native host generation.
/// This registry checks bytes and ownership claims; it does not verify Nostr signatures.
final class PublishedArtifactRegistry: @unchecked Sendable {
  static let maximumHTMLBytes = 2 * 1024 * 1024
  static let maximumPending = 4
  static let lifetime: Duration = .seconds(60)

  struct Claims: Equatable, Sendable {
    let sessionId: String
    let publisher: String
    let identifier: String
    let eventId: String
    let aggregateHash: String
    let htmlHash: String
  }

  struct ClaimedArtifact: Sendable {
    let claims: Claims
    let viewGeneration: String
    let htmlBytes: Data
  }

  private struct Pending {
    let claims: Claims
    let htmlBytes: Data
    let expires: ContinuousClock.Instant
  }

  private let lock = NSLock()
  private let now: @Sendable () -> ContinuousClock.Instant
  private var pending: [String: Pending] = [:]
  private var activeSessions: Set<String> = []

  init(now: @escaping @Sendable () -> ContinuousClock.Instant = { ContinuousClock.now }) {
    self.now = now
  }

  /// Only the trusted app owner registers a live shell session. Re-registration after
  /// revocation is explicit, so a saved session can open a new view generation.
  func registerSession(_ sessionId: String) -> Bool {
    lock.withLock {
      guard Self.validGeneration(sessionId), activeSessions.count < 64 else { return false }
      return activeSessions.insert(sessionId).inserted
    }
  }

  func isSessionRegistered(_ sessionId: String) -> Bool {
    lock.withLock { activeSessions.contains(sessionId) }
  }

  func stage(_ input: Data, claims: Claims) -> String? {
    guard Self.valid(claims), !input.isEmpty, input.count <= Self.maximumHTMLBytes,
      String(data: input, encoding: .utf8) != nil else { return nil }
    let htmlHash = Self.sha256(input)
    guard htmlHash == claims.htmlHash,
      Self.sha256(Data("\(htmlHash) /index.html\n".utf8)) == claims.aggregateHash else { return nil }
    // Allocate a separate backing store before acquiring the lock. The caller may reuse its buffer.
    let copy = Self.copy(input)
    return lock.withLock {
      pruneLocked()
      guard activeSessions.contains(claims.sessionId),
        pending.count < Self.maximumPending else { return nil }
      var handle: String
      repeat { handle = UUID().uuidString.lowercased() } while pending[handle] != nil
      pending[handle] = Pending(claims: claims, htmlBytes: copy, expires: now().advanced(by: Self.lifetime))
      return handle
    }
  }

  /// A wrong claim consumes the handle. The host must supply its own freshly minted generation.
  /// The returned byte copy belongs to the host and must be discarded at view teardown.
  func claim(_ handle: String, claims: Claims, viewGeneration: String) -> ClaimedArtifact? {
    lock.withLock {
      pruneLocked()
      guard let staged = pending.removeValue(forKey: handle),
        activeSessions.contains(staged.claims.sessionId),
        Self.validGeneration(viewGeneration), staged.claims == claims else { return nil }
      return ClaimedArtifact(claims: staged.claims, viewGeneration: viewGeneration,
                             htmlBytes: Self.copy(staged.htmlBytes))
    }
  }

  func revokeSession(_ sessionId: String) {
    lock.withLock {
      pending = pending.filter { $0.value.claims.sessionId != sessionId }
      activeSessions.remove(sessionId)
    }
  }

  func revokeAll() {
    lock.withLock {
      activeSessions.removeAll()
      pending.removeAll()
    }
  }

  private func pruneLocked() {
    let instant = now()
    pending = pending.filter { instant < $0.value.expires }
  }

  private static func valid(_ claims: Claims) -> Bool {
    validGeneration(claims.sessionId)
      && validHex(claims.publisher) && validHex(claims.eventId)
      && validHex(claims.aggregateHash) && validHex(claims.htmlHash)
      && !claims.identifier.isEmpty
      && claims.identifier.utf8.count <= 255
      && claims.identifier == claims.identifier.trimmingCharacters(in: .whitespacesAndNewlines)
      && claims.identifier.unicodeScalars.allSatisfy { !CharacterSet.controlCharacters.contains($0) }
  }

  private static func validGeneration(_ value: String) -> Bool {
    value.range(of: "^[A-Za-z0-9_-]{1,80}$", options: .regularExpression) != nil
  }

  private static func validHex(_ value: String) -> Bool {
    value.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
  }

  private static func sha256(_ bytes: Data) -> String {
    SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
  }

  private static func copy(_ bytes: Data) -> Data {
    bytes.withUnsafeBytes { Data(bytes: $0.baseAddress!, count: $0.count) }
  }
}
