import Foundation
import UIKit

/// App-only stream bridge with one unacknowledged RN frame per pinned native connection.
enum RelayStreamEvent: Sendable {
  case frame(String, UInt64, String)
  case failed(String)
  var payload: [String: Any] {
    switch self {
    case .frame(let id, let sequence, let text): return ["operationId": id, "sequence": sequence, "frame": text]
    case .failed(let id): return ["operationId": id, "failed": true]
    }
  }
}
final class RelayStreamBridgeOwner: @unchecked Sendable {
  static let shared = RelayStreamBridgeOwner()
  typealias Emit = @Sendable (RelayStreamEvent) -> Void
  private struct Row {
    let token: String
    let emit: Emit
    var operation: PublishedRelayWebSocketQuery.Operation?
    var sequence: UInt64 = 0
    var resume: (@Sendable () -> Void)?
    var acknowledged = false
  }
  private let lock = NSLock()
  private var rows: [String: Row] = [:]
  private var consumed: Set<String> = []
  private var foreground = false
  private var observers: [NSObjectProtocol] = []
  private init() {
    let center = NotificationCenter.default
    for name in [UIApplication.willResignActiveNotification, UIApplication.didEnterBackgroundNotification] {
      observers.append(center.addObserver(forName: name, object: nil, queue: nil) { [weak self] _ in self?.setForeground(false) })
    }
    observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: nil) { [weak self] _ in self?.setForeground(true) })
    Task { @MainActor [weak self] in self?.setForeground(UIApplication.shared.applicationState == .active) }
  }
  deinit { for observer in observers { NotificationCenter.default.removeObserver(observer) }; revokeAll() }
  func start(_ id: String, token: String, url: String, request: String, subId: String, emit: @escaping Emit) -> Bool {
    guard UUID(uuidString: id)?.uuidString.lowercased() == id,
      (1...64).contains(subId.utf8.count), request.utf8.count <= 16 * 1024,
      let value = try? JSONSerialization.jsonObject(with: Data(request.utf8)) as? [Any], value.count >= 3,
      value[0] as? String == "REQ", value[1] as? String == subId,
      value.dropFirst(2).allSatisfy({ $0 is [String: Any] }) else { return false }
    let admitted = lock.withLock { () -> Bool in
      guard foreground, !consumed.contains(id), consumed.count < 65_536, rows.count < 16, rows.values.filter({ $0.token == token }).count < RelaySubscriptionTransport.shared.registry.connectionLimit(token),
        RelaySubscriptionTransport.shared.registry.isActive(token) else { return false }
      consumed.insert(id); rows[id] = Row(token: token, emit: emit); return true
    }
    guard admitted else { return false }
    do {
      let operation = try PublishedRelayWebSocketQuery.stream(url, subscription: request, subscriptionId: subId,
        delivery: { [weak self] text, resume in self?.frame(id, text: text, resume: resume) },
        completion: { [weak self] _ in self?.failed(id) })
      let retained = lock.withLock { () -> Bool in
        guard rows[id] != nil else { return false }; rows[id]?.operation = operation; return true
      }
      if !retained { operation.cancel() }
      return retained
    } catch { failed(id); return false }
  }
  private func frame(_ id: String, text: String, resume: @escaping @Sendable () -> Void) {
    let delivery: (Emit, UInt64)? = lock.withLock {
      guard foreground, var row = rows[id], RelaySubscriptionTransport.shared.registry.isActive(row.token),
        row.resume == nil, row.sequence < 9_007_199_254_740_991 else { return nil }
      row.sequence += 1; row.resume = resume; row.acknowledged = false; rows[id] = row
      return (row.emit, row.sequence)
    }
    guard let delivery else { cancel(id); return }
    delivery.0(.frame(id, delivery.1, text))
    DispatchQueue.global().asyncAfter(deadline: .now() + 25) { [weak self] in
      guard let self else { return }
      let expired = self.lock.withLock { self.rows[id]?.sequence == delivery.1 && self.rows[id]?.resume != nil }
      if expired { self.failed(id) }
    }
  }
  func acknowledge(_ id: String, sequence: UInt64) {
    var invalid = false
    lock.withLock {
      guard let row = rows[id] else { return }
      if row.sequence != sequence || row.resume == nil || row.acknowledged { invalid = true; return }
      rows[id]?.acknowledged = true
    }
    if invalid { cancel(id) } else { pump(id) }
  }
  private func pump(_ id: String) {
    // Never hold the WSS lock while taking the renderer transport lock.
    guard let token = lock.withLock({ rows[id]?.token }), RelaySubscriptionTransport.shared.hasCapacity(token) else { return }
    let resume: (@Sendable () -> Void)? = lock.withLock {
      guard foreground, var row = rows[id], row.token == token, row.acknowledged else { return nil }
      let resume = row.resume; row.resume = nil; row.acknowledged = false; rows[id] = row; return resume
    }
    resume?()
  }
  func rendererAvailable(_ token: String) {
    let ids = lock.withLock { rows.filter { $0.value.token == token }.map(\.key) }
    for id in ids { pump(id) }
  }
  private func failed(_ id: String) {
    let row = lock.withLock { rows.removeValue(forKey: id) }
    row?.operation?.cancel()
    guard let row, lock.withLock({ foreground }), RelaySubscriptionTransport.shared.registry.isActive(row.token) else { return }
    row.emit(.failed(id))
  }
  func cancel(_ id: String) {
    let row = lock.withLock { () -> Row? in
      if consumed.count < 65_536, UUID(uuidString: id)?.uuidString.lowercased() == id { consumed.insert(id) }
      return rows.removeValue(forKey: id)
    }
    row?.operation?.cancel()
  }
  func cancelToken(_ token: String) {
    let ids = lock.withLock { rows.filter { $0.value.token == token }.map(\.key) }
    for id in ids { cancel(id) }
  }
  func setForeground(_ active: Bool) {
    lock.withLock { foreground = active }
    RelaySubscriptionTransport.shared.foreground(active)
    if !active { revokeAll() }
  }
  func revokeAll() {
    let all = lock.withLock { let all = Array(rows.values); rows.removeAll(); return all }
    for row in all { row.operation?.cancel() }
  }
}
