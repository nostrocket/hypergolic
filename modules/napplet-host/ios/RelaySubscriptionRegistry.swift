import Foundation

/// Thread-safe native read authority: short admission, generation-lived accepted intent.
final class RelaySubscriptionRegistry: @unchecked Sendable {
  static let maxSnapshotBytes = 32 * 1024
  private struct Stream {
    let generation: String
    let snapshot: String
    let expires: ContinuousClock.Instant
    let outbox: Bool
    var claimed = false
    var accepted = false
  }
  private let lock = NSLock()
  private let now: @Sendable () -> ContinuousClock.Instant
  private let generationActive: @Sendable (String) -> Bool
  private var streams: [String: Stream] = [:]
  private var foreground = false
  init(now: @escaping @Sendable () -> ContinuousClock.Instant = { ContinuousClock.now },
       generationActive: @escaping @Sendable (String) -> Bool) {
    self.now = now; self.generationActive = generationActive
  }
  func setForeground(_ value: Bool) { lock.withLock { foreground = value } }
  /// The host must consume its shared transport sequence before this admission.
  func admit(_ generation: String, snapshot: String, outbox: Bool = false) -> String? {
    lock.withLock {
      prune()
      guard foreground, activeGeneration(generation), snapshot.utf8.count <= Self.maxSnapshotBytes,
        streams.count < 8, streams.values.filter({ $0.generation == generation }).count < 2 else { return nil }
      let token = UUID().uuidString.lowercased()
      streams[token] = Stream(generation: generation, snapshot: snapshot, expires: now().advanced(by: .seconds(25)), outbox: outbox)
      return token
    }
  }
  func take(_ token: String) -> String? {
    lock.withLock {
      prune()
      guard var stream = streams[token], !stream.claimed else { return nil }
      stream.claimed = true; streams[token] = stream
      return stream.snapshot
    }
  }
  func accept(_ token: String) -> Bool {
    lock.withLock {
      prune()
      guard foreground, var stream = streams[token], stream.claimed, !stream.accepted else { return false }
      stream.accepted = true; streams[token] = stream; return true
    }
  }
  func isActive(_ token: String) -> Bool {
    lock.withLock { prune(); return streams[token]?.claimed == true && streams[token]?.accepted == true }
  }
  func connectionLimit(_ token: String) -> Int {
    lock.withLock { prune(); guard let stream = streams[token], stream.claimed, stream.accepted else { return 0 }; return stream.outbox ? 16 : 2 }
  }
  func mayDeliver(_ token: String) -> Bool {
    lock.withLock { prune(); return foreground && streams[token]?.claimed == true && streams[token]?.accepted == true }
  }
  func close(_ token: String) { lock.withLock { _ = streams.removeValue(forKey: token) } }
  func revoke(_ generation: String) { lock.withLock { streams = streams.filter { $0.value.generation != generation } } }
  func revokeAll() { lock.withLock { streams.removeAll() } }
  private func activeGeneration(_ generation: String) -> Bool {
    generation.range(of: "^[A-Za-z0-9_-]{1,80}$", options: .regularExpression) != nil && generationActive(generation)
  }
  private func prune() {
    let current = now()
    streams = streams.filter { activeGeneration($0.value.generation) && ($0.value.accepted || current < $0.value.expires) }
  }
}
