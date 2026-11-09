import Foundation
import CoreFoundation

/// Public trusted-context metadata only. Record JSON remains opaque to native policy parsing.
enum NativeAppDataPolicy {
  enum Failure: Error { case invalid }
  static func claims(_ request: [String: Any]) -> Bool {
    guard let event = request["event"] as? [String: Any], event.keys.contains("tags") else { return false }
    guard let tags = event["tags"] as? [Any] else { return true }
    if tags.count > 8192 { return true }
    return tags.contains { item in
      guard let row = item as? [Any], !row.isEmpty else { return true }
      let name = row[0] as? String, value = row.count > 1 ? row[1] as? String : nil
      return name == "d" && (value == "soy.app-data/1" || value?.hasPrefix("soy.app-data/1:") == true) ||
        ["L", "l"].contains(name ?? "") && row.contains { $0 as? String == "soy.app-data/1" }
    }
  }
  static func rawRelay(_ registration: [String: Any], _ request: [String: Any]) -> Bool {
    guard request["type"] as? String == "relay.publish", claims(request),
      let domains = registration["domains"] as? [String], domains.contains("relay") else { return false }
    do { try validatePublication(registration, request, destinations: []); return true } catch { return false }
  }
  /// Exact native source policy and the original Relay grant remain independent of Outbox.
  static func validatePublication(_ registration: [String: Any], _ request: [String: Any], destinations: [String]) throws {
    guard let publisher = registration["publisher"] as? String, let appId = registration["appId"] as? String,
      let fixture = registration["fixture"] as? String, let domains = registration["domains"] as? [String],
      let context = registration["appData"], let event = request["event"] as? [String: Any],
      let kind = event["kind"] as? NSNumber, CFGetTypeID(kind) != CFBooleanGetTypeID(), kind.doubleValue == 30078,
      let content = event["content"] as? String, content.utf8.count <= 3072,
      let tags = event["tags"] as? [[String]] else { throw Failure.invalid }
    let captured = try capture(context, publisher: publisher, appId: appId, fixture: fixture, domains: Set(domains))
    guard let object = try JSONSerialization.jsonObject(with: Data(captured.utf8)) as? [String: Any],
      let policy = object["policy"] as? [String: Any], let scope = policy["scope"] as? String,
      let peers = policy["relays"] as? [String] else { throw Failure.invalid }
    let identifiers = tags.filter { $0.first == "d" }
    guard identifiers.count == 1, identifiers[0].count == 2, identifiers[0][1].hasPrefix("soy.app-data/1:\(scope):"),
      destinations.count <= 8, destinations.allSatisfy({ destination in
        let normalized = URLComponents(string: destination)?.path == "/" ? String(destination.dropLast()) : destination
        return peers.contains(normalized)
      }) else { throw Failure.invalid }
  }
  static func capture(_ value: Any, publisher: String, appId: String, fixture: String, domains: Set<String>) throws -> String {
    guard fixture == "published", domains.contains("identity"), !domains.isDisjoint(with: ["outbox", "relay"]),
      let context = value as? [String: Any], Set(context.keys) == ["sourceKind", "policy"],
      let kind = context["sourceKind"] as? NSNumber, CFGetTypeID(kind) != CFBooleanGetTypeID(), kind.doubleValue == 35129,
      let policy = context["policy"] as? [String: Any], Set(policy.keys) == ["profile", "scope", "maxContentBytes", "relays", "defaultRelays"],
      policy["profile"] as? String == "soy.app-data/1",
      policy["scope"] as? String == NativeCanonicalJSON.hashStrings(["soy.app-data/1", "\(publisher):35129:\(appId)"]),
      let maximum = policy["maxContentBytes"] as? NSNumber, CFGetTypeID(maximum) != CFBooleanGetTypeID(), maximum.doubleValue == 3072,
      let relays = policy["relays"] as? [String], (1...8).contains(relays.count), Set(relays).count == relays.count,
      let defaults = policy["defaultRelays"] as? [String], defaults == [relays[0]] else { throw Failure.invalid }
    for peer in relays {
      guard (1...256).contains(peer.utf8.count), peer.utf8.allSatisfy({ (33...126).contains($0) }), !peer.contains("\\"),
        let url = URLComponents(string: peer), url.scheme == "wss", let host = url.host, host.contains("."),
        url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
        url.port == nil || (1...65535).contains(url.port!) else { throw Failure.invalid }
    }
    let bytes = try JSONSerialization.data(withJSONObject: context, options: [.sortedKeys, .withoutEscapingSlashes])
    guard bytes.count <= 3072 else { throw Failure.invalid }
    return String(decoding: bytes, as: UTF8.self)
  }
}
