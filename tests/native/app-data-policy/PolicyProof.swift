import Foundation
import CryptoKit

@main private struct PolicyProof {
  static func json(_ value: String) throws -> [String: Any] {
    try JSONSerialization.jsonObject(with: Data(value.utf8)) as! [String: Any]
  }
  static func same(_ left: [String: Any], _ right: [String: Any]) -> Bool {
    NSDictionary(dictionary: left).isEqual(to: right)
  }
  static func hash(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }
  static func metadata(_ configuration: CapabilityConfiguration, generation: String) throws -> [String: Any] {
    let bytes = Data("<html>policy fixture</html>".utf8)
    let htmlHash = hash(bytes), version = hash(Data("\(htmlHash) /index.html\n".utf8))
    let registry = PublishedArtifactRegistry()
    precondition(registry.registerSession(configuration.sessionId))
    let claims = PublishedArtifactRegistry.Claims(sessionId: configuration.sessionId, publisher: configuration.publisher,
      identifier: configuration.appId, eventId: String(repeating: "b", count: 64), aggregateHash: version, htmlHash: htmlHash)
    let handle = registry.stage(bytes, claims: claims)!
    let claimed = registry.claim(handle, claims: claims, viewGeneration: generation)!
    let reader = PublishedArtifactReadOwner(claimed: claimed, domains: configuration.domains,
      publishedOpen: configuration.publishedOpen, appData: configuration.appData)
    let raw = reader.read(sequence: 0)!
    precondition(reader.read(sequence: 1) == nil, "One-use artifact reader")
    return try json(raw)
  }
  static func main() throws {
    let input = try json(String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8))
    let rows = input["cases"] as! [[String: Any]], message = input["request"] as! String
    var accepted = 0
    for row in rows {
      let name = row["name"] as! String, raw = row["raw"] as! String
      let parsed = try? CapabilityConfiguration(raw, generation: "generation-a")
      precondition((parsed != nil) == (row["ok"] as! Bool), "Configuration outcome: \(name)")
      guard let parsed else { continue }
      accepted += 1
      var original = row["configuration"] as! [String: Any]
      let snapshot = try json(parsed.snapshot)
      precondition(snapshot["generation"] as? String == "generation-a", "Native generation: \(name)")
      precondition(parsed.domains == Set(original["domains"] as! [String]))
      precondition(parsed.allowsRelayOperation("relay.publish") == parsed.domains.contains("relay"))
      precondition(parsed.allowsRelayOperation("outbox.publish") == parsed.domains.contains("outbox"))
      let projected = try metadata(parsed, generation: "generation-a")
      precondition(projected["sessionId"] as? String == "generation-a")
      if let expected = original["appData"] as? [String: Any] {
        let captured = try json(parsed.appData!)
        precondition(same(captured, expected), "Captured policy: \(name)")
        precondition(same(snapshot["appData"] as! [String: Any], expected), "Policy snapshot: \(name)")
        precondition(same(projected["appData"] as! [String: Any], expected), "Guest metadata: \(name)")
      } else {
        precondition(parsed.appData == nil && snapshot["appData"] == nil && projected["appData"] == nil)
      }
      let envelope = try json(parsed.request(message))
      precondition((envelope["request"] as! String).utf8.elementsEqual(message.utf8), "Opaque request changed: \(name)")
      precondition(same(envelope["registration"] as! [String: Any], snapshot), "Registration changed: \(name)")
      let next = try CapabilityConfiguration(raw, generation: "generation-b")
      let nextSnapshot = try json(next.snapshot), oldSnapshot = try json(parsed.snapshot)
      let nextMetadata = try metadata(next, generation: "generation-b")
      precondition(nextSnapshot["generation"] as? String == "generation-b")
      precondition(oldSnapshot["generation"] as? String == "generation-a")
      precondition(nextMetadata["sessionId"] as? String == "generation-b")
      original["appData"] = ["forged": true]
      let unchanged = try json(parsed.snapshot)
      precondition(same(unchanged, snapshot), "Mutable caller changed captured config: \(name)")
    }
    print("Swift app-data policy: \(rows.count) cases passed; \(accepted) configuration/request/metadata roundtrips")
  }
}
