import Foundation

/// Native recipient and bounded renderer queue. WebKit's one-use admission reply is never reused.
final class RelaySubscriptionTransportRegistry: @unchecked Sendable {
  typealias Push = @MainActor @Sendable (String) -> Void
  private struct Row {
    let generation: String
    let sequence: UInt64
    let subId: String
    let push: Push
    let outbox: Bool
    var delivery: UInt64 = 0
    var acknowledged: UInt64 = 0
    var sizes: [UInt64: Int] = [:]
    var payloads: [UInt64: String] = [:]
    var pushed: Set<UInt64> = []
    var terminal = false
  }
  let registry: RelaySubscriptionRegistry
  private let lock = NSRecursiveLock()
  private var rows: [String: Row] = [:]
  private var active = false
  private var revision: UInt64 = 0
  private var lifecycleSink: (@Sendable (String) -> Void)?
  func observeLifecycle(_ sink: (@Sendable (String) -> Void)?) { lock.withLock { lifecycleSink = sink } }
  func lifecycle() -> String {
    lock.withLock {
      let value: [String: Any] = ["active": active, "revision": revision]
      guard let bytes = try? JSONSerialization.data(withJSONObject: value) else { return "" }; return String(decoding: bytes, as: UTF8.self)
    }
  }
  init(leases: CapabilityLeaseRegistry) {
    registry = RelaySubscriptionRegistry(generationActive: { leases.sessionActive($0) })
  }
  func admit(_ generation: String, sequence: UInt64, snapshot: String, subId: String, outbox: Bool = false, push: @escaping Push) -> String? {
    lock.withLock {
      guard let token = registry.admit(generation, snapshot: snapshot, outbox: outbox) else { return nil }
      rows[token] = Row(generation: generation, sequence: sequence, subId: subId, push: push, outbox: outbox)
      DispatchQueue.main.asyncAfter(deadline: .now() + 25) { [weak self] in
        guard let self else { return }
        self.lock.withLock { if !self.registry.isActive(token) { self.close(token) } }
      }
      return token
    }
  }
  func hasCapacity(_ token: String) -> Bool {
    lock.withLock { registry.mayDeliver(token) && (rows[token]?.sizes.count ?? 4) < 4 }
  }
  func send(_ token: String, response: String) -> Int {
    lock.withLock {
      if registry.isActive(token), !registry.mayDeliver(token) { return 0 }
      guard var row = rows[token], registry.mayDeliver(token), !row.terminal,
        response.utf8.count <= 66 * 1024, row.sizes.count < 4,
        row.sizes.values.reduce(0, +) + response.utf8.count <= 256 * 1024,
        let message = try? JSONSerialization.jsonObject(with: Data(response.utf8)) as? [String: Any],
        message["subId"] as? String == row.subId,
        let type = message["type"] as? String, (row.outbox ? ["outbox.event", "relay.eose", "outbox.closed"] : ["relay.event", "relay.eose", "relay.closed"]).contains(type),
        row.delivery < 9_007_199_254_740_991 else { close(token); return -1 }
      row.delivery += 1
      let delivery = row.delivery
      row.sizes[delivery] = response.utf8.count
      row.terminal = type == (row.outbox ? "outbox.closed" : "relay.closed")
      rows[token] = row
      let value: [String: Any] = ["type": "capability.stream", "sessionId": row.generation,
        "sequence": row.sequence, "delivery": delivery, "response": response]
      guard let bytes = try? JSONSerialization.data(withJSONObject: value) else { close(token); return -1 }
      let envelope = String(decoding: bytes, as: UTF8.self)
      rows[token]?.payloads[delivery] = envelope
      dispatch(token, delivery: delivery)
      DispatchQueue.main.asyncAfter(deadline: .now() + 25) { [weak self] in
        guard let self else { return }
        self.lock.withLock { if self.registry.mayDeliver(token), self.rows[token]?.sizes[delivery] != nil { self.close(token) } }
      }
      return 1
    }
  }
  func acknowledge(_ generation: String, streamSequence: UInt64, delivery: UInt64) {
    lock.withLock {
      guard let entry = rows.first(where: { $0.value.generation == generation && $0.value.sequence == streamSequence }) else { return }
      var row = entry.value
      guard registry.isActive(entry.key), delivery == row.acknowledged + 1,
        row.sizes.removeValue(forKey: delivery) != nil else { close(entry.key); return }
      row.acknowledged = delivery; row.payloads.removeValue(forKey: delivery); row.pushed.remove(delivery)
      rows[entry.key] = row
      if row.terminal && row.sizes.isEmpty { close(entry.key) }
    }
    RelayStreamBridgeOwner.shared.rendererAvailable(lock.withLock { rows.first(where: { $0.value.generation == generation && $0.value.sequence == streamSequence })?.key ?? "" })
  }
  func close(_ token: String) {
    lock.withLock { registry.close(token); _ = rows.removeValue(forKey: token) }
    RelayStreamBridgeOwner.shared.cancelToken(token)
  }
  func revoke(_ generation: String) {
    let tokens = lock.withLock { rows.filter { $0.value.generation == generation }.map(\.key) }
    for token in tokens { close(token) }; registry.revoke(generation)
  }
  private func dispatch(_ token: String, delivery: UInt64) {
    Task { @MainActor [weak self] in
      guard let self else { return }
      self.lock.withLock {
        guard var row = self.rows[token], self.registry.mayDeliver(token), row.sizes[delivery] != nil,
          !row.pushed.contains(delivery), let envelope = row.payloads[delivery] else { return }
        row.pushed.insert(delivery); self.rows[token] = row; row.push(envelope)
      }
    }
  }
  func foreground(_ active: Bool) {
    lock.withLock {
      guard self.active != active else { return }
      self.active = active; revision += 1
      registry.setForeground(active)
      for (token, row) in rows {
        let value: [String: Any] = ["type": "capability.stream-control", "sessionId": row.generation,
          "sequence": row.sequence, "active": active, "revision": revision]
        guard let bytes = try? JSONSerialization.data(withJSONObject: value) else { continue }
        let control = String(decoding: bytes, as: UTF8.self)
        Task { @MainActor [weak self] in
          guard let self else { return }
          self.lock.withLock { guard let current = self.rows[token], self.registry.isActive(token) else { return }; current.push(control) }
        }
        if active { for delivery in row.payloads.keys.sorted() { dispatch(token, delivery: delivery) } }
      }
      lifecycleSink?(lifecycle())
    }
  }
  func revokeAll() { lock.withLock { registry.revokeAll(); rows.removeAll() }; RelayStreamBridgeOwner.shared.revokeAll() }
}
enum RelaySubscriptionTransport {
  static let shared = RelaySubscriptionTransportRegistry(leases: CapabilityTransport.leases)
}
