import Foundation

final class TestClock: @unchecked Sendable {
  private let lock = NSLock()
  private var instant = ContinuousClock.now
  func now() -> ContinuousClock.Instant { lock.withLock { instant } }
  func advance(_ duration: Duration) { lock.withLock { instant = instant.advanced(by: duration) } }
}
@main enum RelaySubscriptionProof {
  static func main() {
    var checks = 0
    func check(_ value: Bool) { checks += 1; precondition(value, "Assertion \(checks)") }
    let clock = TestClock()
    let generations = CapabilityLeaseRegistry(now: { clock.now() })
    let streams = RelaySubscriptionRegistry(now: { clock.now() }, generationActive: { generations.sessionActive($0) })
    check(generations.register("one")); check(streams.admit("one", snapshot: "snapshot") == nil)
    streams.setForeground(true)
    let first = streams.admit("one", snapshot: "immutable-one")!; check(!first.isEmpty)
    check(!streams.accept(first)); check(streams.take(first) == "immutable-one"); check(streams.take(first) == nil)
    check(streams.accept(first)); check(streams.connectionLimit(first) == 2); check(!streams.accept(first)); check(streams.isActive(first)); check(streams.mayDeliver(first))
    let outbox = streams.admit("one", snapshot: "native-outbox", outbox: true)!; check(streams.connectionLimit(outbox) == 0); check(streams.take(outbox) != nil); check(streams.accept(outbox)); check(streams.connectionLimit(outbox) == 16); streams.close(outbox); check(streams.connectionLimit(outbox) == 0)
    let pending = streams.admit("one", snapshot: "pending")!; check(!pending.isEmpty)
    check(streams.admit("one", snapshot: "overload") == nil)
    clock.advance(.seconds(25)); check(streams.take(pending) == nil); check(streams.isActive(first))
    streams.setForeground(false); check(streams.isActive(first)); check(!streams.mayDeliver(first)); check(streams.admit("one", snapshot: "background") == nil)
    clock.advance(.seconds(100)); check(streams.isActive(first)); streams.setForeground(true); check(streams.mayDeliver(first))
    generations.revoke("one"); check(!streams.isActive(first)); check(!streams.mayDeliver(first))
    check(generations.register("one")); check(!streams.isActive(first))
    let closed = streams.admit("one", snapshot: "close")!; check(!closed.isEmpty); check(streams.take(closed) != nil); check(streams.accept(closed))
    streams.close(closed); check(!streams.isActive(closed)); check(!streams.accept(closed))
    let revoked = streams.admit("one", snapshot: "revoke")!; check(!revoked.isEmpty); streams.revoke("one"); check(streams.take(revoked) == nil)
    check(streams.admit("missing", snapshot: "forged") == nil); check(streams.admit("one", snapshot: String(repeating:"x",count:32769)) == nil)
    check(streams.admit("one", snapshot:String(repeating:"界",count:10923)) == nil)
    var tokens = Set<String>()
    for i in 0..<4 {
      let generation = "capacity-\(i)"; check(generations.register(generation))
      for _ in 0..<2 { let token = streams.admit(generation,snapshot:"known")!; check(!token.isEmpty); check(tokens.insert(token).inserted); check(streams.take(token) != nil); check(streams.accept(token)) }
    }
    check(generations.register("extra")); check(streams.admit("extra",snapshot:"overload") == nil)
    streams.revokeAll(); for token in tokens { check(!streams.isActive(token)) }
    let exact = streams.admit("extra",snapshot:"exact-expiry")!; check(!exact.isEmpty); clock.advance(.milliseconds(24999)); check(streams.take(exact) != nil)
    clock.advance(.milliseconds(1)); check(!streams.accept(exact))
    print("{\"language\":\"Swift\",\"checks\":\(checks),\"failed\":0}")
  }
}
