import Foundation
private final class TestClock: @unchecked Sendable {
  private let lock = NSLock()
  private var time = ContinuousClock.now
  func read() -> ContinuousClock.Instant { lock.withLock { time } }
  func advance(_ seconds: Int64) { lock.withLock { time = time.advanced(by: .seconds(seconds)) } }
}
@main struct RoutingCoreTests {
  static var count = 0
  static func expect(_ value: Bool) { count += 1; precondition(value, "Routing assertion \(count)") }
  static func main() {
    let a = String(repeating: "a", count: 64), b = String(repeating: "b", count: 64), r = RoutingEndpointRegistry()
    expect(!r.register("old", user:a, epoch:0, intent:true, inc:true)); expect(r.synchronizeOwner(a, epoch:0, available:true))
    expect(!r.synchronizeOwner(b, epoch:0, available:true)); expect(!r.register("wrong-user", user:b, epoch:0, intent:true, inc:true))
    expect(!r.register("wrong-epoch", user:a, epoch:1, intent:true, inc:true)); expect(!r.register("none", user:a, epoch:0, intent:false, inc:false))
    expect(r.register("source", user:a, epoch:0, intent:true, inc:true)); expect(!r.register("source", user:a, epoch:0, intent:true, inc:true))
    expect(!r.mayDeliver("source", domain:"inc")); r.ready("source"); expect(r.mayDeliver("source", domain:"inc"))
    expect(!r.mayReview("source")); r.focus("source", true); expect(r.mayReview("source"))
    var revision = r.state().revision; r.focus("source", false); expect(r.state().revision == revision); expect(r.mayDeliver("source", domain:"inc")); expect(!r.mayReview("source"))
    expect(r.register("target", user:a, epoch:0, intent:false, inc:true)); r.ready("target"); expect(r.mayDeliver("target", domain:"inc")); expect(!r.mayDeliver("target", domain:"intent"))
    r.setForeground(false); expect(!r.mayDeliver("source", domain:"inc")); expect(!r.matchesRevision(revision))
    r.setForeground(true); expect(r.mayDeliver("source", domain:"inc")); expect(!r.matchesRevision(revision))
    revision = r.state().revision; expect(r.synchronizeOwner(a, epoch:0, available:false)); expect(!r.mayDeliver("source", domain:"inc")); expect(!r.matchesRevision(revision))
    expect(r.synchronizeOwner(a, epoch:0, available:true)); expect(r.mayDeliver("source", domain:"inc"))
    expect(r.synchronizeOwner(b, epoch:1, available:true)); expect(!r.mayDeliver("source", domain:"inc")); expect(!r.synchronizeOwner(a, epoch:0, available:true))
    expect(r.register("new", user:b, epoch:1, intent:true, inc:true)); r.ready("new"); expect(r.mayDeliver("new", domain:"intent")); r.revoke("new"); expect(!r.mayDeliver("new", domain:"intent"))
    let limit = RoutingEndpointRegistry(); expect(limit.synchronizeOwner(a, epoch:0, available:true))
    for i in 0..<64 { expect(limit.register("endpoint-\(i)", user:a, epoch:0, intent:true, inc:true)) }
    expect(!limit.register("overflow", user:a, epoch:0, intent:true, inc:true)); limit.revoke("endpoint-0"); expect(limit.register("replacement", user:a, epoch:0, intent:true, inc:true))
    let presentation = RoutingEndpointRegistry(); expect(presentation.synchronizeOwner(a, epoch:0, available:true))
    expect(presentation.register("config-only", user:a, epoch:0, intent:false, inc:false, notify:false, config:true)); presentation.ready("config-only")
    expect(presentation.mayDeliver("config-only", domain:"config")); expect(!presentation.mayDeliver("config-only", domain:"notify")); expect(!presentation.mayDeliver("config-only", domain:"intent")); expect(!presentation.mayDeliver("config-only", domain:"inc"))
    presentation.focus("config-only", true); expect(presentation.mayReview("config-only")); presentation.focus("config-only", false); expect(!presentation.mayReview("config-only")); expect(presentation.mayDeliver("config-only", domain:"config"))
    expect(presentation.register("notify-only", user:a, epoch:0, intent:false, inc:false, notify:true, config:false)); presentation.ready("notify-only"); expect(presentation.mayDeliver("notify-only", domain:"notify")); expect(!presentation.mayDeliver("notify-only", domain:"config"))
    let captured = presentation.state().revision; presentation.setForeground(false); expect(!presentation.mayDeliver("config-only", domain:"config")); expect(!presentation.mayDeliver("notify-only", domain:"notify")); expect(!presentation.matchesRevision(captured))
    presentation.setForeground(true); expect(presentation.mayDeliver("config-only", domain:"config")); expect(presentation.mayDeliver("notify-only", domain:"notify"))
    presentation.revoke("config-only"); expect(!presentation.mayDeliver("config-only", domain:"config")); expect(presentation.synchronizeOwner(b, epoch:1, available:true)); expect(!presentation.mayDeliver("notify-only", domain:"notify"))
    let reviews = RoutingEndpointRegistry(); expect(reviews.synchronizeOwner(a, epoch:0, available:true))
    expect(reviews.register("settings", user:a, epoch:0, intent:false, inc:false, config:true)); reviews.ready("settings")
    let deliveryRevision = reviews.state().revision; expect(reviews.reviewRevision("settings") == -1); expect(reviews.reviewRevision("missing") == -1)
    expect(reviews.focus("settings", true)); let firstReview = reviews.reviewRevision("settings"); expect(firstReview >= 0)
    expect(!reviews.focus("settings", true)); expect(reviews.reviewRevision("settings") == firstReview)
    expect(reviews.focus("settings", false)); expect(reviews.reviewRevision("settings") == -1); expect(reviews.mayDeliver("settings", domain:"config"))
    expect(reviews.focus("settings", true)); expect(reviews.reviewRevision("settings") > firstReview); expect(reviews.state().revision == deliveryRevision)
    expect(reviews.register("peer", user:a, epoch:0, intent:false, inc:true)); reviews.ready("peer"); let currentReview = reviews.reviewRevision("settings")
    expect(reviews.focus("peer", true)); expect(reviews.reviewRevision("settings") == currentReview); expect(reviews.matchesRevision(deliveryRevision))
    reviews.setForeground(false); expect(reviews.reviewRevision("settings") == -1); reviews.setForeground(true); expect(!reviews.matchesRevision(deliveryRevision))
    reviews.revoke("settings"); expect(reviews.reviewRevision("settings") == -1)
    let discovery = RoutingEndpointRegistry(); expect(discovery.synchronizeOwner(a, epoch: 0, available: true))
    expect(discovery.register("catalog", user: a, epoch: 0, intent: false, inc: false, publishedOpen: true))
    expect(discovery.register("target", user: a, epoch: 0, intent: false, inc: false, trackPublished: true))
    discovery.focus("catalog", true); expect(!discovery.mayReview("catalog")); discovery.ready("catalog")
    expect(discovery.mayReview("catalog")); expect(discovery.mayDeliver("catalog", domain: "published-open"))
    expect(!discovery.mayDeliver("catalog", domain: "intent")); discovery.focus("catalog", false)
    expect(!discovery.mayReview("catalog")); expect(discovery.mayDeliver("catalog", domain: "published-open"))
    discovery.ready("target"); discovery.focus("target", true)
    expect(discovery.mayReview("target")); expect(!discovery.mayDeliver("target", domain: "published-open"))
    discovery.revoke("catalog"); expect(!discovery.mayDeliver("catalog", domain: "published-open"))
    let clock = TestClock(), leases = CapabilityLeaseRegistry(now: { clock.read() })
    expect(leases.register("catalog"))
    let ordinary = leases.admit("catalog", sequence: 1, snapshot: "{}")!
    let open = leases.admit("catalog", sequence: 2, snapshot: "{}", publishedOpen: true)!
    expect(leases.take(ordinary) != nil); expect(leases.take(open) != nil); expect(leases.take(open) == nil)
    clock.advance(25)
    expect(!leases.isActive(ordinary)); expect(leases.isActive(open))
    expect(leases.setForeground(false).contains(open)); _ = leases.setForeground(true)
    expect(!leases.isActive(open)); expect(!leases.finish(open))
    let next = leases.admit("catalog", sequence: 3, snapshot: "{}", publishedOpen: true)!
    expect(leases.take(next) != nil); clock.advance(120); expect(!leases.isActive(next))
    print("iOS routing core \(count) assertions passed")
  }
}
