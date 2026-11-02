import Foundation
import Network

@main struct OwnerCapacityProof {
  static func main() async throws {
    let args = CommandLine.arguments, port = UInt16(args[1])!
    let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: args[4]))) as! [String: Any]
    let generation = "owner-capacity", snapshot = fixture["snapshot"] as! String
    let destinations = (0..<6).map { "wss://relay.damus.io/proof-\($0)" }
    var plan = fixture["plan"] as! [String: Any], reviewedEvent = plan["event"] as! [String: Any]
    reviewedEvent["destinations"] = destinations; plan["event"] = reviewedEvent
    plan["destinations"] = destinations.map { ["relay": $0] }
    precondition(CapabilityTransport.leases.register(generation))
    let registry = ApprovalTransport.registry
    precondition(registry.register(generation)); registry.setForeground(true); registry.setFocused(generation, active: true)
    defer { registry.revoke(generation); CapabilityTransport.leases.revoke(generation) }
    let token = registry.admit(generation, snapshot: snapshot, wireId: "native-outbox-publication", reply: { _ in })!
    precondition(registry.take(token) == snapshot)
    let planWire = try proofWire(plan)
    precondition(registry.prepareOutbox(token, raw: planWire)); precondition(registry.approve(token))
    let address = PublishedPinnedHTTPS.Address(host: .ipv4(IPv4Address("127.0.0.1")!), bytes: Data([127, 0, 0, 1]))
    let owner = OutboxPublicationOwner(proofTarget: .init(url: "wss://relay.example.org:\(port)/fixture", addresses: [address],
      anchorDER: try Data(contentsOf: URL(fileURLWithPath: args[2])), beforeSend: {}))
    let primaryWire = try proofWire(fixture["primary"]!)
    let ready = args[5], release = args[6]
    var running: [Task<String, Error>] = []
    defer { for task in running { task.cancel() } }
    for relay in destinations.prefix(4) {
      running.append(Task { try await owner.publish(token: token, group: "primary", event: primaryWire, relay: relay) })
    }
    let end = ContinuousClock.now.advanced(by: .seconds(5))
    while !FileManager.default.fileExists(atPath: ready), ContinuousClock.now < end {
      try await Task.sleep(for: .milliseconds(5))
    }
    precondition(FileManager.default.fileExists(atPath: ready), "Four actual relay frames not observed")
    let blocked = try proofReceipt(try await owner.publish(token: token, group: "primary", event: primaryWire, relay: destinations[4]), expected: "cancelled-before-send")
    precondition(blocked["reason"] == "publication capacity unavailable")
    var replayDenied = false
    do { _ = try await owner.publish(token: token, group: "primary", event: primaryWire, relay: destinations[4]) }
    catch NativeOutboxPlan.Failure.replay { replayDenied = true }
    precondition(replayDenied)
    try Data("release after fifth denied before transport\n".utf8).write(to: URL(fileURLWithPath: release))
    var completed: [[String: String]] = []
    for task in running { completed.append(try proofReceipt(try await task.value, expected: "accepted")) }
    proofOwnerIdle(owner)
    let recovered = try proofReceipt(try await owner.publish(token: token, group: "primary", event: primaryWire, relay: destinations[5]), expected: "accepted")
    proofOwnerIdle(owner)
    print(try proofWire(["mode": "capacity", "status": "passed", "blocked": blocked, "completed": completed,
      "recovered": recovered, "replayDenied": replayDenied, "ownerIdle": true,
      "scope": "Actual Swift native owner capacity; controlled host route and public fixture, no physical/signing/guest proof"]))
  }
}
