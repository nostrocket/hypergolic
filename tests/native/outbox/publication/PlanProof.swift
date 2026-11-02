import Foundation
import CryptoKit

// Composition stub only for the static facade; tested registries receive the actual native lease core.
enum CapabilityTransport { static let leases = CapabilityLeaseRegistry() }

@MainActor @main struct PlanProof {
  static var assertions = 0
  static func check(_ value: Bool) { assertions += 1; precondition(value, "Plan assertion \(assertions)") }
  static func denied(_ work: () throws -> Void) { assertions += 1; do { try work() } catch { return }; preconditionFailure("Expected denial") }
  static func wire(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self) }
  static func deniedAck(_ id: String, _ text: String) {
    let ack = OutboxAcknowledgement(id)
    denied { _ = try ack.classify(text) }; check(ack.result == nil)
  }
  static func acknowledgementBounds(_ id: String) throws {
    for reason in ["", String(repeating: "x", count: 4096), String(repeating: "😀", count: 1024)] {
      let ack = OutboxAcknowledgement(id)
      check(try ack.classify(wire(["OK", id, false, reason])) == .eose)
      check(ack.result?.accepted == false); check(ack.result?.reason == reason)
    }
    deniedAck(id, try wire(["OK", id, true, String(repeating: "x", count: 4097)]))
    deniedAck(id, try wire(["OK", id, true, String(repeating: "😀", count: 1025)]))
    deniedAck(id, try wire(["OK", id, true]))
    deniedAck(id, try wire(["OK", id, true, "stored", "extra"]))
    deniedAck(id, try wire(["OK", id, true, NSNull()]))
    deniedAck(id, String(repeating: "[", count: 13) + "0" + String(repeating: "]", count: 13))
    let valid = try wire(["OK", id, true, "stored"])
    let exact = String(repeating: " ", count: 2 * 1024 * 1024 - valid.utf8.count) + valid
    let maximum = OutboxAcknowledgement(id)
    check(try maximum.classify(exact) == .eose); check(maximum.result?.accepted == true)
    deniedAck(id, " " + exact)
    deniedAck(id, valid + " trailing data")
    deniedAck(id, valid + "\u{0}")
    deniedAck(id, valid + "\u{0} trailing data")
    deniedAck(id, valid + (try wire(["OK", id, false, "second response"])))
    for text in [
      "['OK','\(id)',true,'stored']",
      "[OK,\"\(id)\",true,stored]",
      "[\"OK\",\"\(id)\",TRUE,\"stored\"]",
      "[\"OK\";\"\(id)\";true;\"stored\"]",
      "/* comment */ " + valid,
      "// comment\n" + valid,
      "[\"OK\",\"\(id)\",true,\"sto\tred\"]"
    ] { deniedAck(id, text) }
  }
  static func exactUnicodeSource(_ fixture: [String: Any]) throws {
    let composed = "\u{00e9}", decomposed = "e\u{0301}"
    check(composed == decomposed); check(!composed.utf8.elementsEqual(decomposed.utf8))
    var envelope = try JSONSerialization.jsonObject(with: Data((fixture["snapshot"] as! String).utf8)) as! [String: Any]
    var request = try JSONSerialization.jsonObject(with: Data((envelope["request"] as! String).utf8)) as! [String: Any]
    var source = request["event"] as! [String: Any]; source["content"] = composed; source["tags"] = [["t", composed]]
    request["event"] = source; envelope["request"] = try wire(request)
    let original = try wire(envelope), pubkey = (fixture["primary"] as! [String: Any])["pubkey"] as! String
    func review(_ event: [String: Any]) throws -> [String: Any] {
      let canonical: [Any] = [0, pubkey, event["created_at"]!, event["kind"]!, event["tags"]!, event["content"]!]
      let hash = SHA256.hash(data: try JSONSerialization.data(withJSONObject: canonical, options: .withoutEscapingSlashes)).map { String(format: "%02x", $0) }.joined()
      return ["event": event, "selectedPubkey": pubkey, "destinations": (fixture["plan"] as! [String: Any])["event"].flatMap { ($0 as? [String: Any])?["destinations"] }!, "hash": hash]
    }
    let exactReview = try review(source)
    _ = try NativeOutboxPlan.signingSnapshot(snapshot: original, raw: wire(exactReview)); check(true)
    var exactPlan = fixture["plan"] as! [String: Any]; exactPlan["event"] = exactReview
    _ = try NativeOutboxPlan.capture(snapshot: original, raw: wire(exactPlan)); check(true)
    for field in ["content", "tags"] {
      var altered = source; altered[field] = field == "content" ? decomposed as Any : [["t", decomposed]] as Any
      let changedReview = try review(altered); var changedPlan = exactPlan; changedPlan["event"] = changedReview
      denied { _ = try NativeOutboxPlan.signingSnapshot(snapshot: original, raw: wire(changedReview)) }
      denied { _ = try NativeOutboxPlan.capture(snapshot: original, raw: wire(changedPlan)) }
    }
    let escapedReview = try wire(exactReview).replacingOccurrences(of: composed, with: "\\u00e9")
    _ = try NativeOutboxPlan.signingSnapshot(snapshot: original, raw: escapedReview); check(true)
    let leases = CapabilityLeaseRegistry(), registry = ApprovalTransportRegistry(leases: leases, schedule: { _, _ in })
    check(leases.register("unicode-owner")); check(registry.register("unicode-owner")); registry.setForeground(true); registry.setFocused("unicode-owner", active: true)
    let token = registry.admit("unicode-owner", snapshot: original, wireId: "native-outbox-publication", reply: { _ in })!
    check(registry.take(token) != nil); check(registry.prepareOutbox(token, raw: try wire(exactPlan)))
    check(registry.prepareSigning(token, raw: try wire(exactReview)))
    let frozen = registry.signingSnapshot(token)!
    check(!registry.claimNativeSigning(token, expected: frozen.replacingOccurrences(of: composed, with: decomposed)))
    check(registry.claimNativeSigning(token, expected: frozen))
  }
  static func main() throws {
    let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
    let fixture = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    try exactUnicodeSource(fixture)
    let snapshot = fixture["snapshot"] as! String, raw = try wire(fixture["plan"]!)
    let primary = try wire(fixture["primary"]!), list = try wire(fixture["list"]!)
    let plan = try NativeOutboxPlan.capture(snapshot: snapshot, raw: raw)
    check(plan.destinations.count == 2); let relay = plan.destinations[0]
    let send = try plan.reserve(group: "primary", wire: primary, relay: relay)
    check(send.eventId == (fixture["primary"] as! [String: Any])["id"] as! String)
    check(send.frame.hasPrefix("[\"EVENT\",")); check(!send.wasAttempted)
    denied { _ = try plan.reserve(group: "primary", wire: primary, relay: relay) }
    check(try plan.reserve(group: "relay-list", wire: list, relay: relay).eventId == (fixture["list"] as! [String: Any])["id"] as! String)
    denied { _ = try plan.reserve(group: "relay-list", wire: list, relay: relay) }
    denied { _ = try plan.reserve(group: "primary", wire: primary, relay: "wss://elsewhere.org/") }
    denied { _ = try plan.reserve(group: "unknown", wire: primary, relay: plan.destinations[1]) }
    var changed = fixture["primary"] as! [String: Any]; changed["content"] = "changed"
    denied { _ = try plan.reserve(group: "primary", wire: wire(changed), relay: plan.destinations[1]) }
    changed = fixture["primary"] as! [String: Any]; changed["sig"] = String(repeating: "0", count: 128)
    denied { _ = try plan.reserve(group: "primary", wire: wire(changed), relay: plan.destinations[1]) }
    check(try plan.reserve(group: "primary", wire: primary, relay: plan.destinations[1]).deadline == send.deadline)
    for key in ["selectedPubkey", "hash"] {
      var mutation = fixture["plan"] as! [String: Any]; var event = mutation["event"] as! [String: Any]
      event[key] = String(repeating: "0", count: 64); mutation["event"] = event
      denied { _ = try NativeOutboxPlan.capture(snapshot: snapshot, raw: wire(mutation)) }
    }
    var noGrant = try JSONSerialization.jsonObject(with: Data(snapshot.utf8)) as! [String: Any]
    var registration = noGrant["registration"] as! [String: Any]; registration["domains"] = ["relay"]; noGrant["registration"] = registration
    denied { _ = try NativeOutboxPlan.capture(snapshot: wire(noGrant), raw: raw) }
    denied { _ = try NativeOutboxPlan.capture(snapshot: snapshot, raw: String(repeating: "[", count: 30) + "0" + String(repeating: "]", count: 30)) }
    let leases = CapabilityLeaseRegistry(); check(leases.register("owner-a"))
    let registry = ApprovalTransportRegistry(leases: leases, schedule: { _, _ in })
    check(registry.register("owner-a")); registry.setForeground(true); registry.setFocused("owner-a", active: true)
    let token = registry.admit("owner-a", snapshot: snapshot, wireId: "native-outbox-publication", reply: { _ in })!
    check(registry.take(token) == snapshot); check(!registry.mayReview(token)); check(!registry.approve(token))
    check(registry.prepareOutbox(token, raw: raw)); check(!registry.prepareOutbox(token, raw: raw))
    check(registry.mayReview(token)); check(registry.approve(token)); check(!registry.prepareOutbox(token, raw: raw))
    let operation = try registry.reserveOutbox(token, group: "primary", wire: primary, relay: relay)
    var sends = 0
    denied { try registry.sendOutbox(token, operation: send) { sends += 1 } }; check(sends == 0)
    try registry.sendOutbox(token, operation: operation) { sends += 1 }; check(sends == 1)
    denied { try registry.sendOutbox(token, operation: operation) { sends += 1 } }; check(sends == 1)
    let next = try registry.reserveOutbox(token, group: "primary", wire: primary, relay: plan.destinations[1])
    registry.setForeground(false)
    denied { try registry.sendOutbox(token, operation: next) { sends += 1 } }; check(sends == 1)
    registry.setForeground(true); registry.resume()
    denied { try registry.sendOutbox(token, operation: next) { sends += 1 } }; check(sends == 1)
    var tooLarge = fixture["plan"] as! [String: Any], largeEvent = (tooLarge["event"] as! [String: Any])["event"] as! [String: Any]
    largeEvent["content"] = String(repeating: "x", count: 8192)
    let canonical: [Any] = [0, (fixture["primary"] as! [String: Any])["pubkey"]!, largeEvent["created_at"]!, largeEvent["kind"]!, largeEvent["tags"]!, largeEvent["content"]!]
    let largeHash = SHA256.hash(data: try JSONSerialization.data(withJSONObject: canonical, options: [.withoutEscapingSlashes])).map { String(format: "%02x", $0) }.joined()
    var largeCaptured = tooLarge["event"] as! [String: Any]; largeCaptured["event"] = largeEvent; largeCaptured["hash"] = largeHash; tooLarge["event"] = largeCaptured
    var largeSnapshot = try JSONSerialization.jsonObject(with: Data(snapshot.utf8)) as! [String: Any]
    var largeRequest = try JSONSerialization.jsonObject(with: Data((largeSnapshot["request"] as! String).utf8)) as! [String: Any]; largeRequest["event"] = largeEvent; largeSnapshot["request"] = try wire(largeRequest)
    denied { _ = try NativeOutboxPlan.capture(snapshot: wire(largeSnapshot), raw: wire(tooLarge)) }
    let ack = OutboxAcknowledgement(send.eventId)
    check(try ack.classify("[\"NOTICE\",\"ordinary\"]") == .other); check(ack.result == nil)
    check(try ack.classify("[\"OK\",\"wrong-id\",true,\"other\"]") == .other); check(ack.result == nil)
    denied { _ = try ack.classify("[\"OK\",\"\(send.eventId)\",1,\"bad\"]") }; check(ack.result == nil)
    check(try ack.classify("[\"OK\",\"\(send.eventId)\",true,\"accepted\"]") == .eose)
    check(ack.result?.accepted == true); check(ack.result?.reason == "accepted")
    denied { _ = try ack.classify("invalid JSON") }; check(ack.result?.accepted == true)
    _ = try ack.classify("[\"OK\",\"\(send.eventId)\",false,\"later contradictory response\"]"); check(ack.result?.accepted == true)
    let rejected = OutboxAcknowledgement(send.eventId)
    _ = try rejected.classify("[\"OK\",\"\(send.eventId)\",false,\"blocked\"]")
    check(rejected.result?.accepted == false); check(rejected.result?.reason == "blocked")
    try acknowledgementBounds(send.eventId)
    print("{\"status\":\"passed\",\"assertions\":\(assertions),\"scope\":\"native plan and approval core only\"}")
  }
}
