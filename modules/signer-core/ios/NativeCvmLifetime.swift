import Foundation

/// Native capacity/lifetime accounting only. The host permit independently guards each emission.
final class NativeCvmLifetime: @unchecked Sendable {
  private static let lock = NSRecursiveLock()
  nonisolated(unsafe) private static var sessions: [ObjectIdentifier: Session] = [:]
  private let clock: @Sendable () -> Int64
  private var foreground = false, closed = false, clockFailed = false
  private var revision: UInt64 = 0
  private var lastTime: Int64 = -1
  final class Session: @unchecked Sendable {
    fileprivate let owner: NativeCvmLifetime, revision: UInt64
    fileprivate let current: @Sendable () -> Bool
    fileprivate var idleDeadline: Int64
    fileprivate var cancelled = false, released = false, uncertain = false
    fileprivate var operation: Operation?
    fileprivate init(owner: NativeCvmLifetime, current: @escaping @Sendable () -> Bool, idleDeadline: Int64) {
      self.owner = owner; self.current = current; self.revision = owner.revision; self.idleDeadline = idleDeadline
    }
  }
  final class Operation: @unchecked Sendable {
    fileprivate let session: Session, deadline: Int64
    fileprivate var terminal = false
    fileprivate init(session: Session, deadline: Int64) { self.session = session; self.deadline = deadline }
  }
  enum Failure: Error { case unavailable }
  init(clock: @escaping @Sendable () -> Int64) { self.clock = clock }
  private func locked<T>(_ body: () throws -> T) rethrows -> T {
    Self.lock.lock(); defer { Self.lock.unlock() }; return try body()
  }
  private func now() throws -> Int64 {
    let value = clock()
    if value < 0 || value < lastTime || value > Int64.max - 120_000 { clockFailed = true }
    guard !clockFailed else { throw Failure.unavailable }
    lastTime = value; return value
  }
  private func check(_ session: Session, _ time: Int64) throws {
    guard !closed, foreground, session.owner === self, session.revision == revision,
      !session.cancelled, !session.released, !session.uncertain,
      Self.sessions[ObjectIdentifier(session)] === session,
      session.operation != nil || time < session.idleDeadline else { throw Failure.unavailable }
  }
  func open(current: @escaping @Sendable () -> Bool) throws -> Session {
    guard current() else { throw Failure.unavailable }
    return try locked {
      let time = try now()
      guard !closed, foreground, Self.sessions.count < 2, time <= Int64.max - 120_000 else { throw Failure.unavailable }
      let session = Session(owner: self, current: current, idleDeadline: time + 30_000)
      Self.sessions[ObjectIdentifier(session)] = session; return session
    }
  }
  /// Original native ingress deadline, including review/init/dispatch; it cannot be renewed here.
  func begin(_ session: Session, originalDeadline: Int64) throws -> Operation {
    try current(session)
    return try locked {
      let time = try now(); try check(session, time)
      guard session.operation == nil, originalDeadline > time, originalDeadline - time <= 120_000 else { throw Failure.unavailable }
      let operation = Operation(session: session, deadline: originalDeadline)
      session.operation = operation; return operation
    }
  }
  func current(_ session: Session) throws {
    guard session.owner === self, session.current() else { throw Failure.unavailable }
    try locked { try check(session, now()) }
  }
  func current(_ operation: Operation) throws {
    try current(operation.session)
    try locked { try checkOperation(operation) }
  }
  private func checkOperation(_ operation: Operation) throws {
    let time = try now(); try check(operation.session, time)
    guard !operation.terminal, operation.session.operation === operation, time < operation.deadline else { throw Failure.unavailable }
  }
  func delivered(_ operation: Operation) throws {
    try current(operation)
    try locked {
      try checkOperation(operation); operation.terminal = true; operation.session.operation = nil
      operation.session.idleDeadline = try now() + 30_000
    }
  }
  func cancel(_ session: Session) {
    locked { if session.owner === self { session.cancelled = true } }
  }
  /// Teardown calls only after all socket/key resources actually unwind. Uncertainty stays reserved.
  func drained(_ session: Session, certain: Bool) {
    locked {
      guard session.owner === self, !session.released else { return }
      session.cancelled = true
      guard certain else { session.uncertain = true; return }
      guard !session.uncertain else { return }
      session.released = true; Self.sessions.removeValue(forKey: ObjectIdentifier(session))
    }
  }
  func setForeground(_ value: Bool) {
    locked {
      foreground = value
      if !value {
        revision &+= 1
        for session in Self.sessions.values where session.owner === self { session.cancelled = true }
      }
    }
  }
  func close() { locked { closed = true; setForeground(false) } }
}
