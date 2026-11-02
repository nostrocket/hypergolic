import Foundation
import CoreFoundation
import CryptoKit

/// Frozen app-only review. Mutable one-use pairs are accessed only under the approval registry lock.
/// Exact template/hash checks complement mandatory app Schnorr verification.
final class NativeOutboxPlan: @unchecked Sendable {
  enum Failure: Error { case invalid, replay, revoked }
  let requestId: String
  let destinations: [String]
  private let template: String
  private let identity: String
  private let hash: String
  private let ancillary: String?
  private let ownerId = UUID()
  private var consumed: Set<String> = []
  private var primary: String?
  private var deadline: ContinuousClock.Instant?

  final class Send: @unchecked Sendable {
    fileprivate let ownerId: UUID
    let relay: String
    let eventId: String
    let frame: String
    let deadline: ContinuousClock.Instant
    private let lock = NSLock()
    private var attempted = false
    var wasAttempted: Bool { lock.withLock { attempted } }
    func markAttempted() { lock.withLock { attempted = true } }
    fileprivate init(_ ownerId: UUID, _ relay: String, _ id: String, _ frame: String, _ deadline: ContinuousClock.Instant) {
      self.ownerId = ownerId; self.relay = relay; eventId = id; self.frame = frame; self.deadline = deadline
    }
  }
  private init(_ id: String, _ destinations: [String], _ template: String, _ identity: String, _ hash: String, _ ancillary: String?) {
    requestId = id; self.destinations = destinations; self.template = template
    self.identity = identity; self.hash = hash; self.ancillary = ancillary
  }
  func reserve(group: String, wire: String, relay: String) throws -> Send {
    guard destinations.contains(relay), ["primary", "relay-list"].contains(group) else { throw Failure.invalid }
    let value = try Self.object(wire), signed = try Self.signed(value, identity: identity)
    if group == "primary" {
      guard Self.bytesEqual(try Self.unsigned(value), template), value["id"] as? String == hash,
        primary == nil || primary.map({ Self.bytesEqual($0, signed) }) == true else { throw Failure.invalid }
      primary = signed
    } else { guard ancillary != nil, ancillary.map({ Self.bytesEqual($0, signed) }) == true, primary != nil else { throw Failure.invalid } }
    guard consumed.insert(group + "\n" + relay).inserted, let id = value["id"] as? String else { throw Failure.replay }
    if deadline == nil { deadline = ContinuousClock.now.advanced(by: .seconds(15)) }
    return Send(ownerId, relay, id, "[\"EVENT\"," + signed + "]", deadline!)
  }
  func owns(_ operation: Send) -> Bool { operation.ownerId == ownerId }
  static func signingSnapshot(snapshot: String, raw: String) throws -> (json: String, destinations: [String]) {
    let envelope = try object(snapshot), review = try object(raw)
    guard let registration = envelope["registration"] as? [String: Any],
      let identity = registration["user"] as? String, hex(identity, 64),
      let requestRaw = envelope["request"] as? String else { throw Failure.invalid }
    let request = try object(requestRaw)
    guard ["relay.publish", "outbox.publish"].contains(request["type"] as? String ?? ""),
      let original = request["event"] as? [String: Any], let event = review["event"] as? [String: Any] else { throw Failure.invalid }
    try fields(review, ["event", "selectedPubkey", "destinations", "hash"])
    let originalTemplate = try unsigned(original, strict: true), capturedTemplate = try unsigned(event, strict: true)
    let capturedHash = try eventHash(event, identity: identity)
    guard review["selectedPubkey"] as? String == identity, bytesEqual(originalTemplate, capturedTemplate),
      review["hash"] as? String == capturedHash,
      let destinations = review["destinations"] as? [String], (1...16).contains(destinations.count),
      Set(destinations).count == destinations.count else { throw Failure.invalid }
    for destination in destinations { try relayURL(destination) }
    var capturedEvent = event; capturedEvent["pubkey"] = identity
    let encoded: [String: Any] = ["registration": registration, "event": capturedEvent, "destinations": destinations]
    return (String(decoding: try JSONSerialization.data(withJSONObject: encoded, options: [.sortedKeys, .withoutEscapingSlashes]), as: UTF8.self), destinations)
  }
  static func capture(snapshot: String, raw: String) throws -> NativeOutboxPlan {
    let envelope = try object(snapshot), plan = try object(raw)
    guard let registration = envelope["registration"] as? [String: Any],
      let requestText = envelope["request"] as? String, let identity = registration["user"] as? String,
      hex(identity, 64), let domains = registration["domains"] as? [String], domains.contains("relay"), domains.contains("outbox")
    else { throw Failure.invalid }
    let request = try object(requestText)
    try fields(plan, ["requestId", "event", "destinations", "requiredInboxes", "ownSource", "ancillary"])
    guard request["type"] as? String == "outbox.publish", let id = request["id"] as? String,
      plan["requestId"] as? String == id, let event = plan["event"] as? [String: Any],
      let source = request["event"] as? [String: Any], let captured = event["event"] as? [String: Any],
      event["selectedPubkey"] as? String == identity else { throw Failure.invalid }
    try fields(event, ["event", "selectedPubkey", "destinations", "hash"])
    let template = try unsigned(source, strict: true), kind = try integer(source["kind"], maximum: 65535)
    guard bytesEqual(try unsigned(captured, strict: true), template), kind != 22242, kind != 24242 else { throw Failure.invalid }
    let hash = try eventHash(captured, identity: identity)
    guard event["hash"] as? String == hash, let destinations = event["destinations"] as? [String],
      (1...16).contains(destinations.count), Set(destinations).count == destinations.count,
      let reviewed = plan["destinations"] as? [[String: Any]], reviewed.count == destinations.count,
      zip(reviewed, destinations).allSatisfy({ $0["relay"] as? String == $1 }),
      let required = plan["requiredInboxes"] as? [String], required.allSatisfy({ destinations.contains($0) })
    else { throw Failure.invalid }
    for relay in destinations { try relayURL(relay) }
    let skipped = (request["options"] as? [String: Any])?["toOutbox"] as? Bool == false
    guard !skipped || plan["ownSource"] as? String == "skipped" else { throw Failure.invalid }
    var ancillary: String?
    if !(plan["ancillary"] is NSNull) {
      guard !skipped, let value = plan["ancillary"] as? [String: Any], try integer(value["kind"], maximum: 65535) == 10002 else { throw Failure.invalid }
      ancillary = try signed(value, identity: identity)
    }
    var dummy = captured; dummy["id"] = hash; dummy["pubkey"] = identity; dummy["sig"] = String(repeating: "0", count: 128)
    guard try ("[\"EVENT\"," + signed(dummy, identity: identity) + "]").utf8.count <= PublishedRelayWebSocketClientFrames.maxTextBytes,
      ancillary == nil || ("[\"EVENT\"," + ancillary! + "]").utf8.count <= PublishedRelayWebSocketClientFrames.maxTextBytes else { throw Failure.invalid }
    return NativeOutboxPlan(id, destinations, template, identity, hash, ancillary)
  }
  private static func bytesEqual(_ a: String, _ b: String) -> Bool { a.utf8.elementsEqual(b.utf8) }
  private static func object(_ raw: String) throws -> [String: Any] {
    guard boundedJSON(raw), let data = raw.data(using: .utf8),
      let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw Failure.invalid }
    return value
  }
  static func boundedJSON(_ raw: String) -> Bool {
    guard raw.utf8.count <= 2 * 1024 * 1024 else { return false }
    var depth = 0, quoted = false, escaped = false
    for value in raw.utf8 {
      if quoted {
        if escaped { escaped = false } else if value == 92 { escaped = true } else if value == 34 { quoted = false }
      } else if value == 34 { quoted = true }
      else if value == 91 || value == 123 { depth += 1; if depth > 12 { return false } }
      else if value == 93 || value == 125 { depth -= 1; if depth < 0 { return false } }
    }
    return depth == 0 && !quoted
  }
  private static func fields(_ value: [String: Any], _ expected: Set<String>) throws {
    guard Set(value.keys) == expected else { throw Failure.invalid }
  }
  private static func integer(_ value: Any?, maximum: Int64) throws -> Int64 {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
      number.doubleValue.isFinite, number.doubleValue.rounded(.towardZero) == number.doubleValue,
      number.doubleValue >= 0, number.doubleValue <= Double(maximum) else { throw Failure.invalid }
    return number.int64Value
  }
  private static func tags(_ value: Any?) throws -> String {
    guard let rows = value as? [[String]], rows.allSatisfy({ !$0.isEmpty }) else { throw Failure.invalid }
    return "[" + rows.map { "[" + $0.map(quote).joined(separator: ",") + "]" }.joined(separator: ",") + "]"
  }
  private static func unsigned(_ value: [String: Any], strict: Bool = false) throws -> String {
    if strict { try fields(value, ["kind", "content", "tags", "created_at"]) }
    let kind = try integer(value["kind"], maximum: 65535), created = try integer(value["created_at"], maximum: 9_007_199_254_740_991)
    guard let content = value["content"] as? String else { throw Failure.invalid }
    return "{\"kind\":\(kind),\"content\":\(quote(content)),\"tags\":\(try tags(value["tags"])),\"created_at\":\(created)}"
  }
  private static func eventHash(_ value: [String: Any], identity: String) throws -> String {
    let kind = try integer(value["kind"], maximum: 65535), created = try integer(value["created_at"], maximum: 9_007_199_254_740_991)
    guard let content = value["content"] as? String else { throw Failure.invalid }
    let canonical = "[0,\(quote(identity)),\(created),\(kind),\(try tags(value["tags"])),\(quote(content))]"
    return SHA256.hash(data: Data(canonical.utf8)).map { String(format: "%02x", $0) }.joined()
  }
  private static func signed(_ value: [String: Any], identity: String) throws -> String {
    try fields(value, ["id", "pubkey", "created_at", "kind", "tags", "content", "sig"])
    guard value["pubkey"] as? String == identity, let signature = value["sig"] as? String, hex(signature, 128),
      let content = value["content"] as? String else { throw Failure.invalid }
    let hash = try eventHash(value, identity: identity)
    guard value["id"] as? String == hash else { throw Failure.invalid }
    return "{\"id\":\(quote(hash)),\"pubkey\":\(quote(identity)),\"created_at\":\(try integer(value["created_at"], maximum: 9_007_199_254_740_991)),\"kind\":\(try integer(value["kind"], maximum: 65535)),\"tags\":\(try tags(value["tags"])),\"content\":\(quote(content)),\"sig\":\(quote(signature))}"
  }
  private static func hex(_ value: String, _ size: Int) -> Bool {
    value.utf8.count == size && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
  }
  private static func quote(_ value: String) -> String {
    var result = "\""
    for scalar in value.unicodeScalars {
      switch scalar.value {
      case 34: result += "\\\""
      case 92: result += "\\\\"
      case 8: result += "\\b"
      case 12: result += "\\f"
      case 10: result += "\\n"
      case 13: result += "\\r"
      case 9: result += "\\t"
      case 0...31: result += String(format: "\\u%04x", scalar.value)
      default: result.unicodeScalars.append(scalar)
      }
    }
    return result + "\""
  }
  private static func relayURL(_ raw: String) throws {
    guard raw.utf8.count <= 2048, raw.utf8.allSatisfy({ (33...126).contains($0) }), !raw.contains("\\"),
      let url = URLComponents(string: raw), url.scheme == "wss", url.user == nil, url.password == nil,
      url.query == nil, url.fragment == nil, let host = url.host, host.contains("."), !host.contains(":"),
      url.port == nil || (1...65535).contains(url.port!) else { throw Failure.invalid }
  }
}
