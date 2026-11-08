import Foundation
import CoreFoundation

/// Explicit per-pin native authority; this never grants an ordinary NAP domain.
struct LegacyReadOnlyContext {
  let metadata: String
  let eventId: String
  let htmlHash: String
  private let relays: Set<String>
  private enum Invalid: Error { case context }
  init(_ value: [String: Any], publisher: String, appId: String, version: String, fixture: String, domains: Set<String>) throws {
    guard fixture == "published", domains.isEmpty,
      Set(value.keys) == ["profile", "consent", "eventId", "htmlHash", "relays"],
      value["profile"] as? String == "legacy-read-only-v1",
      let consent = value["consent"] as? NSNumber, CFGetTypeID(consent) == CFBooleanGetTypeID(), consent.boolValue,
      publisher == "c2f1ab4e6a577dd8980b57e15986ed92830b95a94f374192235563532b5cac20",
      let event = value["eventId"] as? String, let hash = value["htmlHash"] as? String,
      let urls = value["relays"] as? [String], (1...16).contains(urls.count), Set(urls).count == urls.count,
      urls.allSatisfy(Self.relayURL) else { throw Invalid.context }
    let expected: [String]
    switch appId {
    case "recipe-cards": expected = ["b70911af4382baded327ce6af4b595197ff7a4781e3704b9f066a74f68b48a07", "92d5639e1da2a0b9ac6bbb9d41d67b0026c15ed614e2d553f8ad2e4e4e896ecc", "9067048a9ce80d7e79ea76b960acc88aa53645754ec4e7549de1c1525a690194"]
    case "longform": expected = ["5fff2ec459ffb1a2d2966fc9815bc8ba45db96a669dfe4924d6c63e65b08a24e", "3ba5049444dd249abbe671f818d555b4e3c90b7cab88a70187bc3a012f9afd67", "d5558df7e1f3823c0ad5c64273d57802fe304c1e2266bab8e5151fbf05ad51f4"]
    default: throw Invalid.context
    }
    guard [event, version, hash] == expected else { throw Invalid.context }
    eventId = event; htmlHash = hash; relays = Set(urls)
    metadata = String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
  }
  func matches(event: String, hash: String) -> Bool { event == eventId && hash == htmlHash }
  func allowsClose(_ request: [String: Any]) -> Bool {
    Set(request.keys) == ["type", "id", "subId"] && request["type"] as? String == "legacy.close" && Self.identifier(request["id"]) && Self.identifier(request["subId"])
  }
  func allowsSubscribe(_ request: [String: Any]) -> Bool {
    guard Set(request.keys) == ["type", "id", "subId", "filters", "relay"], request["type"] as? String == "legacy.subscribe",
      Self.identifier(request["id"]), Self.identifier(request["subId"]), let relay = request["relay"] as? String,
      relays.contains(relay), let filters = request["filters"] as? [[String: Any]], (1...4).contains(filters.count) else { return false }
    return filters.allSatisfy(Self.filter)
  }
  private static func identifier(_ value: Any?) -> Bool {
    guard let text = value as? String else { return false }
    return (1...128).contains(text.utf8.count) && !text.utf8.contains { $0 < 32 || $0 == 127 }
  }
  private static func integer(_ value: Any?) -> UInt64? {
    guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite,
      n.doubleValue >= 0, n.doubleValue <= 9_007_199_254_740_991, n.doubleValue.rounded(.towardZero) == n.doubleValue else { return nil }
    return n.uint64Value
  }
  private static func filter(_ value: [String: Any]) -> Bool {
    guard value.count <= 32, let limit = integer(value["limit"]), limit <= 32 else { return false }
    for (key, item) in value {
      if ["limit", "since", "until"].contains(key) { if integer(item) == nil { return false }; continue }
      guard ["ids", "authors", "kinds"].contains(key) || key.range(of: "^#[a-zA-Z]$", options: .regularExpression) != nil,
        let list = item as? [Any], (1...64).contains(list.count) else { return false }
      for entry in list {
        if key == "kinds" { guard let n = integer(entry), n <= 65535, n != 4, n != 1059 else { return false } }
        else {
          guard let text = entry as? String, text.utf8.count <= 1024 else { return false }
          if ["ids", "authors", "#e", "#p"].contains(key) && text.range(of: "^[0-9a-f]{64}$", options: .regularExpression) == nil { return false }
        }
      }
    }
    if let since = integer(value["since"]), let until = integer(value["until"]), since > until { return false }
    return true
  }
  private static func relayURL(_ value: String) -> Bool {
    guard value.utf8.count <= 2048, !value.utf8.contains(where: { $0 <= 32 || $0 >= 127 }), !value.contains("\\"),
      let url = URLComponents(string: value), url.scheme == "wss", url.user == nil, url.password == nil,
      url.query == nil, url.fragment == nil, let host = url.host, host == host.lowercased(), host.utf8.count <= 253,
      (url.port == nil || (1...65535).contains(url.port!)), url.port != 443 else { return false }
    let labels = host.split(separator: ".", omittingEmptySubsequences: false)
    guard labels.count >= 2, labels.allSatisfy({ $0.count <= 63 && $0.range(of: "^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$", options: .regularExpression) != nil }),
      labels.last!.range(of: "^[0-9]+$", options: .regularExpression) == nil,
      !["localhost", "local", "localdomain", "lan", "internal", "home", "home.arpa", "test", "example", "invalid", "onion", "arpa"].contains(where: { host == $0 || host.hasSuffix("." + $0) }) else { return false }
    let path = url.percentEncodedPath
    guard path != "/", !path.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0 == "." || $0 == ".." }),
      !path.lowercased().contains("%0d"), !path.lowercased().contains("%0a") else { return false }
    return value == "wss://" + host + (url.port.map { ":" + String($0) } ?? "") + path
  }
  /// Initial history is bounded even if a peer ignores the requested NIP-01 limit.
  struct HistoryBudget {
    private var events = 0
    private var frames = 0
    private var ended = false
    mutating func receive(_ text: String) -> Bool {
      if ended { return true }
      frames += 1
      guard frames <= 64, let frame = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [Any], let type = frame.first as? String else { return false }
      if type == "EVENT" { events += 1; if events > 32 { return false } }
      if type == "EOSE" { ended = true }
      return true
    }
  }
  /// Called again immediately before native WSS effects, after token/generation validation.
  static func permitsWire(_ snapshot: String?, url: String, wire: String, subId: String) -> Bool {
    guard let snapshot, let row = try? JSONSerialization.jsonObject(with: Data(snapshot.utf8)) as? [String: Any],
      let registration = row["registration"] as? [String: Any] else { return false }
    guard let profile = registration["legacyReadOnly"] else { return true }
    guard let value = profile as? [String: Any], let publisher = registration["publisher"] as? String,
      let app = registration["appId"] as? String, let version = registration["version"] as? String,
      let fixture = registration["fixture"] as? String, let domains = registration["domains"] as? [String], domains.isEmpty,
      let context = try? LegacyReadOnlyContext(value, publisher: publisher, appId: app, version: version, fixture: fixture, domains: Set(domains)),
      let raw = row["request"] as? String, let request = try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any],
      context.allowsSubscribe(request), request["relay"] as? String == url,
      let filters = request["filters"] as? [[String: Any]], let frame = try? JSONSerialization.jsonObject(with: Data(wire.utf8)) as? [Any],
      frame.count == filters.count + 2, frame[0] as? String == "REQ", frame[1] as? String == subId,
      let captured = try? JSONSerialization.data(withJSONObject: filters, options: .sortedKeys),
      let actual = try? JSONSerialization.data(withJSONObject: Array(frame.dropFirst(2)), options: .sortedKeys) else { return false }
    return captured == actual
  }
}
