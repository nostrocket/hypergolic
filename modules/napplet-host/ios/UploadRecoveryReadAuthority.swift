import Foundation
import CryptoKit

/// Fresh app-only read authority from live native configurations; no old approval or guest recipient is restored.
final class UploadRecoveryReadAuthority: @unchecked Sendable {
  fileprivate final class Context: Sendable {
    let generation: String, identity: String
    init(_ generation: String, _ identity: String) { self.generation = generation; self.identity = identity }
  }
  final class Lease: Sendable {
    let record: UploadRecoveryLedger.Entry
    fileprivate let context: Context
    fileprivate let epoch: Int64, expires: Int64
    fileprivate init(_ record: UploadRecoveryLedger.Entry, _ context: Context, _ epoch: Int64, _ expires: Int64) {
      self.record = record; self.context = context; self.epoch = epoch; self.expires = expires
    }
  }
  private let lock = NSLock()
  private let clock: @Sendable () -> Int64
  private var contexts: [String: Context] = [:]
  private var reads: [ObjectIdentifier: Lease] = [:]
  private var foregrounded = false, clockFailed = false
  private var currentIdentity: String?
  private var epoch: Int64 = 0, lastTime: Int64 = -1
  init(clock: @escaping @Sendable () -> Int64) { self.clock = clock }
  func register(_ generation: String, identity: String) -> Bool {
    lock.withLock {
      _ = time()
      guard !clockFailed, generation.range(of: "^[A-Za-z0-9_-]{1,80}$", options: .regularExpression) != nil,
        identity.utf8.count == 64, identity.utf8.allSatisfy({(48...57).contains($0) || (97...102).contains($0)}), contexts[generation] == nil else { return false }
      if let currentIdentity, currentIdentity != identity { contexts.removeAll(); invalidate() }
      guard contexts.count < 64 else { return false }; currentIdentity = identity; contexts[generation] = Context(generation, identity); return true
    }
  }
  func foreground(_ value: Bool) { lock.withLock { _ = time(); foregrounded = value; if !value { invalidate() } } }
  func revoke(_ generation: String) {
    lock.withLock {
      let old = contexts.removeValue(forKey: generation); reads = reads.filter {$0.value.context !== old}
      if contexts.isEmpty { currentIdentity = nil }
    }
  }
  func identity() -> String? { lock.withLock { _ = time(); return foregrounded && !clockFailed && !contexts.isEmpty ? currentIdentity : nil } }
  func capture(_ record: UploadRecoveryLedger.Entry) -> Lease? {
    lock.withLock {
      let now = time(); reads = reads.filter {liveAt($0.value, now)}
      guard foregrounded, !clockFailed, record.state == .unknown, record.identity == currentIdentity,
        let context = contexts.values.first, reads.count < 2, !reads.values.contains(where: {$0.record.uploadId == record.uploadId}) else { return nil }
      let lease = Lease(record, context, epoch, now + 60_000); reads[ObjectIdentifier(lease)] = lease; return lease
    }
  }
  func live(_ lease: Lease) -> Bool { lock.withLock { liveAt(lease, time()) } }
  private func liveAt(_ lease: Lease, _ now: Int64) -> Bool {
    reads[ObjectIdentifier(lease)] === lease && foregrounded && !clockFailed && lease.epoch == epoch && now < lease.expires &&
      contexts[lease.context.generation] === lease.context && lease.record.identity == currentIdentity
  }
  func cancel(_ lease: Lease) { lock.withLock { _ = reads.removeValue(forKey: ObjectIdentifier(lease)) } }
  /// Only the fixed native GET owner calls this after complete response framing.
  func finish(_ lease: Lease, status: Int, body: Data, ledger: UploadRecoveryLedger) throws -> UploadRecoveryLedger.State {
    try lock.withLock {
      guard liveAt(lease, time()) else { return .unknown }; reads.removeValue(forKey: ObjectIdentifier(lease))
      var state = UploadRecoveryLedger.State.unknown
      if status == 404 { state = .absent }
      else if status == 200, body.count == lease.record.size,
        SHA256.hash(data: body).map({String(format: "%02x", $0)}).joined() == lease.record.sha256 { state = .present }
      guard state != .unknown else { return .unknown }
      return try ledger.settle(lease.record, state: state) ? state : .unknown
    }
  }
  private func invalidate() { reads.removeAll(); if epoch == Int64.max { clockFailed = true } else { epoch += 1 } }
  private func time() -> Int64 {
    let value = clock(); guard value >= 0, value >= lastTime, value <= Int64.max - 60_000 else { clockFailed = true; invalidate(); return 0 }
    lastTime = value; return value
  }
}
