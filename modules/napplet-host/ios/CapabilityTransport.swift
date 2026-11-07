import Foundation
import CoreFoundation

#if canImport(UIKit)
import UIKit

/// Native notifications revoke authority synchronously, before React Native lifecycle delivery.
final class CapabilityLifecycle: @unchecked Sendable {
  private var observers: [NSObjectProtocol] = []
  init() {
    let center = NotificationCenter.default
    for name in [UIApplication.willResignActiveNotification, UIApplication.didEnterBackgroundNotification] {
      observers.append(center.addObserver(forName: name, object: nil, queue: nil) { _ in CapabilityTransport.foreground(false) })
    }
    observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: nil) { _ in CapabilityTransport.foreground(true) })
    Task { @MainActor in CapabilityTransport.foreground(UIApplication.shared.applicationState == .active) }
  }
  deinit { for observer in observers { NotificationCenter.default.removeObserver(observer) } }
}

#endif

/// React Native owns this immutable configuration. Requests cannot supply namespace fields.
struct CapabilityConfiguration {
  let snapshot: String
  let user: String
  let epoch: UInt64
  let sessionId: String
  let fixture: String
  let domains: Set<String>
  let publishedOpen: Bool
  let publisher: String
  let appId: String
  let version: String
  init(_ raw: String, generation: String) throws {
    enum Invalid: Error { case configuration }
    guard raw.utf8.count <= 8192, let bytes = raw.data(using: .utf8),
      var value = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
      Set(value.keys).subtracting(["publishedOpen"]) == Set(["sessionId", "epoch", "user", "publisher", "appId", "version", "instanceId", "fixture", "domains"])
      else { throw Invalid.configuration }
    let open = value.removeValue(forKey: "publishedOpen")
    if let open {
      guard let flag = open as? NSNumber, CFGetTypeID(flag) == CFBooleanGetTypeID(), flag.boolValue,
        value["fixture"] as? String == "published" else { throw Invalid.configuration }
    }
    for name in ["sessionId", "instanceId", "fixture"] {
      guard let text = value[name] as? String, text.range(of: "^[A-Za-z0-9_-]{1,80}$", options: .regularExpression) != nil else { throw Invalid.configuration }
    }
    for name in ["user", "publisher", "version"] {
      guard let text = value[name] as? String, text.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else { throw Invalid.configuration }
    }
    guard let publisher = value["publisher"] as? String,
      let version = value["version"] as? String,
      let appId = value["appId"] as? String, (1...1024).contains(appId.utf8.count),
      let epoch = value["epoch"] as? NSNumber, CFGetTypeID(epoch) != CFBooleanGetTypeID(),
      epoch.doubleValue.isFinite, epoch.doubleValue >= 0, epoch.doubleValue <= 9_007_199_254_740_991,
      epoch.doubleValue.rounded(.towardZero) == epoch.doubleValue,
      let domains = value["domains"] as? [String], domains.count == Set(domains).count,
      let fixture = value["fixture"] as? String, let sessionId = value["sessionId"] as? String else { throw Invalid.configuration }
    let expected: Set<String>
    switch fixture {
    case "ux-lab", "close-lab": expected = ["theme"]
    case "napplet-discovery": expected = ["relay", "resource", "theme"]
    case "state-lab", "state-lab-peer": expected = ["identity", "storage", "theme"]
    case "approval-lab", "approval-lab-v1", "approval-lab-v2", "approval-lab-v3": expected = ["identity", "relay", "theme"]
    case "upload-lab", "upload-queue-lab": expected = ["upload", "theme"]
    case "resource-lab": expected = ["resource", "link", "theme"]
    case "nap-support": expected = ["link", "theme"]
    case "routing-lab", "routing-lab-peer": expected = ["intent", "inc", "notify", "config", "theme"]
    case "feed-lab-v1": expected = ["identity", "outbox", "relay", "theme"]
    case "feed-lab": expected = Set(domains).contains("outbox") ? ["identity", "outbox", "relay", "theme"] : ["identity", "relay", "theme"]
    case "published":
      expected = Set(domains)
      let supported: Set<String> = ["identity", "storage", "theme", "relay", "resource", "upload", "link", "intent", "inc", "notify", "config", "outbox", "keys", "media"]
      guard domains.count <= supported.count, expected.isSubset(of: supported) else {
        throw Invalid.configuration
      }
    default: throw Invalid.configuration
    }
    if fixture != "published" && Set(domains) != expected { throw Invalid.configuration }
    value["generation"] = generation
    self.snapshot = String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
    self.user = value["user"] as! String
    self.epoch = epoch.uint64Value
    self.sessionId = sessionId
    self.fixture = fixture
    self.domains = expected
    self.publishedOpen = (fixture == "napplet-discovery" && appId == "napplet-discovery") || open != nil
    self.publisher = publisher
    self.appId = appId
    self.version = version
  }

  func matchesPublishedClaims(sessionId claimSession: String, publisher claimPublisher: String,
                              appId claimAppId: String, version claimVersion: String) -> Bool {
    fixture == "published" && sessionId == claimSession && publisher == claimPublisher
      && appId == claimAppId && version == claimVersion
  }
  func request(_ message: String) throws -> String {
    let value = ["registration": try JSONSerialization.jsonObject(with: Data(snapshot.utf8)), "request": message] as [String: Any]
    return String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
  }
  func allowsRelayOperation(_ type: String) -> Bool {
    switch type {
    case "relay.subscribe", "relay.publish": domains.contains("relay")
    case "outbox.subscribe", "outbox.publish": domains.contains("outbox")
    default: false
    }
  }
  /// Recognition is deliberately narrow. Event validation and signing remain outside this transport.
  func approvalWireId(_ message: String) -> (recognized: Bool, wireId: String?) {
    guard let data = message.data(using: .utf8),
      let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let type = value["type"] as? String,
      type == "relay.publish" || type == "outbox.publish" else { return (false, nil) }
    guard allowsRelayOperation(type), let id = value["id"] as? String, (1...128).contains(id.utf8.count) else { return (true, nil) }
    return (true, id)
  }
}

/// Lease queries are synchronous across threads; WebKit reply closures remain main-actor isolated.
@MainActor
enum CapabilityTransport {
  nonisolated static let leases = CapabilityLeaseRegistry()
  nonisolated static func outboxAdmitted(_ token: String, leases: CapabilityLeaseRegistry) -> Bool {
    guard let snapshot = leases.borrowedSnapshot(token),
      let row = try? JSONSerialization.jsonObject(with: Data(snapshot.utf8)) as? [String: Any],
      let registration = row["registration"] as? [String: Any],
      let domains = registration["domains"] as? [String], domains.contains("outbox"),
      let raw = row["request"] as? String,
      let request = try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any],
      let type = request["type"] as? String, ["outbox.query", "outbox.getEvent"].contains(type)
    else { return false }
    return leases.isActive(token)
  }

  // UIKit lifecycle and app-owned services are exercised by native app tests.
  #if canImport(UIKit)
  nonisolated static let lifecycle = CapabilityLifecycle()
  nonisolated static func foreground(_ value: Bool) {
    RoutingTransport.shared.foreground(value)
    LinkTransport.foreground(value)
    UploadTransport.foreground(value)
    let revoked = leases.setForeground(value)
    Task { @MainActor in
      for token in revoked { pending.removeValue(forKey: token)?.reply(nil) }
    }
  }
  private struct Pending {
    let generation: String
    let access: IdentityListAccess.Ticket?
    let reply: @MainActor @Sendable (String?) -> Void
    var dispatch: (@MainActor @Sendable (String) -> Void)? = nil
  }
  private static var pending: [String: Pending] = [:]
  static func enqueue(_ generation: String, sequence: UInt64, snapshot: String,
                      reply: @escaping @MainActor @Sendable (String?) -> Void,
                      dispatch: @escaping @MainActor @Sendable (String) -> Void) {
    guard let token = leases.enqueue(generation, sequence: sequence, snapshot: snapshot) else { reply(nil); return }
    remember(token, Pending(generation: generation, access: nil, reply: reply, dispatch: dispatch), lifetime: 25)
    drain()
  }
  private static func drain() {
    for token in leases.promote() {
      guard let dispatch = pending[token]?.dispatch else { continue }
      pending[token]?.dispatch = nil
      if leases.retained(token) { dispatch(token) }
    }
  }
  static func admit(_ generation: String, sequence: UInt64, snapshot: String, publishedOpen: Bool = false,
                    reply: @escaping @MainActor @Sendable (String?) -> Void) -> String? {
    guard let token = leases.admit(generation, sequence: sequence, snapshot: snapshot, publishedOpen: publishedOpen) else { return nil }
    let access: IdentityListAccess.Ticket?
    do {access = try IdentityListAccess.shared.captureJSON(snapshot)} catch {_ = leases.finish(token); drain(); return nil}
    remember(token, Pending(generation: generation, access: access, reply: reply), lifetime: publishedOpen ? 120 : 25)
    return token
  }
  private static func remember(_ token: String, _ request: Pending, lifetime: Double) {
    pending[token] = request
    DispatchQueue.main.asyncAfter(deadline: .now() + lifetime) {
      // ContinuousClock in the registry, not this cleanup timer, controls expiry during sleep.
      if !leases.retained(token) { pending.removeValue(forKey: token)?.reply(nil) }
      drain()
    }
  }
  nonisolated static func finish(_ token: String, response: String?) {
    let bounded = response.flatMap { $0.utf8.count <= CapabilityLeaseRegistry.maxBytes ? $0 : nil }
    Task { @MainActor in
      let admitted = leases.finish(token)
      if let request = pending.removeValue(forKey: token) {
        request.reply(admitted && leases.sessionActive(request.generation) && IdentityListAccess.shared.permits(request.access) ? bounded : nil)
      }
      drain()
    }
  }
  static func revoke(_ generation: String) {
    RoutingTransport.shared.revoke(generation)
    leases.revoke(generation)
    ResourceHTTPSBridgeOwner.shared.revoke(generation)
    RelaySubscriptionTransport.shared.revoke(generation)
    for token in pending.filter({ $0.value.generation == generation }).keys {
      pending.removeValue(forKey: token)?.reply(nil)
    }
    drain()
  }
  #endif
}
