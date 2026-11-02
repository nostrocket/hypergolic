import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// Synchronous native owner for the long approval lane. Private authority handles
/// never cross Expo; JavaScript sees only a random lookup token.
final class ApprovalTransportRegistry: @unchecked Sendable {
  typealias Reply = @MainActor @Sendable (String?) -> Void
  typealias Scheduler = @Sendable (Int, @escaping @Sendable () -> Void) -> Void

  private struct Row {
    let generation: String
    let session: NativeApprovalSessionHandle
    let request: NativeApprovalRequestHandle
    let snapshot: String
    let wireId: String?
    let reply: Reply
    var claimed = false
    var outboxPlan: NativeOutboxPlan?
    var approval: NativeApprovalHandle?
    var signingSnapshot: String?
    var nativeSigningClaimed = false
    var nativeHandoffPending = false
  }
  private struct Delivery: Sendable {
    let reply: Reply
    let response: String?
  }

  private let lock = NSLock()
  private let leases: CapabilityLeaseRegistry
  private let authority: NativeApprovalAuthority
  private let token: @Sendable () -> String
  private let schedule: Scheduler
  private var sessions: [String: NativeApprovalSessionHandle] = [:]
  private var rows: [String: Row] = [:]

  init(leases: CapabilityLeaseRegistry, authority: NativeApprovalAuthority = NativeApprovalAuthority(),
       token: @escaping @Sendable () -> String = { UUID().uuidString.lowercased() },
       schedule: @escaping Scheduler = { seconds, work in
         DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(seconds), execute: work)
       }) {
    self.leases = leases
    self.authority = authority
    self.token = token
    self.schedule = schedule
  }

  func register(_ generation: String) -> Bool {
    var deliveries: [Delivery] = []
    let registered = lock.withLock {
      deliveries = sweepLocked()
      guard sessions[generation] == nil, leases.sessionActive(generation),
        let session = authority.register(generation: generation) else { return false }
      sessions[generation] = session
      return true
    }
    dispatch(deliveries)
    return registered
  }

  func admit(_ generation: String, snapshot: String, wireId: String?, reply: @escaping Reply) -> String? {
    var deliveries: [Delivery] = []
    let admitted: String? = lock.withLock {
      deliveries = sweepLocked()
      guard snapshot.utf8.count <= CapabilityLeaseRegistry.maxBytes,
        let session = sessions[generation], leases.sessionActive(generation),
        let request = authority.admit(session, snapshot: snapshot) else { return nil }
      var candidate = token()
      var attempts = 0
      while rows[candidate] != nil && attempts < 4 { candidate = token(); attempts += 1 }
      guard rows[candidate] == nil,
        candidate.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
          options: .regularExpression) != nil else {
        _ = authority.cancel(request)
        return nil
      }
      rows[candidate] = Row(generation: generation, session: session, request: request,
        snapshot: snapshot, wireId: wireId, reply: reply)
      schedule(600) { [weak self] in self?.sweep() }
      return candidate
    }
    dispatch(deliveries)
    return admitted
  }

  func take(_ token: String) -> String? {
    var deliveries: [Delivery] = []
    let result: String? = lock.withLock {
      deliveries = sweepLocked()
      guard var row = rows[token], !row.claimed, sessionLiveLocked(row),
        authority.contains(row.request) else { return nil }
      row.claimed = true
      rows[token] = row
      return row.snapshot
    }
    dispatch(deliveries)
    return result
  }

  func isLive(_ token: String) -> Bool {
    var deliveries: [Delivery] = []
    let result = lock.withLock {
      deliveries = sweepLocked()
      guard let row = rows[token] else { return false }
      return !row.nativeHandoffPending && row.claimed && sessionLiveLocked(row) && authority.contains(row.request)
    }
    dispatch(deliveries)
    return result
  }

  func mayReview(_ token: String) -> Bool {
    var deliveries: [Delivery] = []
    let result = lock.withLock {
      deliveries = sweepLocked()
      guard let row = rows[token], row.claimed, !row.nativeHandoffPending, sessionLiveLocked(row),
        !isOutbox(row) || row.outboxPlan != nil, let review = authority.currentReview() else { return false }
      return review.request == row.request && review.snapshot.utf8.elementsEqual(row.snapshot.utf8)
    }
    dispatch(deliveries)
    return result
  }

  func approve(_ token: String) -> Bool {
    var deliveries: [Delivery] = []
    let result = lock.withLock {
      deliveries = sweepLocked()
      guard var row = rows[token], row.claimed, row.approval == nil, !row.nativeHandoffPending, sessionLiveLocked(row),
        !isOutbox(row) || row.outboxPlan != nil, let review = authority.currentReview(), review.request == row.request,
        review.snapshot.utf8.elementsEqual(row.snapshot.utf8), let approval = authority.approve(row.request) else { return false }
      guard authority.take(approval) == row.snapshot else {
        _ = authority.cancel(approval)
        rows.removeValue(forKey: token)
        if sessionLiveLocked(row) { deliveries.append(denial(row)) }
        return false
      }
      row.approval = approval
      rows[token] = row
      return true
    }
    dispatch(deliveries)
    return result
  }


  func prepareSigning(_ token: String, raw: String) -> Bool {
    lock.withLock {
      guard var row = rows[token], row.claimed, signingEligibleLocked(row),
        let captured = try? NativeOutboxPlan.signingSnapshot(snapshot: row.snapshot, raw: raw),
        row.outboxPlan == nil || row.outboxPlan?.destinations == captured.destinations else { return false }
      if let existing = row.signingSnapshot { return existing.utf8.elementsEqual(captured.json.utf8) }
      guard !row.nativeSigningClaimed else { return false }
      row.signingSnapshot = captured.json; rows[token] = row; return true
    }
  }
  func signingSnapshot(_ token: String) -> String? {
    lock.withLock {
      guard let row = rows[token], row.claimed, !row.nativeSigningClaimed,
        signingEligibleLocked(row) else { return nil }
      return row.signingSnapshot
    }
  }
  func claimNativeSigning(_ token: String, expected: String) -> Bool {
    lock.withLock {
      guard var row = rows[token], row.claimed, !row.nativeSigningClaimed,
        row.signingSnapshot.map({ $0.utf8.elementsEqual(expected.utf8) }) == true, signingEligibleLocked(row) else { return false }
      row.nativeSigningClaimed = true; rows[token] = row; return true
    }
  }
  private func signingEligibleLocked(_ row: Row) -> Bool {
    guard sessionLiveLocked(row), authority.contains(row.request), !isOutbox(row) || row.outboxPlan != nil else { return false }
    if let approval = row.approval { return authority.isApproved(approval) }
    guard let review = authority.currentReview() else { return false }
    return review.request == row.request && review.snapshot.utf8.elementsEqual(row.snapshot.utf8)
  }
  func isSigningLive(_ token: String) -> Bool {
    lock.withLock {
      guard let row = rows[token], row.claimed else { return false }
      if row.nativeSigningClaimed { return sessionLiveLocked(row) && authority.signingLifetime(row.request) }
      return signingEligibleLocked(row)
    }
  }
  func pauseNativeSigning(_ token: String, paused: Bool) -> Bool {
    lock.withLock {
      guard var row = rows[token], row.nativeSigningClaimed, row.nativeHandoffPending != paused,
        sessionLiveLocked(row), authority.pauseExecution(row.request, paused: paused) else { return false }
      row.nativeHandoffPending = paused; rows[token] = row; return true
    }
  }
  func prepareOutbox(_ token: String, raw: String) -> Bool {
    lock.withLock {
      guard var row = rows[token], row.claimed, row.approval == nil, row.outboxPlan == nil,
        sessionLiveLocked(row), authority.contains(row.request), isOutbox(row),
        let plan = try? NativeOutboxPlan.capture(snapshot: row.snapshot, raw: raw) else { return false }
      row.outboxPlan = plan; rows[token] = row; return true
    }
  }
  func reserveOutbox(_ token: String, group: String, wire: String, relay: String) throws -> NativeOutboxPlan.Send {
    try lock.withLock {
      guard let row = rows[token], !row.nativeHandoffPending, sessionLiveLocked(row), let approval = row.approval,
        authority.isApproved(approval), let plan = row.outboxPlan else { throw NativeOutboxPlan.Failure.revoked }
      return try plan.reserve(group: group, wire: wire, relay: relay)
    }
  }
  /// Native revocation and exact EVENT enqueue share this lock.
  func sendOutbox(_ token: String, operation: NativeOutboxPlan.Send, send: () -> Void) throws {
    try lock.withLock {
      guard let row = rows[token], !row.nativeHandoffPending, sessionLiveLocked(row), let approval = row.approval,
        authority.isApproved(approval), row.outboxPlan?.owns(operation) == true, !operation.wasAttempted,
        ContinuousClock.now < operation.deadline else { throw NativeOutboxPlan.Failure.revoked }
      operation.markAttempted(); send()
    }
  }
  func failOutbox(_ token: String, error: String) {
    let deliveries: [Delivery] = lock.withLock {
      guard let row = rows[token], isOutbox(row) else { return [] }
      rows.removeValue(forKey: token)
      if let approval = row.approval { _ = authority.cancel(approval) } else { _ = authority.cancel(row.request) }
      guard sessionLiveLocked(row) else { return [] }
      return [denial(row, error: error.utf8.count <= 4096 && !error.isEmpty ? error : "approval denied")]
    }
    dispatch(deliveries)
  }
  private func isOutbox(_ row: Row) -> Bool {
    guard let envelope = try? JSONSerialization.jsonObject(with: Data(row.snapshot.utf8)) as? [String: Any],
      let raw = envelope["request"] as? String,
      let request = try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any] else { return false }
    return request["type"] as? String == "outbox.publish"
  }
  func isApproved(_ token: String) -> Bool {
    var deliveries: [Delivery] = []
    let result = lock.withLock {
      deliveries = sweepLocked()
      guard let row = rows[token], row.claimed, !row.nativeHandoffPending, sessionLiveLocked(row),
        let approval = row.approval else { return false }
      return authority.isApproved(approval)
    }
    dispatch(deliveries)
    return result
  }

  func cancel(_ token: String) {
    var deliveries: [Delivery] = []
    lock.withLock {
      deliveries = sweepLocked()
      guard let row = rows.removeValue(forKey: token) else { return }
      // Revoke synchronously before any reply can reach the original renderer.
      if let approval = row.approval { _ = authority.cancel(approval) }
      else { _ = authority.cancel(row.request) }
      if sessionLiveLocked(row) { deliveries.append(denial(row)) }
    }
    dispatch(deliveries)
  }

  func dismiss(_ token: String) {
    var deliveries: [Delivery] = []
    lock.withLock {
      deliveries = sweepLocked()
      guard let row = rows[token], row.claimed, !row.nativeHandoffPending, sessionLiveLocked(row),
        let review = authority.currentReview(), review.request == row.request,
        authority.dismiss(row.request) else { return }
      rows.removeValue(forKey: token)
      deliveries.append(denial(row))
    }
    dispatch(deliveries)
  }

  func finish(_ token: String, response: String?) {
    Task { @MainActor [weak self] in self?.finishNow(token, response: response) }
  }

  @MainActor
  private func finishNow(_ token: String, response: String?) {
    var deliveries: [Delivery] = []
    var success: Delivery?
    lock.withLock {
      deliveries = sweepLocked()
      guard let row = rows[token] else { return }
      guard let response else {
        rows.removeValue(forKey: token)
        if let approval = row.approval { _ = authority.cancel(approval) }
        else { _ = authority.cancel(row.request) }
        if sessionLiveLocked(row) { deliveries.append(denial(row)) }
        return
      }
      guard validResponse(response, row: row), row.claimed, sessionLiveLocked(row),
        let approval = row.approval, authority.isApproved(approval), authority.finish(approval) else {
        rows.removeValue(forKey: token)
        if let approval = row.approval { _ = authority.cancel(approval) }
        else { _ = authority.cancel(row.request) }
        if sessionLiveLocked(row) { deliveries.append(denial(row)) }
        return
      }
      // Consume both row and native grant before dispatching the original reply.
      rows.removeValue(forKey: token)
      success = Delivery(reply: row.reply, response: response)
    }
    dispatch(deliveries)
    // The final live-grant check, consumption and successful reply share one main-actor turn.
    if let success { success.reply(success.response) }
  }

  func setFocused(_ generation: String, active: Bool) {
    var deliveries: [Delivery] = []
    lock.withLock {
      deliveries = sweepLocked()
      guard let session = sessions[generation] else { return }
      if active { _ = authority.setFocused(session) }
      else { _ = authority.clearFocused(session) }
      deliveries += sweepLocked()
    }
    dispatch(deliveries)
  }

  func setForeground(_ foreground: Bool) {
    var deliveries: [Delivery] = []
    lock.withLock {
      deliveries = sweepLocked()
      authority.setForeground(foreground)
      deliveries += sweepLocked()
    }
    dispatch(deliveries)
  }

  func resume() {
    var deliveries: [Delivery] = []
    lock.withLock {
      deliveries = sweepLocked()
      _ = authority.resumeReview()
      deliveries += sweepLocked()
    }
    dispatch(deliveries)
  }

  func revoke(_ generation: String) {
    lock.withLock {
      guard let session = sessions.removeValue(forKey: generation) else { return }
      _ = authority.teardown(session)
      for token in rows.filter({ $0.value.generation == generation }).keys { rows.removeValue(forKey: token) }
    }
  }

  func cancelAllSigningSources() {
    let deliveries: [Delivery] = lock.withLock {
      let deliveries = rows.values.filter { sessionLiveLocked($0) }.map { denial($0) }
      for row in rows.values {
        if let approval = row.approval { _ = authority.cancel(approval) } else { _ = authority.cancel(row.request) }
      }
      rows.removeAll(); return deliveries
    }
    dispatch(deliveries)
  }

  func sweep() {
    let deliveries = lock.withLock { sweepLocked() }
    dispatch(deliveries)
  }

  private func sweepLocked() -> [Delivery] {
    _ = authority.expire()
    var deliveries: [Delivery] = []
    let expired = rows.compactMap {
      authority.contains($0.value.request) && sessionLiveLocked($0.value) ? nil : $0.key
    }
    for token in expired {
      guard let row = rows.removeValue(forKey: token) else { continue }
      if sessionLiveLocked(row) { deliveries.append(denial(row)) }
    }
    return deliveries
  }

  private func sessionLiveLocked(_ row: Row) -> Bool {
    sessions[row.generation] == row.session && leases.sessionActive(row.generation)
  }

  private func denial(_ row: Row, error: String = "approval denied") -> Delivery {
    guard let id = row.wireId else { return Delivery(reply: row.reply, response: nil) }
    let value: [String: Any] = ["type": isOutbox(row) ? "outbox.publish.result" : "relay.publish.result", "id": id,
      "ok": false, "error": error]
    let data = try? JSONSerialization.data(withJSONObject: value)
    return Delivery(reply: row.reply, response: data.map { String(decoding: $0, as: UTF8.self) })
  }

  private func validResponse(_ response: String, row: Row) -> Bool {
    guard response.utf8.count <= CapabilityLeaseRegistry.maxBytes,
      let id = row.wireId, let data = response.data(using: .utf8),
      let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      value["type"] as? String == (isOutbox(row) ? "outbox.publish.result" : "relay.publish.result"), value["id"] as? String == id,
      value["ok"] is Bool else { return false }
    return true
  }

  private func dispatch(_ deliveries: [Delivery]) {
    for delivery in deliveries {
      Task { @MainActor in delivery.reply(delivery.response) }
    }
  }
}

enum ApprovalTransport {
  nonisolated static let registry = ApprovalTransportRegistry(leases: CapabilityTransport.leases)

  @MainActor static func register(_ generation: String) -> Bool {
    #if canImport(UIKit)
    ApprovalApplicationLifecycle.shared.install(registry)
    #endif
    return registry.register(generation)
  }
  static func admit(_ generation: String, snapshot: String, wireId: String?,
                    reply: @escaping ApprovalTransportRegistry.Reply) -> String? {
    registry.admit(generation, snapshot: snapshot, wireId: wireId, reply: reply)
  }
  static func take(_ token: String) -> String? { registry.take(token) }
  static func isLive(_ token: String) -> Bool { registry.isLive(token) }
  static func mayReview(_ token: String) -> Bool { registry.mayReview(token) }
  static func approve(_ token: String) -> Bool { registry.approve(token) }
  static func isApproved(_ token: String) -> Bool { registry.isApproved(token) }
  static func cancel(_ token: String) { registry.cancel(token) }
  static func dismiss(_ token: String) { registry.dismiss(token) }
  static func finish(_ token: String, response: String?) { registry.finish(token, response: response) }
  static func resume() { registry.resume() }
  static func setFocused(_ generation: String, active: Bool) { registry.setFocused(generation, active: active) }
  static func revoke(_ generation: String) { registry.revoke(generation) }
}

#if canImport(UIKit)
@MainActor
private final class ApprovalApplicationLifecycle {
  static let shared = ApprovalApplicationLifecycle()
  private weak var registry: ApprovalTransportRegistry?
  private var observers: [NSObjectProtocol] = []

  func install(_ registry: ApprovalTransportRegistry) {
    guard self.registry == nil else { return }
    self.registry = registry
    // Initial inactive/background construction leaves the core's unpaused empty state intact.
    // A real activation enables review; only a later background transition pauses it.
    if UIApplication.shared.applicationState == .active { registry.setForeground(true) }
    let center = NotificationCenter.default
    observers.append(center.addObserver(forName: UIApplication.willResignActiveNotification,
      object: nil, queue: .main) { [weak registry] _ in registry?.setForeground(false) })
    observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification,
      object: nil, queue: .main) { [weak registry] _ in registry?.setForeground(false) })
    observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification,
      object: nil, queue: .main) { [weak registry] _ in registry?.setForeground(true) })
  }

}
#endif
