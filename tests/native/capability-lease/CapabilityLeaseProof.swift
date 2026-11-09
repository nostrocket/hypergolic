import Foundation

private final class TestClock: @unchecked Sendable {
  private let lock = NSLock()
  private var value = ContinuousClock.now
  func now() -> ContinuousClock.Instant { lock.withLock { value } }
  func advance(_ milliseconds: Int64) { lock.withLock { value = value.advanced(by: .milliseconds(milliseconds)) } }
}
private final class Counter: @unchecked Sendable {
  private let lock = NSLock()
  private var value = 0
  func increment() { lock.withLock { value += 1 } }
  func read() -> Int { lock.withLock { value } }
}
@main
private struct CapabilityLeaseProof {
  static func main() throws {
    var checks = 0
    func check(_ value: Bool, _ message: String) throws {
      guard value else { throw NSError(domain: message, code: 1) }
      checks += 1
    }
    let clock = TestClock()
    let leases = CapabilityLeaseRegistry(now: clock.now)
    try check(leases.register("generation-a"), "register")
    try check(!leases.register("generation-a"), "duplicate registration")
    try check(!leases.register("bad/path"), "invalid generation")
    try check(leases.admit("foreign", sequence: 1, snapshot: "snapshot") == nil, "unknown generation")
    try check(leases.admit("generation-a", sequence: 2, snapshot: "snapshot") == nil, "out-of-order sequence")
    let admitted = leases.admit("generation-a", sequence: 1, snapshot: "immutable snapshot")
    try check(admitted != nil, "admit")
    let token = admitted!
    try check(!leases.isActive(token), "unclaimed token")
    try check(leases.take(token) == "immutable snapshot", "original snapshot")
    try check(leases.take(token) == nil, "single take")
    try check(leases.isActive(token), "claimed token")
    try check(leases.finish(token), "complete once")
    try check(!leases.finish(token) && !leases.isActive(token), "no reuse")
    try check(leases.admit("generation-a", sequence: 1, snapshot: "changed") == nil, "transport replay")
    let expires = leases.admit("generation-a", sequence: 2, snapshot: "expiry")!
    _ = leases.take(expires); clock.advance(24_999)
    try check(leases.isActive(expires), "before exact expiry")
    clock.advance(1)
    try check(!leases.isActive(expires) && !leases.finish(expires), "exact native expiry")
    let revoked = leases.admit("generation-a", sequence: 3, snapshot: "revoked")!
    _ = leases.take(revoked); leases.revoke("generation-a")
    try check(!leases.sessionActive("generation-a") && !leases.isActive(revoked), "synchronous revocation")
    try check(leases.take(revoked) == nil && !leases.finish(revoked), "revoked result")

    let bounded = CapabilityLeaseRegistry(now: clock.now)
    _ = bounded.register("one"); _ = bounded.register("two"); _ = bounded.register("three")
    var pending: [String] = []
    for i in 1...4 {
      let token = bounded.admit("one", sequence: UInt64(i), snapshot: "x")
      try check(token != nil, "per-view admit"); pending.append(token!)
    }
    try check(bounded.admit("one", sequence: 5, snapshot: "overflow") == nil, "per-view bound")
    for i in 1...4 { try check(bounded.admit("two", sequence: UInt64(i), snapshot: "x") != nil, "global admit") }
    try check(bounded.admit("three", sequence: 1, snapshot: "overflow") == nil, "global bound")
    _ = bounded.take(pending[0]); _ = bounded.finish(pending[0])
    try check(bounded.admit("one", sequence: 6, snapshot: "after overload") != nil, "sequence advances after overload")
    bounded.revoke("two")
    try check(bounded.admit("three", sequence: 2, snapshot: "released") != nil, "revocation releases capacity")
    clock.advance(25_000)
    try check(bounded.admit("three", sequence: 3, snapshot: "expired") != nil, "expiry releases capacity")
    try check(bounded.admit("three", sequence: 4, snapshot: String(repeating: "🧪", count: CapabilityLeaseRegistry.maxBytes / 4 + 1)) == nil, "UTF-8 byte bound")
    try check(bounded.admit("three", sequence: 5, snapshot: String(repeating: "😀", count: CapabilityLeaseRegistry.maxBytes / 4)) != nil, "exact UTF-8 boundary")

    let concurrent = CapabilityLeaseRegistry(now: clock.now)
    _ = concurrent.register("concurrent")
    let race = concurrent.admit("concurrent", sequence: 1, snapshot: "one claimant")!
    let winners = Counter()
    DispatchQueue.concurrentPerform(iterations: 16) { _ in if concurrent.take(race) != nil { winners.increment() } }
    try check(winners.read() == 1, "concurrent single-use claim")
    concurrent.revoke("concurrent")
    try check(!concurrent.finish(race), "concurrent revoke invalidates claimant")
    let sessions = CapabilityLeaseRegistry(now: clock.now)
    for i in 0..<64 { try check(sessions.register("session-\(i)"), "session admit") }
    try check(!sessions.register("session-overflow"), "session bound")
    sessions.revoke("session-0")
    try check(sessions.register("fresh-generation"), "fresh generation capacity")
    let lifetime = CapabilityLeaseRegistry(now: clock.now)
    _ = lifetime.register("loaded")
    let old = lifetime.admit("loaded", sequence: 1, snapshot: "old")!
    _ = lifetime.take(old)
    let unclaimed = lifetime.admit("loaded", sequence: 2, snapshot: "unclaimed")!
    try check(lifetime.setForeground(false).count == 2, "background revokes every pending token")
    try check(lifetime.sessionActive("loaded"), "loaded view retained")
    try check(lifetime.admit("loaded", sequence: 3, snapshot: "background") == nil, "background admission denied and sequence consumed")
    _ = lifetime.setForeground(true)
    try check(!lifetime.isActive(old) && lifetime.borrowedSnapshot(old) == nil && !lifetime.finish(old), "return cannot resurrect claimed work")
    try check(lifetime.take(unclaimed) == nil, "return cannot claim old unclaimed work")
    try check(lifetime.admit("loaded", sequence: 3, snapshot: "replay") == nil, "background sequence cannot replay")
    let fresh = lifetime.admit("loaded", sequence: 4, snapshot: "fresh")!
    try check(lifetime.take(fresh) == "fresh" && lifetime.finish(fresh), "new foreground request succeeds")
    let deferred = CapabilityLeaseRegistry(now: clock.now)
    _ = deferred.register("first"); _ = deferred.register("second")
    let held = (1...4).map { deferred.admit("first", sequence: UInt64($0), snapshot: "held")! }
    let set = deferred.enqueue("first", sequence: 5, snapshot: "storage.set:k=v")!
    let get = deferred.enqueue("first", sequence: 6, snapshot: "storage.get:k")!
    let remove = deferred.enqueue("first", sequence: 7, snapshot: "storage.remove:k")!
    let other = deferred.enqueue("second", sequence: 1, snapshot: "other view")!
    try check(deferred.retained(set) && deferred.take(set) == nil && deferred.borrowedSnapshot(set) == nil, "waiting does not authorize work")
    try check(deferred.promote() == [other], "a full view cannot block another eligible view")
    try check(deferred.admit("first", sequence: 8, snapshot: "fast direct") == nil, "waiting does not increase active capacity")
    _ = deferred.take(held[0]); _ = deferred.finish(held[0])
    try check(deferred.promote() == [set], "first waiting storage snapshot")
    try check(deferred.take(set) == "storage.set:k=v" && deferred.finish(set), "exact set once")
    try check(deferred.promote() == [get], "get stays behind set")
    try check(deferred.take(get) == "storage.get:k" && deferred.finish(get), "exact get once")
    try check(deferred.promote() == [remove], "remove stays behind get")
    try check(deferred.take(remove) == "storage.remove:k", "exact remove snapshot")
    let waiting = deferred.enqueue("first", sequence: 9, snapshot: "old waiting mutation")!
    let promoted = deferred.enqueue("second", sequence: 2, snapshot: "promoted before background")!
    try check(deferred.promote() == [promoted], "other view promoted but not dispatched")
    try check(Set(deferred.setForeground(false)).isSuperset(of: [waiting, remove, promoted]),
      "background invalidates waiting, claimed and promoted-unclaimed phases")
    _ = deferred.setForeground(true)
    try check(deferred.promote().isEmpty && deferred.take(waiting) == nil && deferred.take(promoted) == nil &&
      !deferred.finish(remove), "resume cannot promote, take or commit old work")
    try check(deferred.enqueue("first", sequence: 9, snapshot: "replay") == nil, "queued sequence was consumed")
    let delayed = deferred.enqueue("first", sequence: 10, snapshot: "expired set")!
    clock.advance(24_999)
    try check(deferred.promote() == [delayed] && deferred.take(delayed) != nil, "late promotion keeps original lease")
    clock.advance(1)
    try check(!deferred.isActive(delayed) && !deferred.finish(delayed), "promotion does not extend expiry")
    let removed = deferred.enqueue("first", sequence: 11, snapshot: "closing view")!
    deferred.revoke("first")
    try check(!deferred.retained(removed) && deferred.promote().isEmpty, "close cancels waiting work")
    let stale = deferred.enqueue("second", sequence: 3, snapshot: "independent expired set")!
    clock.advance(1000)
    let later = deferred.enqueue("second", sequence: 4, snapshot: "independent later get")!
    clock.advance(24_000)
    try check(deferred.promote() == [later] && deferred.take(stale) == nil, "expired write never executes before a later valid request")
    try check(deferred.take(later) == "independent later get", "later independent request retains its own deadline")

    let queueBounds = CapabilityLeaseRegistry(now: clock.now)
    _ = queueBounds.register("first"); _ = queueBounds.register("second"); _ = queueBounds.register("third")
    for sequence in 1...8 {
      try check(queueBounds.enqueue("first", sequence: UInt64(sequence), snapshot: "a") != nil, "per-view waiting admit")
      try check(queueBounds.enqueue("second", sequence: UInt64(sequence), snapshot: "b") != nil, "process waiting admit")
    }
    try check(queueBounds.enqueue("first", sequence: 9, snapshot: "too many") == nil, "per-view waiting cap")
    try check(queueBounds.enqueue("third", sequence: 1, snapshot: "too many") == nil, "process waiting cap")
    try check(queueBounds.promote().count == 8 && queueBounds.promote().isEmpty, "global active cap is still eight")
    try check(queueBounds.admit("third", sequence: 2, snapshot: "fast") == nil, "fast path still denies at global cap")
    let queueBytes = CapabilityLeaseRegistry(now: clock.now)
    _ = queueBytes.register("first"); _ = queueBytes.register("second")
    let half = String(repeating: "🧪", count: CapabilityLeaseRegistry.maxBytes / 8)
    try check(queueBytes.enqueue("first", sequence: 1, snapshot: half) != nil &&
      queueBytes.enqueue("second", sequence: 1, snapshot: half) != nil, "exact queued UTF-8 byte budget")
    try check(queueBytes.enqueue("second", sequence: 2, snapshot: "overflow") == nil, "queued byte budget shared")
    queueBytes.revoke("first")
    try check(queueBytes.enqueue("second", sequence: 3, snapshot: half) != nil, "revoked waiting bytes returned")

    print("{\"language\":\"Swift\",\"checks\":\(checks),\"failed\":0}")
  }
}
