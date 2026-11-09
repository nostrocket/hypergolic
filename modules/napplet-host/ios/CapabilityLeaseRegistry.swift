import Foundation

/// Synchronous native authority. All mutable state is protected by the same lock;
/// no UIKit/WebKit reference or user key is stored here.
final class CapabilityLeaseRegistry: @unchecked Sendable {
  static let maxBytes = 2 * 1024 * 1024
  private static let maxWaiting = 16
  private static let maxWaitingPerSession = 8
  private struct Session { var sequence: UInt64 = 0 }
  private struct Request {
    let generation: String
    let snapshot: String
    let expires: ContinuousClock.Instant
    var claimed = false
  }
  private struct Waiting {
    let token: String
    let request: Request
    let bytes: Int
  }
  private let lock = NSLock()
  private let now: @Sendable () -> ContinuousClock.Instant
  private var sessions: [String: Session] = [:]
  private var requests: [String: Request] = [:]
  private var waiting: [Waiting] = []
  private var foreground = true

  /// Background permanently invalidates pending work, retaining loaded sessions and replay counters.
  func setForeground(_ value: Bool) -> [String] {
    lock.withLock {
      foreground = value
      guard !value else { return [] }
      let revoked = Array(requests.keys) + waiting.map(\.token)
      requests.removeAll()
      waiting.removeAll()
      return revoked
    }
  }

  init(now: @escaping @Sendable () -> ContinuousClock.Instant = { ContinuousClock.now }) {
    self.now = now
  }
  func register(_ generation: String) -> Bool {
    lock.withLock {
      guard generation.range(of: "^[A-Za-z0-9_-]{1,80}$", options: .regularExpression) != nil,
        sessions[generation] == nil, sessions.count < 64 else { return false }
      sessions[generation] = Session()
      return true
    }
  }
  func sessionActive(_ generation: String) -> Bool { lock.withLock { sessions[generation] != nil } }
  func revoke(_ generation: String) {
    lock.withLock {
      sessions.removeValue(forKey: generation)
      requests = requests.filter { $0.value.generation != generation }
      waiting.removeAll { $0.request.generation == generation }
    }
  }
  /// Consumes the next transport sequence without creating an ordinary 25-second lease.
  /// Approval and ordinary capability requests share this exact replay boundary.
  func consumeSequence(_ generation: String, sequence: UInt64) -> Bool {
    lock.withLock { consumeSequenceLocked(generation, sequence: sequence) }
  }
  /// Snapshot is complete JSON constructed by the host from native registration and the original serialized request.
  func admit(_ generation: String, sequence: UInt64, snapshot: String, publishedOpen: Bool = false) -> String? {
    lock.withLock {
      prune()
      guard consumeSequenceLocked(generation, sequence: sequence) else { return nil }
      guard foreground, snapshot.utf8.count <= Self.maxBytes, canAdmit(generation) else { return nil }
      let token = UUID().uuidString.lowercased()
      requests[token] = Request(generation: generation, snapshot: snapshot, expires: now().advanced(by: .seconds(publishedOpen ? 120 : 25)))
      return token
    }
  }
  /// A waiting ID cannot be taken or authorize an effect before promotion.
  func enqueue(_ generation: String, sequence: UInt64, snapshot: String) -> String? {
    lock.withLock {
      prune()
      guard consumeSequenceLocked(generation, sequence: sequence), foreground,
        waiting.count < Self.maxWaiting,
        waiting.filter({ $0.request.generation == generation }).count < Self.maxWaitingPerSession else { return nil }
      let bytes = snapshot.utf8.count
      guard bytes <= Self.maxBytes - waiting.reduce(0, { $0 + $1.bytes }) else { return nil }
      let token = UUID().uuidString.lowercased()
      let request = Request(generation: generation, snapshot: snapshot, expires: now().advanced(by: .seconds(25)))
      waiting.append(Waiting(token: token, request: request, bytes: bytes))
      return token
    }
  }
  func promote() -> [String] {
    lock.withLock {
      prune()
      guard foreground else { return [] }
      var promoted: [String] = []
      var remaining: [Waiting] = []
      for entry in waiting {
        if canAdmit(entry.request.generation) {
          requests[entry.token] = entry.request
          promoted.append(entry.token)
        } else { remaining.append(entry) }
      }
      waiting = remaining
      return promoted
    }
  }
  func retained(_ token: String) -> Bool {
    lock.withLock {
      prune()
      return requests[token] != nil || waiting.contains { $0.token == token }
    }
  }
  private func canAdmit(_ generation: String) -> Bool {
    requests.count < 8 && requests.values.filter { $0.generation == generation }.count < 4
  }
  private func consumeSequenceLocked(_ generation: String, sequence: UInt64) -> Bool {
    guard var session = sessions[generation], sequence > 0,
      sequence <= 9_007_199_254_740_991, sequence == session.sequence + 1 else { return false }
    // Overload consumes its transport sequence; a dropped request cannot become a later replay.
    session.sequence = sequence
    sessions[generation] = session
    return true
  }
  func take(_ token: String) -> String? {
    lock.withLock {
      prune()
      guard var request = requests[token], !request.claimed, sessions[request.generation] != nil else { return nil }
      request.claimed = true
      requests[token] = request
      return request.snapshot
    }
  }
  func isActive(_ token: String) -> Bool {
    lock.withLock {
      prune()
      guard let request = requests[token] else { return false }
      return request.claimed && sessions[request.generation] != nil
    }
  }
  /// Read-only native borrowing after the one-use claim; this never grants or extends a lease.
  func borrowedSnapshot(_ token: String) -> String? {
    lock.withLock {
      prune()
      guard let request = requests[token], request.claimed, sessions[request.generation] != nil else { return nil }
      return request.snapshot
    }
  }
  /// Consumes exactly this request. Delivery must still recheck its generation on the main actor.
  func finish(_ token: String) -> Bool {
    lock.withLock {
      prune()
      guard let request = requests.removeValue(forKey: token) else { return false }
      return request.claimed && sessions[request.generation] != nil
    }
  }
  private func prune() {
    let current = now()
    requests = requests.filter { current < $0.value.expires && sessions[$0.value.generation] != nil }
    waiting.removeAll { current >= $0.request.expires || sessions[$0.request.generation] == nil }
  }
}
