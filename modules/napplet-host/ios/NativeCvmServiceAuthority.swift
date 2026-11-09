import Foundation

/// CVM-only native service consent; other capabilities' focused review rules remain untouched.
public final class NativeCvmServiceAuthority: @unchecked Sendable {
  public static let maximumMillis: Int64 = 120_000
  public static let consent = "This request can keep running while you use another napplet. It stops when this app goes into the background, the account changes, or you close this napplet. Up to 2 minutes. Payments through Hypergolic are unavailable. Provider tools may have external effects."
  public final class Source: Sendable {
    public let endpoint: String, generation: String, user: String, publisher: String, appId: String, version: String, instance: String
    public let epoch: Int64
    // Only the native profile-gated ingress constructs this, never an Expo argument/guest record.
    init(endpoint: String, generation: String, user: String, epoch: Int64, publisher: String, appId: String, version: String, instance: String) throws {
      guard NativeCvmServiceAuthority.handle(endpoint), NativeCvmServiceAuthority.handle(generation), NativeCvmServiceAuthority.handle(instance),
        NativeCvmServiceAuthority.hex(user), NativeCvmServiceAuthority.hex(publisher), NativeCvmServiceAuthority.hex(version),
        (0...9_007_199_254_740_991).contains(epoch), NativeCvmServiceAuthority.text(appId, 1024) else { throw Failure.invalid }
      self.endpoint = endpoint; self.generation = generation; self.user = user; self.epoch = epoch
      self.publisher = publisher; self.appId = appId; self.version = version; self.instance = instance
    }
  }
  public final class Registration: Sendable {
    fileprivate let source: Source
    fileprivate init(_ source: Source) { self.source = source }
  }
  public final class Request: Sendable { fileprivate init() {} }
  public struct Review: Sendable {
    public let request: Request, source: Source, provider: String, operation: String, message: String, relays: [String], originalDeadline: Int64
    public let continuesWhileUnfocused = true
    fileprivate init(request: Request, row: Row) {
      self.request = request; source = row.registration.source; provider = row.provider
      operation = row.operation; message = row.message; relays = row.relays; originalDeadline = row.deadline
    }
  }
  public final class Permit: @unchecked Sendable {
    fileprivate let owner: NativeCvmServiceAuthority
    fileprivate let row: Row, revision: UInt64
    fileprivate var emitted = false, cancelled = false
    fileprivate init(owner: NativeCvmServiceAuthority, row: Row, revision: UInt64) { self.owner = owner; self.row = row; self.revision = revision }
    public var source: Source { row.registration.source }
    public var provider: String { row.provider }
    public var relays: [String] { row.relays }
    public var originalDeadline: Int64 { row.deadline }
    public func current() -> Bool { owner.current(self) }
    public func sourceCurrent() -> Bool { owner.current(row.registration) }
    public func sameSource(_ other: Permit) -> Bool { owner === other.owner && row.registration === other.row.registration }
  }
  fileprivate struct Row: Sendable {
    let registration: Registration, provider: String, operation: String, message: String, relays: [String], deadline: Int64
  }
  enum Failure: Error { case invalid }
  private let lock = NSRecursiveLock()
  private let clock: @Sendable () -> Int64
  private var registrations: [String: Registration] = [:]
  private var waiting: [(Request, Row)] = []
  private var active: [ObjectIdentifier: Permit] = [:]
  private var user: String?
  private var epoch: Int64 = -1, lastTime: Int64 = -1
  private var revision: UInt64 = 0
  private var foreground = false, closed = false, clockFailed = false
  public init(clock: @escaping @Sendable () -> Int64) { self.clock = clock }
  private func locked<T>(_ body: () throws -> T) rethrows -> T { lock.lock(); defer { lock.unlock() }; return try body() }
  private static func hex(_ value: String) -> Bool {
    value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
  }
  private static func handle(_ value: String) -> Bool {
    (1...80).contains(value.utf8.count) && value.utf8.allSatisfy { (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95 }
  }
  private static func text(_ value: String, _ maximum: Int) -> Bool {
    !value.isEmpty && value.utf8.count <= maximum && !value.unicodeScalars.contains { $0.value < 32 || $0.value == 127 }
  }
  private func time() -> Int64 {
    let now = clock()
    if now < 0 || now < lastTime || now > Int64.max - Self.maximumMillis { clockFailed = true }
    if !clockFailed { lastTime = now }; return lastTime
  }
  private func live(_ registration: Registration) -> Bool {
    let source = registration.source
    return !closed && !clockFailed && foreground && registrations[source.generation] === registration && source.user == user && source.epoch == epoch
  }
  private func prune() {
    let now = time()
    waiting.removeAll { !live($0.1.registration) || now >= $0.1.deadline }
    for (id, permit) in active where !live(permit.row.registration) || permit.revision != revision || now >= permit.row.deadline {
      permit.cancelled = true; active.removeValue(forKey: id)
    }
  }
  public func account(user: String, epoch: Int64) {
    locked {
      guard Self.hex(user), (0...9_007_199_254_740_991).contains(epoch) else { close(); return }
      if self.user != user || self.epoch != epoch {
        revision &+= 1; waiting.removeAll(); for permit in active.values { permit.cancelled = true }; active.removeAll(); registrations.removeAll()
      }
      self.user = user; self.epoch = epoch; prune()
    }
  }
  public func register(_ source: Source) -> Registration? {
    locked {
      prune(); guard !closed, !clockFailed, registrations.count < 64, registrations[source.generation] == nil else { return nil }
      let registration = Registration(source); registrations[source.generation] = registration; return registration
    }
  }
  /// Native ingress captures this before delivery/review/setup; no caller-selected clock or renewed budget.
  public func admit(_ registration: Registration, provider: String, operation: String, exactMessage: String, relays: [String], timeoutMillis: Int64) -> Request? {
    locked {
      prune()
      guard live(registration), Self.hex(provider), Self.text(operation, 128), !exactMessage.isEmpty, exactMessage.utf8.count <= 32768,
        (1...Self.maximumMillis).contains(timeoutMillis), (1...4).contains(relays.count), relays.allSatisfy({ Self.text($0, 2048) }),
        Set(relays).count == relays.count, waiting.count + active.count < 4 else { return nil }
      let own = waiting.filter { $0.1.registration === registration }.count + active.values.filter { $0.row.registration === registration }.count
      guard own < 2 else { return nil }
      let request = Request(), row = Row(registration: registration, provider: provider, operation: operation, message: exactMessage, relays: relays, deadline: lastTime + timeoutMillis)
      waiting.append((request, row)); return request
    }
  }
  public func review() -> Review? {
    locked { prune(); guard let first = waiting.first else { return nil }; return Review(request: first.0, row: first.1) }
  }
  /// This exact native service review creates the permit; a later card focus change does not renew/revoke it.
  public func approve(_ request: Request) -> Permit? {
    locked {
      guard let review = review(), review.request === request else { return nil }
      let row = waiting.removeFirst().1, permit = Permit(owner: self, row: row, revision: revision)
      active[ObjectIdentifier(permit)] = permit; return permit
    }
  }
  public func current(_ permit: Permit) -> Bool {
    locked { guard permit.owner === self else { return false }; prune(); return !permit.cancelled && permit.revision == revision && active[ObjectIdentifier(permit)] === permit && live(permit.row.registration) }
  }
  public func current(_ registration: Registration) -> Bool { locked { prune(); return live(registration) } }
  public func consume(_ permit: Permit, provider: String, exactMessage: String, relay: String) -> Bool {
    locked {
      guard current(permit), !permit.emitted, permit.row.provider == provider, permit.row.message.utf8.elementsEqual(exactMessage.utf8),
        permit.row.relays.contains(where: { $0.utf8.elementsEqual(relay.utf8) }) else { return false }
      permit.emitted = true; return true
    }
  }
  public func finish(_ permit: Permit) -> Bool { locked { let valid = current(permit); cancel(permit); return valid } }
  public func cancel(_ request: Request) { locked { waiting.removeAll { $0.0 === request } } }
  public func cancel(_ permit: Permit) { locked { guard permit.owner === self else { return }; permit.cancelled = true; active.removeValue(forKey: ObjectIdentifier(permit)) } }
  public func revoke(_ registration: Registration) {
    locked { if registrations[registration.source.generation] === registration { registrations.removeValue(forKey: registration.source.generation) }; prune() }
  }
  public func setForeground(_ value: Bool) {
    locked {
      foreground = value
      if !value { revision &+= 1; waiting.removeAll(); for permit in active.values { permit.cancelled = true }; active.removeAll(); registrations.removeAll() }
      prune()
    }
  }
  public func close() { locked { closed = true; setForeground(false); registrations.removeAll() } }
}
