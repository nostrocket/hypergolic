import Foundation

/// Native routing ownership and captured WebKit recipients; no guest can select a generation.
final class RoutingTransportRegistry: @unchecked Sendable {
  static let publishedOpen = "hypergolic.publishedOpen"
  typealias Push = @MainActor @Sendable (String) -> Void
  private struct Row {
    let config: CapabilityConfiguration
    var push: Push?
    var delivery: UInt64 = 0
    var credits = RoutingPushCredits()
  }
  private let endpoints = RoutingEndpointRegistry()
  private let lock = NSRecursiveLock()
  private var rows: [String: Row] = [:]
  private var sink: (@Sendable (String) -> Void)?
  func observeLifecycle(_ value: (@Sendable (String) -> Void)?) { lock.withLock { sink = value } }
  func state() -> String { lock.withLock {
    let state = endpoints.state()
    let value: [String: Any] = ["user": state.user, "epoch": state.epoch as Any? ?? NSNull(), "revision": state.revision, "available": state.available, "ownerAvailable": state.ownerAvailable, "foreground": state.foreground]
    guard let data = try? JSONSerialization.data(withJSONObject: value) else { return "" }
    return String(decoding: data, as: UTF8.self)
  } }
  func synchronizeOwner(_ user: String, epoch: UInt64, available: Bool) -> Bool { lock.withLock {
    let before = endpoints.state()
    guard endpoints.synchronizeOwner(user, epoch: epoch, available: available) else { return false }
    if before.revision != endpoints.state().revision {
      if before.user != user || before.epoch != epoch {
        for generation in Array(rows.keys) { rows[generation]?.credits.clear() }
      } else { resumeIntents() }
      sink?(state())
    }
    return true
  } }
  func foreground(_ value: Bool) { lock.withLock {
    let before = endpoints.state().revision; endpoints.setForeground(value)
    if before != endpoints.state().revision { resumeIntents(); sink?(state()) }
  } }
  private func resumeIntents() {
    let available = endpoints.state().available
    for generation in Array(rows.keys) {
      guard let row = rows[generation] else { continue }
      rows[generation]?.credits.pause()
      if available { for delivery in row.credits.parkedIds() { scheduleIntent(generation, delivery: delivery) } }
    }
  }
  private func scheduleIntent(_ generation: String, delivery: UInt64) {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.lock.withLock {
        guard self.mayDeliver(generation, revision: self.endpoints.state().revision, domain: "intent"),
          let push = self.rows[generation]?.push,
          let envelope = self.rows[generation]?.credits.takeParked(delivery) else { return }
        push(envelope)
      }
    }
  }
  func register(_ generation: String, config: CapabilityConfiguration) -> Bool { lock.withLock {
    let trackPublished = config.fixture == "published"
    guard trackPublished || config.publishedOpen || config.domains.contains("intent") || config.domains.contains("inc") ||
      config.domains.contains("notify") || config.domains.contains("config") else { return true }
    guard endpoints.register(generation, user: config.user, epoch: config.epoch, intent: config.domains.contains("intent"),
      inc: config.domains.contains("inc"), notify: config.domains.contains("notify"), config: config.domains.contains("config"),
      publishedOpen: config.publishedOpen, trackPublished: trackPublished) else { return false }
    rows[generation] = Row(config: config); return true
  } }
  func ready(_ generation: String) { lock.withLock { endpoints.ready(generation) } }
  func focus(_ generation: String, _ value: Bool) { lock.withLock { if endpoints.focus(generation, value) { sink?(state()) } } }
  func revoke(_ generation: String) { lock.withLock { endpoints.revoke(generation); _ = rows.removeValue(forKey: generation) } }
  func mayReview(_ generation: String, revision: UInt64) -> Bool { lock.withLock { endpoints.matchesRevision(revision) && endpoints.mayReview(generation) && CapabilityTransport.leases.sessionActive(generation) } }
  func reviewRevision(_ generation: String, revision: UInt64) -> Int64 { lock.withLock { endpoints.matchesRevision(revision) ? endpoints.reviewRevision(generation) : -1 } }
  func mayDeliver(_ generation: String, revision: UInt64, domain: String) -> Bool { lock.withLock {
    endpoints.matchesRevision(revision) && endpoints.mayDeliver(generation, domain: domain) && CapabilityTransport.leases.sessionActive(generation)
  } }
  @MainActor func receive(_ generation: String, sequence: UInt64, raw: String, push: @escaping Push,
      reply: @escaping @MainActor @Sendable (String?) -> Void) -> String? {
    lock.lock(); defer { lock.unlock() }
    let revision = endpoints.state().revision
    guard var wrapper = try? UploadWire.object(raw, limit: 36 * 1024, maximumDepth: 40), let row = rows[generation],
      Set(wrapper.keys) == ["type", "id", "message"], wrapper["type"] as? String == "routing.call",
      let id = wrapper["id"] as? String, id.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil,
      let message = wrapper["message"] as? [String: Any], let type = message["type"] as? String,
      let domain = type == Self.publishedOpen ? "published-open" : type == "notify.__register" ? "notify" : type == "routing.__register" ? row.config.domains.sorted().first(where: {$0 == "intent" || $0 == "inc"}) : type.split(separator: ".").first.map(String.init),
      domain != "published-open" || type == Self.publishedOpen,
      mayDeliver(generation, revision: revision, domain: domain),
      type != Self.publishedOpen || (mayReview(generation, revision: revision) && Set(message.keys) == ["type", "id", "address", "expectedEventId"]),
      (type != "routing.__register" && type != "notify.__register") || Set(message.keys) == ["type"] else {
      _ = CapabilityTransport.leases.consumeSequence(generation, sequence: sequence); reply(nil); return nil
    }
    rows[generation]?.push = push; wrapper["revision"] = revision
    if type == Self.publishedOpen { wrapper["focusRevision"] = reviewRevision(generation, revision: revision) }
    guard let bytes = try? JSONSerialization.data(withJSONObject: wrapper), let snapshot = try? row.config.request(String(decoding: bytes, as: UTF8.self)),
      let token = CapabilityTransport.admit(generation, sequence: sequence, snapshot: snapshot, publishedOpen: type == Self.publishedOpen, reply: { [weak self] response in
        reply(self?.mayDeliver(generation, revision: revision, domain: domain) == true ? response : nil)
      }) else { reply(nil); return nil }
    return token
  }
  func send(_ generation: String, revision: UInt64, raw: String) -> Bool { lock.withLock {
    guard var row = rows[generation], let message = try? UploadWire.object(raw, limit: 36 * 1024, maximumDepth: 40),
      let type = message["type"] as? String, ["intent.changed", "intent.deliver", "inc.event", "inc.channel.opened", "inc.channel.event", "inc.channel.closed", "notify.action", "notify.clicked", "notify.dismissed", "notify.controls", "config.values", "config.schemaError"].contains(type),
      let domain = type.split(separator: ".").first.map(String.init), mayDeliver(generation, revision: revision, domain: domain),
      row.push != nil, row.delivery < 9_007_199_254_740_991 else { return false }
    let delivery = row.delivery + 1, retained = type == "intent.deliver"
    let value: [String: Any] = ["type": "routing.event", "sessionId": generation, "delivery": delivery, "response": raw]
    guard let bytes = try? JSONSerialization.data(withJSONObject: value) else { return false }
    let envelope = String(decoding: bytes, as: UTF8.self)
    guard row.credits.reserve(delivery, envelope: retained ? envelope : nil) else { return false }
    row.delivery = delivery
    rows[generation] = row
    if retained {
      scheduleIntent(generation, delivery: delivery)
      return true
    }
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.lock.withLock {
        guard let current = self.rows[generation], current.credits.contains(delivery), self.mayDeliver(generation, revision: revision, domain: domain) else { self.rows[generation]?.credits.release(delivery); return }
        current.push?(envelope)
      }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 25) { [weak self] in self?.lock.withLock { self?.rows[generation]?.credits.expire(delivery) } }
    return true
  } }
  func acknowledge(_ generation: String, delivery: UInt64) { lock.withLock {
    guard var row = rows[generation] else { return }
    row.credits.acknowledge(delivery)
    rows[generation] = row
  } }

}
enum RoutingTransport { static let shared = RoutingTransportRegistry() }
