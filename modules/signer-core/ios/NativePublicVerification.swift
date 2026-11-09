import Foundation
#if canImport(CHypergolicSigner)
import CHypergolicSigner
#endif
#if canImport(UIKit)
import UIKit
#endif

/// Public BIP340 only; no vault/key construction. Two process-wide reservations, no pending queue.
final class NativePublicVerification: @unchecked Sendable {
  enum Failure: Error { case denied }
  typealias Verifier = @Sendable ([UInt8], [UInt8], [UInt8]) -> Bool
  final class Job: @unchecked Sendable {
    let owner: NativePublicVerification
    let id: String
    let raw: String
    let expires: UInt64
    let revision: UInt64
    let active: @Sendable () -> Bool
    var cancelled = false
    var started = false
    init(owner: NativePublicVerification, id: String, raw: String, expires: UInt64, active: @escaping @Sendable () -> Bool) {
      self.owner = owner; self.id = id; self.raw = raw; self.expires = expires; self.active = active; self.revision = owner.revision
    }
  }
  private static let lock = NSLock()
  nonisolated(unsafe) private static var jobs: [String: Job] = [:]
  private let clock: @Sendable () -> UInt64
  private let verifier: Verifier
  private var cancelled: [String: UInt64] = [:]
  private var denyUntil: UInt64 = 0
  private var revision: UInt64 = 0
  private var closed = false
  private var foreground = false
  private var observers: [NSObjectProtocol] = []
  init(clock: @escaping @Sendable () -> UInt64 = { DispatchTime.now().uptimeNanoseconds },
       verifier: @escaping Verifier = NativePublicVerification.verify) {
    self.clock = clock; self.verifier = verifier
    #if canImport(UIKit)
    let center = NotificationCenter.default
    for name in [UIApplication.willResignActiveNotification, UIApplication.didEnterBackgroundNotification] {
      observers.append(center.addObserver(forName: name, object: nil, queue: nil) { [weak self] _ in self?.setForeground(false) })
    }
    observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: nil) { [weak self] _ in self?.setForeground(true) })
    #endif
  }
  deinit { for observer in observers { NotificationCenter.default.removeObserver(observer) } }
  private static func uuid(_ id: String) -> Bool {
    id.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil && id.utf8.count == 36
  }
  func begin(id: String, raw: String, milliseconds: Double, active: @escaping @Sendable () -> Bool) throws -> Job {
    guard Self.uuid(id), raw.utf8.count <= 65_536, !raw.isEmpty, raw.utf8.allSatisfy({ $0 < 128 }),
      milliseconds.isFinite, milliseconds >= 1, milliseconds <= 15_000, milliseconds.rounded(.towardZero) == milliseconds,
      active() else { throw Failure.denied }
    return try Self.lock.withLock {
      let now = clock()
      cancelled = cancelled.filter { $0.value > now }
      guard !closed, foreground, now >= denyUntil, cancelled[id] == nil, Self.jobs.count < 2, Self.jobs[id] == nil else { throw Failure.denied }
      let job = Job(owner: self, id: id, raw: raw, expires: now + UInt64(milliseconds) * 1_000_000, active: active)
      Self.jobs[id] = job
      return job
    }
  }
  private func check(_ job: Job, executing: Bool = true) throws {
    guard job.active() else { throw Failure.denied }
    try Self.lock.withLock {
      guard !closed, foreground, job.revision == revision, !job.cancelled, clock() >= denyUntil, cancelled[job.id] == nil, clock() < job.expires,
        !executing || Self.jobs[job.id] === job else { throw Failure.denied }
    }
  }
  func run(_ job: Job) throws -> String {
    try Self.lock.withLock {
      guard job.owner === self, Self.jobs[job.id] === job, !job.started else { throw Failure.denied }
      job.started = true
    }
    defer { Self.lock.withLock { if Self.jobs[job.id] === job { Self.jobs.removeValue(forKey: job.id) } } }
    try check(job)
    var cursor = Cursor(raw: Array(job.raw.utf8)), results: [String] = []
    try cursor.take(91)
    repeat {
      try check(job)
      guard results.count < 200 else { throw Failure.denied }
      try cursor.take(91)
      let pubkey = try cursor.hex(32); try cursor.take(44)
      let digest = try cursor.hex(32); try cursor.take(44)
      let signature = try cursor.hex(64); try cursor.take(93)
      let valid = verifier(pubkey, digest, signature)
      try check(job)
      results.append(valid ? "true" : "false")
    } while try cursor.more()
    try check(job)
    return "{\"operationId\":\"\(job.id)\",\"results\":[\(results.joined(separator: ","))]}"
  }
  func delivery(_ job: Job) throws { try check(job, executing: false) }
  func verify(id: String, raw: String, milliseconds: Double, active: @escaping @Sendable () -> Bool) async throws -> String {
    try await withTaskCancellationHandler {
      let job = try begin(id: id, raw: raw, milliseconds: milliseconds, active: active)
      defer { abandon(job) }
      let result: String = try await withCheckedThrowingContinuation { continuation in
        DispatchQueue.global(qos: .userInitiated).async {
          do { continuation.resume(returning: try self.run(job)) }
          catch { continuation.resume(throwing: error) }
        }
      }
      try delivery(job)
      return result
    } onCancel: { self.cancel(id) }
  }
  func abandon(_ job: Job) {
    Self.lock.withLock {
      job.cancelled = true
      if !job.started, Self.jobs[job.id] === job { Self.jobs.removeValue(forKey: job.id) }
    }
  }
  func cancel(_ id: String) {
    guard Self.uuid(id) else { return }
    Self.lock.withLock {
      if let job = Self.jobs[id], job.owner === self { job.cancelled = true; return }
      let now = clock()
      cancelled = cancelled.filter { $0.value > now }
      if cancelled.count >= 64 { denyUntil = now + 15_000_000_000 }
      else { cancelled[id] = now + 15_000_000_000 }
    }
  }
  func setForeground(_ value: Bool) {
    Self.lock.withLock {
      foreground = value
      if !value {
        revision &+= 1
        for job in Self.jobs.values where job.owner === self { job.cancelled = true }
      }
    }
  }
  func close() { Self.lock.withLock { closed = true }; setForeground(false) }
  private static func verify(_ pubkey: [UInt8], _ digest: [UInt8], _ signature: [UInt8]) -> Bool {
    hypergolic_signer_verify_digest(pubkey, digest, signature) == 1
  }
  private struct Cursor {
    let raw: [UInt8]
    var at = 0
    mutating func take(_ expected: UInt8) throws {
      guard at < raw.count, raw[at] == expected else { throw Failure.denied }; at += 1
    }
    mutating func hex(_ count: Int) throws -> [UInt8] {
      try take(34)
      var output: [UInt8] = []
      for _ in 0..<count {
        guard at + 1 < raw.count else { throw Failure.denied }
        output.append(try nibble(raw[at]) * 16 + nibble(raw[at + 1])); at += 2
      }
      try take(34); return output
    }
    private func nibble(_ byte: UInt8) throws -> UInt8 {
      if byte >= 48 && byte <= 57 { return byte - 48 }
      if byte >= 97 && byte <= 102 { return byte - 87 }
      throw Failure.denied
    }
    mutating func more() throws -> Bool {
      guard at < raw.count else { throw Failure.denied }
      if raw[at] == 44 { at += 1; return true }
      try take(93); guard at == raw.count else { throw Failure.denied }; return false
    }
  }
}
