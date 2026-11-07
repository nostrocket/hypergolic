import Foundation

/// Original session clock and cumulative decrypted HTTP response-byte allowance, never reset on pause.
final class LiveMP3Budget: @unchecked Sendable {
  private static let origin = ContinuousClock.now
  static func milliseconds() -> UInt64 {
    let value=origin.duration(to:ContinuousClock.now).components
    return UInt64(value.seconds)*1000+UInt64(value.attoseconds/1_000_000_000_000_000)
  }
  static let maximumBytes = 32 * 1024 * 1024
  static let sessionMilliseconds: UInt64 = 15 * 60 * 1000
  static let startupMilliseconds: UInt64 = 15_000
  enum Failure: Error { case retired, startup, bytes }
  private let lock = NSLock()
  private let clock: @Sendable () -> UInt64
  private let started: UInt64, duration: UInt64, maximum: Int
  private var attemptStarted: UInt64
  private var received = 0
  private var awaitingOutput = false
  private var cancelled = false, transport = false
  private var lastByte: UInt64 = 0
  init(clock: @escaping @Sendable () -> UInt64 = { LiveMP3Budget.milliseconds() },
       maximum: Int = maximumBytes, duration: UInt64 = sessionMilliseconds) {
    precondition((1...Self.maximumBytes).contains(maximum) && duration > 0 && duration <= Self.sessionMilliseconds)
    self.clock = clock; self.maximum = maximum; self.duration = duration
    started = clock(); attemptStarted = started
  }
  private func valid() throws {
    let now = clock()
    guard !cancelled, now >= started, now - started < duration else { throw Failure.retired }
    if transport && now - lastByte >= 10_000 { throw Failure.startup }
    if awaitingOutput && now - attemptStarted >= Self.startupMilliseconds { throw Failure.startup }
  }
  func check() throws { try lock.withLock { try valid() } }
  func beginAttempt() throws { try lock.withLock { try valid(); awaitingOutput = true; attemptStarted = clock();transport = true;lastByte = attemptStarted } }
  func markOutput() throws { try lock.withLock { try valid(); awaitingOutput = false } }
  func pause() throws { try lock.withLock { try valid(); awaitingOutput = false;transport = false } }
  func finishedTransport() throws { try lock.withLock { try valid();transport = false } }
  func charge(_ bytes: Int) throws {
    try lock.withLock {
      try valid(); guard bytes >= 0 && bytes <= maximum - received else { throw Failure.bytes }; received += bytes;if bytes > 0 { lastByte = clock() }
    }
  }
  func remaining() throws -> UInt64 { try lock.withLock { try valid(); return duration - (clock() - started) } }
  var readAllowance: Int { lock.withLock { min(8192,maximum-received+1) } }
  var count: Int { lock.withLock { received } }
  var active: Bool { (try? check()) != nil }
  func cancel() { lock.withLock { cancelled = true } }
}
